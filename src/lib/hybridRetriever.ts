/**
 * 混合检索：BM25 + 向量，按配额合并
 *
 * 合并方式：先取 BM25 前 BM25_QUOTA 名，再按向量检索的排序补满 topK 个；向量结果不足时用 BM25 剩余的补。
 * 写作模型拿到的是这 topK 个片段组成的集合（再按轮次排序），所以优化目标是 Recall@10，而不是排序指标。
 *
 * 来源：scripts/eval/benchmark/tune_recall.py（PROTOCOL.md 第 7 节）。数据为 300 回合的开发故事
 * （130 个片段，88 道回忆题 x 3 个快照）+ 100 回合的试点故事（88 道题），按来源片段分组 4 折交叉验证 x25：
 *   原 RRF（k 60、BM25 权重 4）0.944，纯 BM25 0.941，纯向量 0.925，配额法 0.954，RRF 网格 0.958（3 个参数）。
 *   按"与最佳相差 0.01 以内选参数最少"的规则选配额法；配额 3~5 的结果都在 0.954~0.958 之间。
 * 原 RRF 的问题：BM25 权重 4 时，BM25 前 10 名的分数下限 4/70 高于只被向量召回的片段的上限 1/61，
 * 候选集合完全由 BM25 决定，向量一路只改变顺序；而故事变长后，向量检索的召回率下降得比 BM25 慢。
 *
 * 其他沿用 v2 的选择（scripts/eval/tune_hybrid.py 的试点实验）：
 *   - 向量一路用玩家原话：不必等待意图翻译，可以与之并行
 *   - BM25 一路用"原话 + 改写句（含实体名）"，BM25 保持默认参数
 *   - 不使用实体过滤：平均 77% 的片段都能通过过滤，几乎筛不掉东西
 *
 * 注意：Okapi IDF 在语料只有 1~2 个片段时全部 <= 0，BM25 一路不会返回结果，此时完全由向量一路兜底。
 */
import { BM25, DEFAULT_BM25_PARAMS, tokenize } from "./bm25";
import { getEmbeddings, getPineconeIndex } from "./Init";
import { fromPineconeMetadata, IndexedMemory, loadIndexedMemories, loadMemoryTexts } from "./memoryStore";
import { QueryIntent } from "./query";

export const HYBRID_RETRIEVAL_CONFIG = {
    /** 先从 BM25 取多少个 */
    bm25Quota: 3,
    /** BM25 一路取多少条（配额之外的部分只在向量结果不足时用于补位） */
    bm25Depth: 10,
    /** 向量一路取多少条（要比 topK 多：与 BM25 配额重复的片段需要往后补位） */
    denseDepth: 20,
    /** 最终放进 prompt 的记忆条数 */
    topK: 10,
    /** 排名前几的记忆附上片段原文给写作模型（0 = 只给摘要） */
    originalTextFor: 3,
    bm25: DEFAULT_BM25_PARAMS,
};

export type DenseHit = { id: string; memory: IndexedMemory };

/**
 * 立即用玩家原话发起向量检索（不等意图翻译）。
 * 失败时返回 null 而不是 reject：调用方会先去做意图翻译，期间未处理的 rejection 会导致进程报错。
 */
export function startDenseSearch(
    rawInput: string,
    sessionId: string,
    options: { depth?: number; createdBefore?: number } = {}
): Promise<DenseHit[] | null> {
    return (async () => {
        const vector = await getEmbeddings().embedQuery(rawInput);
        const res = await getPineconeIndex().namespace(sessionId).query({
            vector,
            topK: options.depth ?? HYBRID_RETRIEVAL_CONFIG.denseDepth,
            // 带上 metadata：Redis 副本缺失某条记录时用它兜底
            includeMetadata: true,
            // 仅评测使用：还原某个历史时刻已有的片段（线上不传）
            ...(options.createdBefore !== undefined ? { filter: { created_at: { $lte: options.createdBefore } } } : {}),
        });
        return (res.matches ?? []).map(m => ({
            id: m.id,
            memory: fromPineconeMetadata(m.id, (m.metadata ?? {}) as Record<string, unknown>),
        }));
    })().catch(e => {
        console.error("[HybridRetriever] Dense search failed, continuing with BM25 only:", e);
        return null;
    });
}

/** 改写句 + 实体名：与旧版 tier search 的"增强查询"相同 */
export function enhancedQuery(intent: QueryIntent): string {
    return [intent.search_query, ...intent.characters_involved, ...intent.items_involved, ...intent.locations_involved]
        .filter(Boolean)
        .join(" ");
}

