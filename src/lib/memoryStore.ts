/**
 * 记忆片段的 Redis 副本：BM25 检索的语料
 *
 * Pinecone 只能做向量检索，BM25 需要拿到全部片段的文本在内存里打分。
 * 每个存档的片段存成一个 Redis Hash（片段 id -> 记录），写入 Pinecone 时同步写入。
 * 不存 original_text（BM25 只用 dense_summary），控制每回合读取的数据量；原文另存在 memory_text:<id> 中，见下方。
 *
 * 引入 BM25 之前创建的存档在 Redis 里没有副本：第一次读取时从 Pinecone 一次性补齐，
 * 并写入哨兵字段 BACKFILLED，之后不再访问 Pinecone 的列表接口。
 */
import { getPineconeIndex } from "./Init";
import { MemoryRecord } from "./memoryChunkGenerator";
import { redis } from "./redis";

/** 检索链路使用的记忆记录（不含原文） */
export type IndexedMemory = Omit<MemoryRecord, "original_text">;

const BACKFILLED = "__backfilled";
const memoriesKey = (sessionId: string) => `memories:${sessionId}`;

export function toIndexedMemory(record: MemoryRecord | (IndexedMemory & { original_text?: string })): IndexedMemory {
    const { original_text: _omit, ...rest } = record as MemoryRecord;
    return rest;
}

/** 由 Pinecone metadata 还原记录 */
export function fromPineconeMetadata(id: string, meta: Record<string, unknown>): IndexedMemory {
    return {
        id,
        start_turn: Number(meta.start_turn),
        end_turn: Number(meta.end_turn),
        location: String(meta.location ?? ""),
        characters_involved: (meta.characters_involved as string[]) ?? [],
        items_involved: (meta.items_involved as string[]) ?? [],
        has_new_entity: Boolean(meta.has_new_entity),
        is_irreversible: Boolean(meta.is_irreversible),
        advances_plot: Boolean(meta.advances_plot),
        dense_summary: String(meta.dense_summary ?? ""),
        created_at: Number(meta.created_at),
        access_count: Number(meta.access_count ?? 0),
    };
}

/** 只保留 IndexedMemory 的字段（检索阶段附加的 rank / content 等不写回 Redis） */
function pickIndexedFields(m: IndexedMemory): IndexedMemory {
    return {
        id: m.id,
        start_turn: m.start_turn,
        end_turn: m.end_turn,
        location: m.location,
        characters_involved: m.characters_involved,
        items_involved: m.items_involved,
        has_new_entity: m.has_new_entity,
        is_irreversible: m.is_irreversible,
        advances_plot: m.advances_plot,
        dense_summary: m.dense_summary,
        created_at: m.created_at,
        access_count: m.access_count,
    };
}

export async function saveIndexedMemories(sessionId: string, memories: IndexedMemory[]): Promise<void> {
    if (memories.length === 0) return;
    await redis.hset(memoriesKey(sessionId), Object.fromEntries(memories.map(m => [m.id, pickIndexedFields(m)])));
}

export async function deleteIndexedMemories(sessionId: string): Promise<void> {
    await redis.del(memoriesKey(sessionId), memoryTextKey(sessionId));
}

// ==========================================
// 片段原文：交给写作模型，补回摘要里丢掉的细节
// 单独存一个 Hash（片段 id -> 正文），检索后只按入选的 id 读取，不随 BM25 语料每回合整体读出
// ==========================================

const memoryTextKey = (sessionId: string) => `memory_text:${sessionId}`;

/**
 * 片段原文的正文：去掉与上一片段重叠的上下文，轮次标记改写为 Player / Narrator
 */
export function memoryContent(originalText: string): string {
    let text = originalText || "";
    if (text.includes("[Content to Extract]")) text = text.split("[Content to Extract]")[1];
    return text
        .replace(/\[Turn \d+\] USER:\s*/g, "Player: ")
        .replace(/\[Turn \d+\] (ASSISTANT|SYSTEM):\s*/g, "Narrator: ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

export async function saveMemoryTexts(sessionId: string, entries: { id: string; text: string }[]): Promise<void> {
    if (entries.length === 0) return;
    await redis.hset(memoryTextKey(sessionId), Object.fromEntries(entries.map(e => [e.id, e.text])));
}

/**
 * 按 id 读取片段正文；Redis 里没有的（引入原文之前写入的片段）从 Pinecone metadata 补齐并回写
 */
export async function loadMemoryTexts(sessionId: string, ids: string[]): Promise<Map<string, string>> {
    const texts = new Map<string, string>();
    if (ids.length === 0) return texts;
    const stored = await redis.hmget<Record<string, string>>(memoryTextKey(sessionId), ...ids);
    for (const id of ids) {
        const text = stored?.[id];
        if (typeof text === "string" && text) texts.set(id, text);
    }

    const missing = ids.filter(id => !texts.has(id));
    if (missing.length > 0) {
        const res = await getPineconeIndex().namespace(sessionId).fetch({ ids: missing });
        const backfill: { id: string; text: string }[] = [];
        for (const [id, record] of Object.entries(res.records ?? {})) {
            const original = (record.metadata as Record<string, unknown> | undefined)?.original_text;
            if (typeof original === "string" && original) {
                const text = memoryContent(original);
                texts.set(id, text);
                backfill.push({ id, text });
            }
        }
        await saveMemoryTexts(sessionId, backfill);
    }
    return texts;
}

/** 从 Pinecone 拉取该存档的全部片段 */
async function listPineconeMemories(sessionId: string): Promise<IndexedMemory[]> {
    const index = getPineconeIndex().namespace(sessionId);
    const ids: string[] = [];
    let paginationToken: string | undefined;
    do {
        const page = await index.listPaginated({ limit: 100, paginationToken });
        ids.push(...(page.vectors ?? []).map(v => v.id).filter((id): id is string => Boolean(id)));
        paginationToken = page.pagination?.next;
    } while (paginationToken);

    const memories: IndexedMemory[] = [];
    for (let i = 0; i < ids.length; i += 100) {
        const res = await index.fetch({ ids: ids.slice(i, i + 100) });
        for (const [id, record] of Object.entries(res.records ?? {})) {
            memories.push(fromPineconeMetadata(id, (record.metadata ?? {}) as Record<string, unknown>));
        }
    }
    return memories;
}

/**
 * 读取该存档的全部记忆片段（必要时先从 Pinecone 补齐）
 */
export async function loadIndexedMemories(sessionId: string): Promise<IndexedMemory[]> {
    const stored = await redis.hgetall<Record<string, IndexedMemory | number>>(memoriesKey(sessionId));
    if (stored && BACKFILLED in stored) {
        return Object.entries(stored)
            .filter(([field]) => field !== BACKFILLED)
            .map(([, memory]) => memory as IndexedMemory);
    }

    // 旧存档：补齐一次。与 Redis 里已有的记录合并（同 id 覆盖，内容相同）
    const fromPinecone = await listPineconeMemories(sessionId);
    const merged = new Map<string, IndexedMemory>(fromPinecone.map(m => [m.id, m]));
    for (const [field, memory] of Object.entries(stored ?? {})) {
        if (field !== BACKFILLED) merged.set(field, memory as IndexedMemory);
    }
    await redis.hset(memoriesKey(sessionId), { ...Object.fromEntries(merged), [BACKFILLED]: 1 });
    console.log(`[MemoryStore] Backfilled ${merged.size} memories from Pinecone for ${sessionId}`);
    return [...merged.values()];
}
