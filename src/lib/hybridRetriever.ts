/**
 * 混合检索：BM25 + 向量，Reciprocal Rank Fusion 合并
 *
 * 参数来自 scripts/eval/tune_hybrid.py（一个 100 回合的故事，44 个片段，88 道回忆题，
 * 按来源片段分组 4 折交叉验证 x25 选出调参策略，再在邻域平滑后选点）：
 *   - 向量一路用玩家原话：在两组题上都比用改写句更好，且不必等待意图翻译，可以与之并行
 *   - BM25 一路用"原话 + 改写句（含实体名）"，BM25 本身保持默认参数（调 k1 / b / IDF 公式没有交叉验证收益）
 *   - 不再使用实体过滤：平均 77% 的片段都能通过过滤，几乎筛不掉东西
 *   - k 在 1~100、BM25 权重在 3~10 区间内结果都很平稳，取平台中间的点
 * 交叉验证估计 MRR@10 ≈ 0.67（旧 tier search 0.49，纯 BM25 0.66），
 * 优势主要在换了说法的回忆问题上（Hit@5 0.64 → 0.84，样本内）。
 *
 * 注意：Okapi IDF 在语料只有 1~2 个片段时全部 <= 0，BM25 一路不会返回结果，此时完全由向量一路兜底；
 * 有 3 个片段起 BM25 正常工作。
 */
import { BM25, DEFAULT_BM25_PARAMS, tokenize } from "./bm25";
import { getEmbeddings, getPineconeIndex } from "./Init";
import { fromPineconeMetadata, IndexedMemory, loadIndexedMemories } from "./memoryStore";
import { QueryIntent } from "./query";

export const HYBRID_RETRIEVAL_CONFIG = {
    /** 每一路取多少条参与融合 */
    depth: 10,
    /** RRF 常数 */
    rrfK: 60,
    /** BM25 一路的权重（向量一路固定为 1） */
    bm25Weight: 4,
    /** 最终放进 prompt 的记忆条数 */
    topK: 10,
    bm25: DEFAULT_BM25_PARAMS,
};

export type DenseHit = { id: string; memory: IndexedMemory };

/**
 * 立即用玩家原话发起向量检索（不等意图翻译）。
 * 失败时返回 null 而不是 reject：调用方会先去做意图翻译，期间未处理的 rejection 会导致进程报错。
 */
export function startDenseSearch(rawInput: string, sessionId: string): Promise<DenseHit[] | null> {
    return (async () => {
        const vector = await getEmbeddings().embedQuery(rawInput);
        const res = await getPineconeIndex().namespace(sessionId).query({
            vector,
            topK: HYBRID_RETRIEVAL_CONFIG.depth,
            // 带上 metadata：Redis 副本缺失某条记录时用它兜底
            includeMetadata: true,
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

/** 加权 RRF：score(d) = Σ weight / (k + rank) */
export function reciprocalRankFusion(rankings: { ids: string[]; weight: number }[], k: number): string[] {
    const scores = new Map<string, number>();
    for (const { ids, weight } of rankings) {
        ids.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + weight / (k + i + 1)));
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/**
 * 按相关度排序的检索结果（评测脚本直接调用它计算 MRR / Hit@k）
 */
export async function rankMemories(params: {
    rawInput: string;
    intent: QueryIntent;
    dense: Promise<DenseHit[] | null>;
    sessionId: string;
}): Promise<IndexedMemory[]> {
    const { rawInput, intent, dense, sessionId } = params;
    const { depth, rrfK, bm25Weight, topK } = HYBRID_RETRIEVAL_CONFIG;

    const [denseHits, memoriesResult] = await Promise.all([
        dense,
        loadIndexedMemories(sessionId).catch(e => {
            console.error("[HybridRetriever] Failed to load memories for BM25, continuing with dense only:", e);
            return null;
        }),
    ]);
    const memories = memoriesResult ?? [];

    const queryTokens = [...tokenize(rawInput), ...tokenize(enhancedQuery(intent))];
    const bm25Ids = bm25Rank(memories, queryTokens, depth);
    const denseIds = (denseHits ?? []).map(h => h.id);

    const fused = reciprocalRankFusion([
        { ids: denseIds, weight: 1 },
        { ids: bm25Ids, weight: bm25Weight },
    ], rrfK).slice(0, topK);

    // 记录以 Redis 副本为准，缺失时（如刚写入 Pinecone、Redis 写入失败）用向量检索带回的 metadata 兜底
    const byId = new Map<string, IndexedMemory>(memories.map(m => [m.id, m]));
    for (const hit of denseHits ?? []) {
        if (!byId.has(hit.id)) byId.set(hit.id, hit.memory);
    }

    console.log(`[HybridRetriever] dense ${denseHits === null ? "failed" : denseIds.length}, bm25 ${bm25Ids.length}/${memories.length} chunks, fused ${fused.length}`);
    return fused.map(id => byId.get(id)).filter((m): m is IndexedMemory => Boolean(m));
}

/**
 * 线上检索入口：返回放进 prompt 的记忆（access_count 已 +1，由收尾阶段写回）
 */
export async function retrieveMemories(params: Parameters<typeof rankMemories>[0]): Promise<IndexedMemory[]> {
    const ranked = await rankMemories(params);
    return ranked
        .map(m => ({ ...m, access_count: (m.access_count || 0) + 1 }))
        // 按 turn 排序：最近发生的剧情（大的 turn）排在最前面，方便 LLM 追踪最新因果
        .sort((a, b) => (b.start_turn || 0) - (a.start_turn || 0));
}
