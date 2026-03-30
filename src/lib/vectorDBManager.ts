import { getEmbeddings, getPineconeIndex } from "./Init";
import { MemoryRecord } from "./memoryChunkGenerator";
import { QueryIntent } from "./query";

/**
 * 将完整的记忆 Chunk 连带向量一起存入 Pinecone
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
}

/**
 * 根据意图检索记忆
 * @param queryIntent 经意图翻译器解析出来的标准检索格式
 * @param sessionId 每个游戏的唯一会话 ID
 * @returns 命中并更新频率后的 Top 10 记忆块
 */
export async function retrieveMemories(queryIntent: QueryIntent, sessionId: string): Promise<MemoryRecord[]> {
    if (queryIntent.is_resolved_by_cache || !queryIntent.search_query) {
        console.log(`[VectorDB] Parallel route short-circuited: required knowledge already in cache/context, skipping network retrieval.`);
        return [];
    }

    // 根据需要，将识别出的实体名词用空格拼在原陈述句后面做“关键词加强”，这样更容易被向量高亮
    const queryParts = [queryIntent.search_query];
    if (queryIntent.characters_involved?.length) queryParts.push(...queryIntent.characters_involved);
    if (queryIntent.items_involved?.length) queryParts.push(...queryIntent.items_involved);
    if (queryIntent.locations_involved?.length) queryParts.push(...queryIntent.locations_involved);
    const enhancedQueryString = queryParts.join(" ");

    console.log(`[VectorDB] Performing network semantic retrieval (with entity enhancement) [${sessionId}]: ${enhancedQueryString}`);
    const embeddings = getEmbeddings();
    const index = getPineconeIndex().namespace(sessionId);

    // 1. 将增强型搜索字符串转化为向量
    const queryVector = await embeddings.embedQuery(enhancedQueryString);

    // 构建 metadata filter
    const filterConditions: any[] = [];
    if (queryIntent.characters_involved && queryIntent.characters_involved.length > 0) {
        filterConditions.push({ characters_involved: { $in: queryIntent.characters_involved } });
    }
    if (queryIntent.items_involved && queryIntent.items_involved.length > 0) {
        filterConditions.push({ items_involved: { $in: queryIntent.items_involved } });
    }
    if (queryIntent.locations_involved && queryIntent.locations_involved.length > 0) {
        filterConditions.push({ location: { $in: queryIntent.locations_involved } });
    }

    let filterObj: any = undefined;
    if (filterConditions.length > 0) {
        filterObj = { $or: filterConditions };
    }

    // 2. 并发检索：带 filter 的检索 vs 原始无 filter 的检索
    const queryPromises = [];

    // Promise 0: Filtered Query
    if (filterObj) {
        queryPromises.push(
            index.query({
                vector: queryVector,
                topK: 10,
                includeMetadata: true,
                filter: filterObj
            })
        );
    } else {
        queryPromises.push(Promise.resolve(null));
    }

    // Promise 1: Original Query
    queryPromises.push(
        index.query({
            vector: queryVector,
            topK: 10,
            includeMetadata: true
        })
    );

    const [filteredResponse, originalResponse] = await Promise.all(queryPromises);

    const finalMatches: any[] = [];
    const seenIds = new Set<string>();

    // 1) 先收集有 metadata 过滤的结果
    if (filteredResponse && filteredResponse.matches && filteredResponse.matches.length > 0) {
        for (const match of filteredResponse.matches) {
            finalMatches.push(match);
            seenIds.add(match.id);
        }
        console.log(`[VectorDB] Metadata filtered retrieved ${filteredResponse.matches.length} memories.`);
    }

    // 2) 如果不足 10 个，且存在原始无过滤的结果，则进行补充去重
    if (finalMatches.length < 10 && originalResponse && originalResponse.matches && originalResponse.matches.length > 0) {
        let addedCount = 0;
        for (const match of originalResponse.matches) {
            if (finalMatches.length >= 10) break; // 凑够 10 个就退出

            if (!seenIds.has(match.id)) {
                finalMatches.push(match);
                seenIds.add(match.id);
                addedCount++;
            }
        }
        if (addedCount > 0) {
            console.log(`[VectorDB] Fallback logic supplemented ${addedCount} memories from original search.`);
        }
    }

    if (finalMatches.length === 0) {
        console.log(`[VectorDB] No relevant memories found.`);
        return [];
    }

    const results: MemoryRecord[] = [];

    // 3. 解析结果
    for (const match of finalMatches) {
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

    // 4. 按 turn 排序：最近发生的剧情（大的 turn）排在最前面，方便 LLM 追踪最新因果
    results.sort((a, b) => (b.start_turn || 0) - (a.start_turn || 0));

    // 5. 批量执行部分更新，给这被召回的 10 条记忆涨 1 点 access_count
    // 使用 Promise.all 保证并发更新，不阻塞主流程太久
    Promise.all(results.map(record =>
        index.update({
            id: record.id,
            metadata: { access_count: record.access_count }
        })
    )).catch(err => {
        console.error(`[VectorDB] 更新使用频率失败:`, err);
    });

    return results;
}
