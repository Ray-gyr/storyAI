/**
 * 基准测试 · 端到端检查（PROTOCOL.md 第 8 节）
 *
 * 在第 300 回合快照上，用快照时的上下文（世界状态、滑动窗口、待归档区）、线上写作 prompt 与线上检索，
 * 让故事模型回答每道有效题；裁判对照参考段落（来源片段原文）判定 correct / contradicts / absent。
 *
 * --originals N：排名前 N 的记忆附上片段原文（不传则用线上配置 HYBRID_RETRIEVAL_CONFIG.originalTextFor）
 * --long：长摘要实验（long_summaries.ts）。记忆取 retrieval.json 中 v2_long 在该快照的排序（同一改写结果），
 *         摘要换成长摘要，原文与线上相同（memoryContent）
 *
 * 运行：npx tsx --env-file=.env scripts/eval/benchmark/e2e.ts <dev|test> [--originals N] [--long] [--tag name]
 * 输出：out/<story>/e2e_<tag>.json（v2 冻结时的结果为 e2e.json）
 */
import { StringOutputParser } from "@langchain/core/output_parsers";
import { join } from "node:path";
import { HYBRID_RETRIEVAL_CONFIG, RetrievedMemory, retrieveMemories, startDenseSearch } from "../../../src/lib/hybridRetriever";
import { memoryContent, toIndexedMemory } from "../../../src/lib/memoryStore";
import { getStoryLLM } from "../../../src/lib/Init";
import { storyWorkerPrompt } from "../../../src/lib/prompt";
import { writerPromptInputs } from "../../../src/lib/storyGenerator";
import { judgeAnswer, JUDGE_VERSION, tallyVerdicts } from "./judge";
import { BENCH_DIR, chunkContent, loadJsonIfExists, loadQuestions, loadStory, mapLimit, readJson, RetrievalRow, writeJson } from "./common";

const STORY_NAME = process.argv[2];
const SNAPSHOT = 300;
const argValue = (flag: string) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined; };
const ORIGINALS = argValue("--originals") !== undefined ? Number(argValue("--originals")) : HYBRID_RETRIEVAL_CONFIG.originalTextFor;
const LONG = process.argv.includes("--long");
const TAG = argValue("--tag") ?? `originals${ORIGINALS}${LONG ? "_long" : ""}`;

async function main() {
    const { dir, sessionId, chunks, snapshots } = loadStory(STORY_NAME);
    const snap = snapshots[SNAPSHOT];
    const questions = loadQuestions(STORY_NAME);
    const labels = readJson<{ candidates: Record<string, Record<string, { acceptable: boolean }>> }>(join(dir, "labels.json"));
    const { rows } = readJson<{ rows: RetrievalRow[] }>(join(dir, "retrieval.json"));
    const byId = new Map(chunks.map(c => [c.id, c]));
    // 有效题：有 validation.json（question set 2）时以它为准，否则只要求来源片段能回答
    const validation = loadJsonIfExists<Record<string, { valid: boolean }> | null>(join(dir, "validation.json"), null);
    const valid = questions.filter(q => validation ? validation[q.qid]?.valid : labels.candidates[q.qid][q.source_id].acceptable);
    // 裁判的对照：所有可接受片段（来源片段排在最前），而不只是出题的那一段
    const referenceOf = (qid: string, sourceId: string) => [sourceId, ...Object.entries(labels.candidates[qid])
        .filter(([id, v]) => v.acceptable && id !== sourceId).map(([id]) => id)]
        .map(id => byId.get(id)!)
        .map(c => `[turns ${c.start_turn}-${c.end_turn}]\n${chunkContent(c)}`)
        .join("\n\n");

    const longSummaries = LONG ? readJson<Record<string, string>>(join(BENCH_DIR, "out", "long_summaries", `${sessionId}.json`)) : {};
    // 与 retrieveMemories 相同的形状：排名、前 ORIGINALS 个附原文、按轮次排序
    const longMemories = (ranked: string[]): RetrievedMemory[] => ranked
        .map((id, i) => {
            const c = byId.get(id)!;
            // 写作 prompt 只用到摘要、轮次与原文；Chunk 缺少的打分字段不影响
            return { ...toIndexedMemory(c as never), dense_summary: longSummaries[id], rank: i + 1, content: i < ORIGINALS ? memoryContent(c.original_text) : undefined };
        })
        .sort((a, b) => a.start_turn - b.start_turn);

    const chain = storyWorkerPrompt.pipe(getStoryLLM()).pipe(new StringOutputParser());

    const results = await mapLimit(valid, 6, async q => {
        // 复用检索阶段在该快照上的改写结果，与 retrieval.json 中的 v2 排序一致
        const row = rows.find(r => r.qid === q.qid && r.snapshot === SNAPSHOT)!;
        const intent = row.intent;
        const memories = LONG ? longMemories(row.rankings.v2_long) : await retrieveMemories({
            rawInput: q.question,
            intent,
            dense: startDenseSearch(q.question, sessionId, { createdBefore: snap.taken_at }),
            sessionId,
            createdBefore: snap.taken_at,
            originalTextFor: ORIGINALS,
        });
        // 与线上生成完全一致的 prompt 组装（快照时刻的上下文）
        const response = await chain.invoke(writerPromptInputs({
            state: snap.currentState,
            memories,
            unprocessedArchive: snap.unprocessedArchive,
            chatHistory: snap.chatHistory,
            input: q.question,
        }));
        const goldRetrieved = memories.some(m => labels.candidates[q.qid][m.id]?.acceptable);
        const verdict = await judgeAnswer({
            question: q.question,
            expectedAnswer: q.expected_answer,
            reference: referenceOf(q.qid, q.source_id),
            response,
        });
        return { qid: q.qid, type: q.type, pool: q.pool, gold_retrieved: goldRetrieved, ...verdict, response };
    });

    const tally = tallyVerdicts;
    const summary = {
        judge: JUDGE_VERSION,
        n: results.length,
        all: tally(results),
        gold_retrieved: { n: results.filter(r => r.gold_retrieved).length, ...tally(results.filter(r => r.gold_retrieved)) },
        gold_not_retrieved: { n: results.filter(r => !r.gold_retrieved).length, ...tally(results.filter(r => !r.gold_retrieved)) },
        by_type: Object.fromEntries((["detail", "vague", "temporal"] as const).map(t => [t, tally(results.filter(r => r.type === t))])),
    };
    console.log(JSON.stringify(summary, null, 2));
    console.log(`variant: ${TAG} (original text for top ${ORIGINALS})`);
    writeJson(join(dir, `e2e_${TAG}.json`), { variant: { tag: TAG, originalTextFor: ORIGINALS, longSummaries: LONG }, summary, results });
}

main().catch(e => { console.error(e); process.exit(1); });
