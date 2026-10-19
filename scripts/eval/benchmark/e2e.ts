/**
 * 基准测试 · 端到端检查（PROTOCOL.md 第 8 节）
 *
 * 在第 300 回合快照上，用快照时的上下文（世界状态、滑动窗口、待归档区）、线上写作 prompt 与线上检索，
 * 让故事模型回答每道有效题；裁判对照参考段落（来源片段原文）判定 correct / contradicts / absent。
 *
 * --originals N：排名前 N 的记忆附上片段原文（不传则用线上配置 HYBRID_RETRIEVAL_CONFIG.originalTextFor）
 *
 * 运行：npx tsx --env-file=.env scripts/eval/benchmark/e2e.ts <dev|test> [--originals N] [--tag name]
 * 输出：out/<story>/e2e_<tag>.json（v2 冻结时的结果为 e2e.json）
 */
import { StringOutputParser } from "@langchain/core/output_parsers";
import { join } from "node:path";
import { HYBRID_RETRIEVAL_CONFIG, retrieveMemories, startDenseSearch } from "../../../src/lib/hybridRetriever";
import { getStoryLLM } from "../../../src/lib/Init";
import { storyWorkerPrompt } from "../../../src/lib/prompt";
import { writerPromptInputs } from "../../../src/lib/storyGenerator";
import { judgeAnswer, JUDGE_VERSION, tallyVerdicts } from "./judge";
import { chunkContent, loadQuestions, loadStory, mapLimit, readJson, RetrievalRow, writeJson } from "./common";

const STORY_NAME = process.argv[2];
const SNAPSHOT = 300;
const argValue = (flag: string) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined; };
const ORIGINALS = argValue("--originals") !== undefined ? Number(argValue("--originals")) : HYBRID_RETRIEVAL_CONFIG.originalTextFor;
const TAG = argValue("--tag") ?? `originals${ORIGINALS}`;

async function main() {
    const { dir, sessionId, chunks, snapshots } = loadStory(STORY_NAME);
    const snap = snapshots[SNAPSHOT];
    const questions = loadQuestions(STORY_NAME);
    const labels = readJson<{ candidates: Record<string, Record<string, { acceptable: boolean }>> }>(join(dir, "labels.json"));
    const { rows } = readJson<{ rows: RetrievalRow[] }>(join(dir, "retrieval.json"));
    const byId = new Map(chunks.map(c => [c.id, c]));
    const valid = questions.filter(q => labels.candidates[q.qid][q.source_id].acceptable);

    const chain = storyWorkerPrompt.pipe(getStoryLLM()).pipe(new StringOutputParser());

    const results = await mapLimit(valid, 6, async q => {
        // 复用检索阶段在该快照上的改写结果，与 retrieval.json 中的 v2 排序一致
        const intent = rows.find(r => r.qid === q.qid && r.snapshot === SNAPSHOT)!.intent;
        const memories = await retrieveMemories({
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
            reference: chunkContent(byId.get(q.source_id)!),
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
    writeJson(join(dir, `e2e_${TAG}.json`), { variant: { tag: TAG, originalTextFor: ORIGINALS }, summary, results });
}

main().catch(e => { console.error(e); process.exit(1); });
