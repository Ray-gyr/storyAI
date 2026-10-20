/**
 * 基准测试 · 长摘要实验（只用开发故事）
 *
 * 线上摘要平均 55 词（原文平均 413 词），"摘要没写"的事实检索不到。这里换一个保留全部剧情事实的摘要提示词，
 * 用同一个辅助模型（gpt-4o-mini）重写每个片段的摘要，BM25 和向量两路都改用长摘要，与短摘要在同一批题上配对比较。
 *
 *   generate          生成长摘要 -> out/long_summaries/<sessionId>.json，
 *                     向量写入独立的 Pinecone 命名空间 <sessionId>-long（id、created_at 与原片段相同）
 *   retrieve <story>  在 out/<story>/retrieval.json 的每一行上补充 bm25_long / vector_long（前 30 名）
 *                     和 v2_long（同 v2 的配额合并，前 10 名）；复用该行已有的意图改写结果，保证配对
 *
 * 之后：label.ts <story> 只补标新候选；analyze 时比较 v2 与 v2_long。
 *
 * 运行：npx tsx --env-file=.env scripts/eval/benchmark/long_summaries.ts generate
 *       npx tsx --env-file=.env scripts/eval/benchmark/long_summaries.ts retrieve <dev|dev-hard>
 */
import { ChatOpenAI } from "@langchain/openai";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { tokenize } from "../../../src/lib/bm25";
import { bm25Rank, enhancedQuery, HYBRID_RETRIEVAL_CONFIG, quotaFusion, startDenseSearch } from "../../../src/lib/hybridRetriever";
import { getEmbeddings, getPineconeIndex } from "../../../src/lib/Init";
import { IndexedMemory } from "../../../src/lib/memoryStore";
import { BENCH_DIR, Chunk, loadJsonIfExists, loadQuestions, loadStory, mapLimit, readJson, RetrievalRow, wordCount, writeJson } from "./common";
import { STORIES } from "./stories";

const DEEP = 30;
const PROTAGONIST = STORIES.dev.protagonist;
const summaryPath = (sessionId: string) => join(BENCH_DIR, "out", "long_summaries", `${sessionId}.json`);
export const longNamespace = (sessionId: string) => `${sessionId}-long`;

const LONG_SUMMARY_SYSTEM = `You write the memory record for one segment of a text adventure. Later, the player may ask about any detail of this segment in a few words, and this record is what the search engine matches against.

Write a detailed summary of the [Content to Extract] part only (the overlap before it is context and is covered by another record):
- Keep EVERY story-relevant fact: what each person said, revealed, asked for, offered or refused (give the content, not just "they talked"); items gained, lost, used, bought or sold, with prices and quantities; decisions and their reasons; actions and their outcomes, including failures and blocked routes; clues, warnings, names, numbers, codes and places.
- Name people, places and objects explicitly (the protagonist is ${PROTAGONIST}); no pronouns without a clear referent. Keep the specific words the story uses for things (e.g. "pawnbroker", "manual catch", "coupling").
- Skip pure atmosphere, gestures and scenery unless they matter to the plot.
- Plain sentences in story order. Length scales with the content: usually 120-250 words.`;

const summarizer = new ChatOpenAI({ modelName: "gpt-4o-mini", temperature: 0, openAIApiKey: process.env.OPENAI_API_KEY })
    .withStructuredOutput(z.object({ summary: z.string() }));

async function generate() {
    const { sessionId, chunks } = loadStory("dev");
    const path = summaryPath(sessionId);
    mkdirSync(join(BENCH_DIR, "out", "long_summaries"), { recursive: true });
    const done = loadJsonIfExists<Record<string, string>>(path, {});
    const todo = chunks.filter(c => !done[c.id]);
    await mapLimit(todo, 8, async (c: Chunk) => {
        const { summary } = await summarizer.invoke([
            ["system", LONG_SUMMARY_SYSTEM],
            ["human", c.original_text],
        ]);
        done[c.id] = summary;
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
(cmd === "generate" ? generate() : cmd === "retrieve" && story ? retrieve(story) : Promise.reject(new Error("usage: long_summaries.ts generate | retrieve <story>")))
    .catch(e => { console.error(e); process.exit(1); });
