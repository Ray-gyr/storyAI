/**
 * 基准测试 · 端到端检查（PROTOCOL.md 第 8 节）
 *
 * 在第 300 回合快照上，用快照时的上下文（世界状态、滑动窗口、待归档区）、线上写作 prompt 与线上检索，
 * 让故事模型回答每道有效题；裁判对照参考段落（来源片段原文）判定 correct / contradicts / absent。
 *
 * 运行：npx tsx --env-file=.env scripts/eval/benchmark/e2e.ts <dev|test>
 * 输出：out/<story>/e2e.json
 */
import { StringOutputParser } from "@langchain/core/output_parsers";
import { ChatOpenAI } from "@langchain/openai";
import { join } from "node:path";
import { z } from "zod";
import { retrieveMemories, startDenseSearch } from "../../../src/lib/hybridRetriever";
import { getStoryLLM } from "../../../src/lib/Init";
import { storyWorkerPrompt } from "../../../src/lib/prompt";
import { writerPromptInputs } from "../../../src/lib/storyGenerator";
import { chunkContent, loadQuestions, loadStory, mapLimit, readJson, RetrievalRow, writeJson } from "./common";

const STORY_NAME = process.argv[2];
const SNAPSHOT = 300;

const judge = new ChatOpenAI({ modelName: "gpt-4o-mini", openAIApiKey: process.env.OPENAI_API_KEY, temperature: 0 })
    .withStructuredOutput(z.object({
        reasoning: z.string().describe("One sentence comparing the response with the reference passage."),
        verdict: z.enum(["correct", "contradicts", "absent"]).describe(
            "correct: the response states or clearly reflects the expected answer. contradicts: it states something incompatible with the reference passage. absent: it does not address the question."),
    }));

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
        const verdict = await judge.invoke([
            ["system", "You check whether a story narrator's reply is consistent with what actually happened earlier in the story."],
            ["human", `PLAYER QUESTION: ${q.question}\nEXPECTED ANSWER: ${q.expected_answer}\n\nREFERENCE passage (what actually happened):\n${chunkContent(byId.get(q.source_id)!)}\n\nNARRATOR'S REPLY:\n${response}`],
        ]);
        return { qid: q.qid, type: q.type, pool: q.pool, gold_retrieved: goldRetrieved, ...verdict, response };
    });

    const tally = (subset: typeof results) => Object.fromEntries(
        (["correct", "contradicts", "absent"] as const).map(v => [v, subset.filter(r => r.verdict === v).length]));
    const summary = {
        n: results.length,
        all: tally(results),
        gold_retrieved: { n: results.filter(r => r.gold_retrieved).length, ...tally(results.filter(r => r.gold_retrieved)) },
        gold_not_retrieved: { n: results.filter(r => !r.gold_retrieved).length, ...tally(results.filter(r => !r.gold_retrieved)) },
        by_type: Object.fromEntries((["detail", "vague", "temporal"] as const).map(t => [t, tally(results.filter(r => r.type === t))])),
    };
    console.log(JSON.stringify(summary, null, 2));
    writeJson(join(dir, "e2e.json"), { summary, results });
}

main().catch(e => { console.error(e); process.exit(1); });