/** BM25 排名：只保留得分大于 0 的片段 */
export function bm25Rank(memories: IndexedMemory[], queryTokens: string[], depth: number): string[] {
    if (memories.length === 0 || queryTokens.length === 0) return [];
    const scores = new BM25(memories.map(m => tokenize(m.dense_summary)), HYBRID_RETRIEVAL_CONFIG.bm25).scores(queryTokens);
    return scores
        .map((score, i) => ({ id: memories[i].id, score }))
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, depth)
        .map(s => s.id);
}

/** 配额合并：BM25 前 quota 名 + 向量排序补满 topK；向量不足时用 BM25 剩余部分补 */
export function quotaFusion(bm25Ids: string[], denseIds: string[], quota: number, topK: number): string[] {
    const picked = bm25Ids.slice(0, quota);
    for (const id of [...denseIds, ...bm25Ids.slice(quota)]) {
        if (picked.length >= topK) break;
        if (!picked.includes(id)) picked.push(id);
    }
    return picked;
}

/**
 * 按相关度排序的检索结果（评测脚本直接调用它计算 MRR / Hit@k）
 */
export async function rankMemories(params: {
    rawInput: string;
    intent: QueryIntent;
    dense: Promise<DenseHit[] | null>;
    sessionId: string;
    /** 仅评测使用：只检索在此时间戳之前创建的片段（dense 也需用同一个值发起） */
    createdBefore?: number;
}): Promise<IndexedMemory[]> {
    const { rawInput, intent, dense, sessionId, createdBefore } = params;
    const { bm25Quota, bm25Depth, topK } = HYBRID_RETRIEVAL_CONFIG;

    const [denseHits, memoriesResult] = await Promise.all([
        dense,
        loadIndexedMemories(sessionId).catch(e => {
            console.error("[HybridRetriever] Failed to load memories for BM25, continuing with dense only:", e);
            return null;
        }),
    ]);
    const memories = (memoriesResult ?? []).filter(m => createdBefore === undefined || m.created_at <= createdBefore);

    const queryTokens = [...tokenize(rawInput), ...tokenize(enhancedQuery(intent))];
    const bm25Ids = bm25Rank(memories, queryTokens, bm25Depth);
    const denseIds = (denseHits ?? []).map(h => h.id);

    const fused = quotaFusion(bm25Ids, denseIds, bm25Quota, topK);

    // 记录以 Redis 副本为准，缺失时（如刚写入 Pinecone、Redis 写入失败）用向量检索带回的 metadata 兜底
    const byId = new Map<string, IndexedMemory>(memories.map(m => [m.id, m]));
    for (const hit of denseHits ?? []) {
        if (!byId.has(hit.id)) byId.set(hit.id, hit.memory);
    }

    console.log(`[HybridRetriever] dense ${denseHits === null ? "failed" : denseIds.length}, bm25 ${bm25Ids.length}/${memories.length} chunks, fused ${fused.length}`);
    return fused.map(id => byId.get(id)).filter((m): m is IndexedMemory => Boolean(m));
}

/** 交给写作模型的记忆：检索排名，以及（排名靠前的）片段原文 */
export type RetrievedMemory = IndexedMemory & { rank: number; content?: string };

/**
 * 线上检索入口：返回放进 prompt 的记忆（access_count 已 +1，由收尾阶段写回）。
 * 排名前 originalTextFor 个附上片段原文（摘要会丢细节）；按发生顺序（从早到晚）排列，便于回答"第一次……"。
 */
export async function retrieveMemories(
    params: Parameters<typeof rankMemories>[0] & { originalTextFor?: number }
): Promise<RetrievedMemory[]> {
    const ranked = await rankMemories(params);
    const k = params.originalTextFor ?? HYBRID_RETRIEVAL_CONFIG.originalTextFor;
    const texts = k > 0
        ? await loadMemoryTexts(params.sessionId, ranked.slice(0, k).map(m => m.id)).catch(e => {
            console.error("[HybridRetriever] Failed to load original texts, using summaries only:", e);
            return new Map<string, string>();
        })
        : new Map<string, string>();
    return ranked
        .map((m, i) => ({ ...m, access_count: (m.access_count || 0) + 1, rank: i + 1, content: texts.get(m.id) }))
        .sort((a, b) => (a.start_turn || 0) - (b.start_turn || 0));
}
