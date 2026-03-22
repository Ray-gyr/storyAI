import { getEmbeddings, getPineconeIndex } from "./Init";
import { MemoryRecord } from "./memoryChunkGenerator";
import { QueryIntent } from "./query";

/**
 * 将完整的记忆 Chunk 连带向量一起存入 Pinecone
 */
export async function storeMemoryRecord(record: MemoryRecord, sessionId: string): Promise<void> {
    console.log(`[VectorDB] 正在入库记忆 Chunk [${sessionId}]: ${record.id}`);
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
    console.log(`✅ [VectorDB] 记忆入库成功!`);
}

/**
 * 根据意图检索记忆
 * @param queryIntent 经意图翻译器解析出来的标准检索格式
 * @param sessionId 每个游戏的唯一会话 ID
 * @returns 命中并更新频率后的 Top 10 记忆块
 */
export async function retrieveMemories(queryIntent: QueryIntent, sessionId: string): Promise<MemoryRecord[]> {
    if (queryIntent.is_resolved_by_cache || !queryIntent.search_query) {
        console.log(`[VectorDB] 并行路由截断：所需知识已包含在当前缓存/上下文中 (is_resolved_by_cache=true)，智能阻止了本次无效的网络检索开销！`);
        return [];
    }

    // 根据需要，将识别出的实体名词用空格拼在原陈述句后面做“关键词加强”，这样更容易被向量高亮
    const queryParts = [queryIntent.search_query];
    if (queryIntent.characters_involved?.length) queryParts.push(...queryIntent.characters_involved);
    if (queryIntent.items_involved?.length) queryParts.push(...queryIntent.items_involved);
    if (queryIntent.locations_involved?.length) queryParts.push(...queryIntent.locations_involved);
    const enhancedQueryString = queryParts.join(" ");

    console.log(`[VectorDB] 正在网络语义检索 (包含实体加强) [${sessionId}]: ${enhancedQueryString}`);
    const embeddings = getEmbeddings();
    const index = getPineconeIndex().namespace(sessionId);

    // 1. 将增强型搜索字符串转化为向量
    const queryVector = await embeddings.embedQuery(enhancedQueryString);

    // 2. Pinecone 直接检索 Top 10 (根据需求跳过细筛，直接取 top 10)
    const queryResponse = await index.query({
        vector: queryVector,
        topK: 10,
        includeMetadata: true
    });

    if (!queryResponse.matches || queryResponse.matches.length === 0) {
        console.log(`[VectorDB] 未找相关记忆。`);
        return [];
    }

    const results: MemoryRecord[] = [];

    // 3. 解析结果
    for (const match of queryResponse.matches) {
        const meta = match.metadata as any;
        if (!meta) continue;

        const updatedAccessCount = (meta.access_count || 0) + 1;

        // 还原回我们系统内的 MemoryRecord
        const record: MemoryRecord = {
            id: match.id,
            original_text: meta.original_text,
            start_turn: meta.start_turn,
            end_turn: meta.end_turn,
            location: meta.location,
            characters_involved: meta.characters_involved || [],
            items_involved: meta.items_involved || [],
            has_new_entity: meta.has_new_entity,
            is_irreversible: meta.is_irreversible,
            advances_plot: meta.advances_plot,
            dense_summary: meta.dense_summary,
            created_at: meta.created_at,
            access_count: updatedAccessCount
        };

        results.push(record);
    }

    // 批量执行部分更新，给这被召回的 10 条记忆涨 1 点 access_count
    // 使用 Promise.all 保证并发更新，不阻塞主流程太久
    await Promise.all(results.map(record => 
        index.update({
            id: record.id,
            metadata: { access_count: record.access_count }
        })
    ));

    console.log(`✅ [VectorDB] 检索并更新使用频率完成，共返回 ${results.length} 条记忆。`);
    return results;
}
