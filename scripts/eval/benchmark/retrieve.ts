/**
 * 基准测试 · 检索（PROTOCOL.md 第 2、5 节）
 *
 * 每道题在适用的快照上检索（early 题：100/200/300；late 题：300），只看快照时刻已有的片段。
 * 意图改写用该快照的世界状态 + 最近 3 轮对话，所有方法共用同一个改写结果。
 *   tier     v1：增强查询向量 + 实体过滤，不足 10 条用无过滤结果补齐（同 scripts/eval/rank_vectors.ts）
 *   bm25     BM25（原话 + 改写句），保留前 30 名
 *   vector   玩家原话的向量检索，保留前 30 名
 *   v2       线上 hybridRetriever.rankMemories（当前代码的配置），前 10 名
 *
 * 运行：npx tsx --env-file=.env scripts/eval/benchmark/retrieve.ts <dev|test>
 * 输出：out/<story>/retrieval.json
 */
import { join } from "node:path";
import { tokenize } from "../../../src/lib/bm25";
import { bm25Rank, enhancedQuery, HYBRID_RETRIEVAL_CONFIG, rankMemories, startDenseSearch } from "../../../src/lib/hybridRetriever";
import { getEmbeddings, getPineconeIndex } from "../../../src/lib/Init";
import { loadIndexedMemories } from "../../../src/lib/memoryStore";
import { QueryIntent, translateUserIntent } from "../../../src/lib/query";
import { BENCH_DIR, loadJsonIfExists, loadQuestions, loadStory, mapLimit, RetrievalRow, SNAPSHOTS, storyDir, writeJson } from "./common";

const STORY_NAME = process.argv[2];
const DEEP = 30;
const TOP_K = 10;

function entityConditions(intent: QueryIntent): object[] {
    const conditions: object[] = [];
    if (intent.characters_involved.length > 0) conditions.push({ characters_involved: { $in: intent.characters_involved } });
    if (intent.items_involved.length > 0) conditions.push({ items_involved: { $in: intent.items_involved } });
    if (intent.locations_involved.length > 0) conditions.push({ location: { $in: intent.locations_involved } });
    return conditions;
}

async function main() {
    const { sessionId, chunks, snapshots } = loadStory(STORY_NAME);
    // 跳过已被质量筛选（screening.json）或人工核对（manual_review.json）淘汰的题
    const screening = loadJsonIfExists<Record<string, { keep: boolean }>>(join(storyDir(STORY_NAME), "screening.json"), {});
    const manual = loadJsonIfExists<Record<string, Record<string, string>>>(join(BENCH_DIR, "manual_review.json"), {})[STORY_NAME] ?? {};
    const questions = loadQuestions(STORY_NAME).filter(q => screening[q.qid]?.keep !== false && !(q.qid in manual));
    const index = getPineconeIndex().namespace(sessionId);
    const allMemories = await loadIndexedMemories(sessionId);
    const createdAt = new Map(chunks.map(c => [c.id, c.created_at]));

    const jobs = questions.flatMap(q => SNAPSHOTS
        .filter(r => q.pool === "early" || r === 300)
        .filter(r => (createdAt.get(q.source_id) ?? Infinity) <= snapshots[r].taken_at)
        .map(r => ({ q, r })));
    console.log(`${questions.length} questions -> ${jobs.length} (question, snapshot) runs`);

    const rows: RetrievalRow[] = await mapLimit(jobs, 6, async ({ q, r }) => {
        const snap = snapshots[r];
        const before = snap.taken_at;
        const intent = await translateUserIntent(snap.currentState, snap.chatHistory.slice(-3), q.question);
        const memories = allMemories.filter(m => m.created_at <= before);

        // v1 tier search
        const vector = await getEmbeddings().embedQuery(enhancedQuery(intent) || q.question);
        const timeFilter = { created_at: { $lte: before } };
        const conditions = entityConditions(intent);
        const [filtered, unfiltered] = await Promise.all([
            conditions.length > 0
                ? index.query({ vector, topK: TOP_K, filter: { $and: [timeFilter, { $or: conditions }] } })
                : Promise.resolve(null),
            index.query({ vector, topK: TOP_K, filter: timeFilter }),
        ]);
        const seen = new Set<string>();
        const tier = [...(filtered?.matches ?? []), ...(unfiltered.matches ?? [])]
            .map(m => m.id).filter(id => !seen.has(id) && seen.add(id)).slice(0, TOP_K);

        // BM25 / 向量（深列表）
        const bm25 = bm25Rank(memories, [...tokenize(q.question), ...tokenize(enhancedQuery(intent))], DEEP);
        const vectorHits = await startDenseSearch(q.question, sessionId, { depth: DEEP, createdBefore: before });

        // v2：线上检索代码
        const v2 = await rankMemories({
            rawInput: q.question,
            intent,
            dense: startDenseSearch(q.question, sessionId, { createdBefore: before }),
            sessionId,
            createdBefore: before,
        });

        return {
            qid: q.qid,
            snapshot: r,
            intent,
            rankings: {
                tier,
                bm25,
                vector: (vectorHits ?? []).map(h => h.id),
                v2: v2.map(m => m.id),
            },
        };
    });

    writeJson(join(loadStory(STORY_NAME).dir, "retrieval.json"), { story: STORY_NAME, v2_config: HYBRID_RETRIEVAL_CONFIG, rows });
    console.log(`saved ${rows.length} retrieval rows`);
}

main().catch(e => { console.error(e); process.exit(1); });
