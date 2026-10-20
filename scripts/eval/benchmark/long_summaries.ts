/**
 * 基准测试 · 长摘要
 *
 * 原摘要平均 55 词（原文平均 413 词），"摘要没写"的事实检索不到。记忆提取提示词（prompt.ts 规则 5）改为保留全部剧情事实的
 * 长摘要后，用线上的提取函数（gpt-4o-mini）重新生成每个片段的摘要，BM25 和向量两路都用长摘要，与原摘要在同一批题上配对比较。
 * （第一轮实验用的是独立的摘要提示词，结果见 commit 26422ae 与 RESULTS.md。）
 *
 *   generate <story>  生成长摘要 -> out/long_summaries/<sessionId>.json，
 *                     向量写入独立的 Pinecone 命名空间 <sessionId>-long（id、created_at 与原片段相同）
 *   retrieve <story>  在 out/<story>/retrieval.json 的每一行上补充 bm25_long / vector_long（前 30 名）
 *                     和 v2_long（同 v2 的配额合并，前 10 名）；复用该行已有的意图改写结果，保证配对
 *
 * 之后：label.ts <story> 只补标新候选；analyze 时比较 v2 与 v2_long。
 *
 * 运行：npx tsx --env-file=.env scripts/eval/benchmark/long_summaries.ts generate <dev|test>
 *       npx tsx --env-file=.env scripts/eval/benchmark/long_summaries.ts retrieve <dev|dev-hard>
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tokenize } from "../../../src/lib/bm25";
import { bm25Rank, enhancedQuery, HYBRID_RETRIEVAL_CONFIG, quotaFusion, startDenseSearch } from "../../../src/lib/hybridRetriever";
import { getEmbeddings, getPineconeIndex } from "../../../src/lib/Init";
import { StoryState } from "../../../src/lib/currentState";
import { extractAndStoreMemory } from "../../../src/lib/memoryChunkGenerator";
import { IndexedMemory } from "../../../src/lib/memoryStore";
import { BENCH_DIR, Chunk, loadJsonIfExists, loadQuestions, loadStory, mapLimit, readJson, RetrievalRow, wordCount, writeJson } from "./common";

const DEEP = 30;
const summaryPath = (sessionId: string) => join(BENCH_DIR, "out", "long_summaries", `${sessionId}.json`);
export const longNamespace = (sessionId: string) => `${sessionId}-long`;

/**
 * 片段生成时的世界状态没有保存：用第 300 回合快照里的实体，只保留截至该片段最后一回合已在对话里出现过的名字，
 * 还原"当时已知的实体"（线上提取只用到实体名）。
 */
function stateAt(final: StoryState, transcript: { turn_id: number; text: string }[], endTurn: number): StoryState {
    const seen = transcript.filter(t => t.turn_id <= endTurn).map(t => t.text).join("\n").toLowerCase();
    const known = <T extends { name: string }>(list: T[]) => list.filter(e => seen.includes(e.name.toLowerCase()));
    return { ...final, known_characters: known(final.known_characters), known_locations: known(final.known_locations), known_items: known(final.known_items) };
}

async function generate(story: string) {
    const { dir, sessionId, chunks, snapshots } = loadStory(story);
    const transcript = readJson<{ turn_id: number; text: string }[]>(join(dir, "transcript.json"));
    const path = summaryPath(sessionId);
    mkdirSync(join(BENCH_DIR, "out", "long_summaries"), { recursive: true });
    const done = loadJsonIfExists<Record<string, string>>(path, {});
    const todo = chunks.filter(c => !done[c.id]);
    await mapLimit(todo, 8, async (c: Chunk) => {
        // 线上的记忆提取（同一次调用产出实体与摘要；这里只取摘要）
        const record = await extractAndStoreMemory(stateAt(snapshots[300].currentState, transcript, c.end_turn), c.original_text, c.start_turn, c.end_turn);
        done[c.id] = record.dense_summary;
    });
    writeJson(path, done);
    const words = chunks.map(c => wordCount(done[c.id]));
    console.log(`long summaries: ${chunks.length} (new ${todo.length}), avg ${(words.reduce((a, b) => a + b, 0) / words.length).toFixed(0)} words, max ${Math.max(...words)}`);

    // 向量写入独立命名空间：先清空，避免残留
    const index = getPineconeIndex().namespace(longNamespace(sessionId));
    await index.deleteAll().catch(() => { /* 命名空间不存在 */ });
    const vectors = await getEmbeddings().embedDocuments(chunks.map(c => done[c.id]));
    for (let i = 0; i < chunks.length; i += 50) {
        await index.upsert({
            records: chunks.slice(i, i + 50).map((c, j) => ({
                id: c.id,
                values: vectors[i + j],
                metadata: { created_at: c.created_at, start_turn: c.start_turn, end_turn: c.end_turn, dense_summary: done[c.id] },
            })),
        });
    }
    console.log(`upserted ${chunks.length} vectors into namespace ${longNamespace(sessionId)}`);
}

async function retrieve(story: string) {
    const { dir, sessionId, chunks, snapshots } = loadStory(story);
    const summaries = readJson<Record<string, string>>(summaryPath(sessionId));
    const longMemories = chunks.map(c => ({ id: c.id, created_at: c.created_at, dense_summary: summaries[c.id] }) as IndexedMemory);
    const retrieval = readJson<{ story: string; v2_config: unknown; rows: RetrievalRow[] }>(join(dir, "retrieval.json"));
    const questions = new Map(loadQuestions(story).map(q => [q.qid, q]));
    const { bm25Quota, bm25Depth, denseDepth, topK } = HYBRID_RETRIEVAL_CONFIG;

    await mapLimit(retrieval.rows, 8, async row => {
        const question = questions.get(row.qid)!.question;
        const before = snapshots[row.snapshot as 100 | 200 | 300].taken_at;
        const memories = longMemories.filter(m => m.created_at <= before);
        const tokens = [...tokenize(question), ...tokenize(enhancedQuery(row.intent))];
        const dense = (await startDenseSearch(question, longNamespace(sessionId), { depth: DEEP, createdBefore: before })) ?? [];
        const bm25 = bm25Rank(memories, tokens, DEEP);
        row.rankings.bm25_long = bm25;
        row.rankings.vector_long = dense.map(h => h.id);
        row.rankings.v2_long = quotaFusion(bm25.slice(0, bm25Depth), dense.slice(0, denseDepth).map(h => h.id), bm25Quota, topK);
    });
    writeJson(join(dir, "retrieval.json"), retrieval);
    console.log(`${story}: added long-summary rankings to ${retrieval.rows.length} rows`);
}

const [cmd, story] = process.argv.slice(2);
(cmd === "generate" && story ? generate(story) : cmd === "retrieve" && story ? retrieve(story) : Promise.reject(new Error("usage: long_summaries.ts generate|retrieve <story>")))
    .catch(e => { console.error(e); process.exit(1); });
