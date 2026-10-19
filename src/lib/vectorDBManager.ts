import { getEmbeddings, getPineconeIndex } from "./Init";
import { MemoryRecord } from "./memoryChunkGenerator";
import { deleteIndexedMemories, IndexedMemory, memoryContent, saveIndexedMemories, saveMemoryTexts, toIndexedMemory } from "./memoryStore";

/**
 * 将完整的记忆 Chunk 连带向量一起存入 Pinecone，并同步写入 Redis 副本（BM25 语料）
 */
export async function storeMemoryRecord(record: MemoryRecord, sessionId: string): Promise<void> {
    console.log(`[VectorDB] Storing memory Chunk [${sessionId}]: ${record.id}`);
    const embeddings = getEmbeddings();
    const index = getPineconeIndex().namespace(sessionId);

    // 仅将 dense_summary 转化为向量特征，避免过多废话干扰
    const vector = await embeddings.embedQuery(record.dense_summary);

    // Pinecone Metadata 必须是扁平的
    const metadata = {
        original_text: record.original_text,
        start_turn: record.start_turn,
        end_turn: record.end_turn,
        location: record.location,
        characters_involved: record.characters_involved,
        items_involved: record.items_involved,
        has_new_entity: record.has_new_entity,
        is_irreversible: record.is_irreversible,
        advances_plot: record.advances_plot,
        dense_summary: record.dense_summary,
        created_at: record.created_at,
        access_count: record.access_count
    };

    await index.upsert({
        records: [
            {
                id: record.id,
                values: vector,
                metadata: metadata as any
            }
        ]
    });
    console.log(`✅ [VectorDB] Memory stored successfully!`);

    // Redis 副本写入失败不抛错：片段已在 Pinecone 中，向量检索仍能召回它（并用其 metadata 兜底），
    // 若在这里抛错，归档重试会生成新 id 的重复片段
    await Promise.all([
        saveIndexedMemories(sessionId, [toIndexedMemory(record)]),
        saveMemoryTexts(sessionId, [{ id: record.id, text: memoryContent(record.original_text) }]),
    ]).catch(e => console.error(`[VectorDB] Failed to index memory ${record.id} in Redis:`, e));
}

/**
 * 删除某一整个宇宙的记忆 (Pinecone Namespace + Redis 副本)
 */
export async function deleteMemoryNamespace(sessionId: string): Promise<void> {
    await deleteIndexedMemories(sessionId).catch(e =>
        console.error(`[VectorDB] Failed to delete BM25 memories for ${sessionId}:`, e));
    try {
        const index = getPineconeIndex().namespace(sessionId);
        await index.deleteAll();
        console.log(`[VectorDB] Deleted entire memory namespace for: ${sessionId}`);
    } catch (e: any) {
        if (e.name === 'PineconeNotFoundError' || e.message?.includes('404')) {
            console.log(`[VectorDB] Namespace already empty or non-existent for: ${sessionId}`);
        } else {
            console.error(`[VectorDB] Failed to delete namespace (it may be a network timeout or outage) for ${sessionId}:`, e.message);
        }
    }
}

/**
 * 给被召回的记忆写回 +1 后的 access_count（Pinecone 与 Redis 副本都要更新，否则下次会用旧值覆盖）
 * （retrieveMemories 返回的记录里 access_count 已经是 +1 后的值）
 */
export async function bumpAccessCounts(records: IndexedMemory[], sessionId: string): Promise<void> {
    if (records.length === 0) return;
    const index = getPineconeIndex().namespace(sessionId);
    await Promise.all([
        ...records.map(record =>
            index.update({
                id: record.id,
                metadata: { access_count: record.access_count }
            })
        ),
        saveIndexedMemories(sessionId, records),
    ]);
}
