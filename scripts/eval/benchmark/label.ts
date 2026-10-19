/**
 * 基准测试 · 标注可接受的片段（PROTOCOL.md 第 5 节）
 *
 * 候选池 = 来源片段 ∪ 每道题在所有快照上各方法的前 N 名
 *   （test 故事 N = 10；dev 故事的 bm25 / vector 取到前 30，供调融合参数）
 * 裁判（gpt-4o-mini, temperature 0）对照"参考段落"（来源片段原文）判断候选片段能否回答问题；
 * temporal 题还要求描述的是同一次事件。来源片段本身判不过的题作废。
 * 另判断来源片段的摘要里有没有答案（区分"检索没找到"与"摘要没写"）。
 * 判定结果按 (题目, 片段) 缓存，重复运行只补新候选。
 *
 * 运行：npx tsx --env-file=.env scripts/eval/benchmark/label.ts <dev|test>
 * 输出：out/<story>/labels.json
 */
import { ChatOpenAI } from "@langchain/openai";
import { join } from "node:path";
import { z } from "zod";
import { Chunk, chunkContent, loadJsonIfExists, loadQuestions, loadStory, mapLimit, Question, readJson, RetrievalRow, writeJson } from "./common";

const STORY_NAME = process.argv[2];
const DEEP_POOL = STORY_NAME === "dev" ? 30 : 10;

type Verdict = { acceptable: boolean; reasoning: string };
type Labels = {
    candidates: Record<string, Record<string, Verdict>>;
    summary_has_answer: Record<string, Verdict>;
};

const judge = new ChatOpenAI({ modelName: "gpt-4o-mini", openAIApiKey: process.env.OPENAI_API_KEY, temperature: 0 })
    .withStructuredOutput(z.object({
        reasoning: z.string().describe("One sentence."),
        acceptable: z.boolean(),
    }));

function candidatePrompt(q: Question, reference: Chunk, candidate: Chunk): string {
    const criterion = q.type === "temporal"
        ? `The question is about one specific occurrence of a recurring event ("${q.event}", occurrence number ${q.ordinal}), which the REFERENCE passage depicts. Answer true only if the CANDIDATE depicts that SAME occurrence (not another time the event happened) and contains the answer.`
        : `Answer true only if the CANDIDATE passage contains the answer to the question: the same fact as in the REFERENCE passage.`;
    return `QUESTION: ${q.question}
EXPECTED ANSWER: ${q.expected_answer}

REFERENCE passage (turns ${reference.start_turn}-${reference.end_turn}):
${chunkContent(reference)}

CANDIDATE passage (turns ${candidate.start_turn}-${candidate.end_turn}):
${chunkContent(candidate)}

${criterion}`;
}

async function main() {
    const { dir, chunks } = loadStory(STORY_NAME);
    const questions = loadQuestions(STORY_NAME);
    const { rows } = readJson<{ rows: RetrievalRow[] }>(join(dir, "retrieval.json"));
    const byId = new Map(chunks.map(c => [c.id, c]));
    const labelsPath = join(dir, "labels.json");
    const labels = loadJsonIfExists<Labels>(labelsPath, { candidates: {}, summary_has_answer: {} });

    const jobs: { q: Question; candidate: Chunk }[] = [];
    for (const q of questions) {
        const pool = new Set<string>([q.source_id]);
        for (const row of rows.filter(r => r.qid === q.qid)) {
            row.rankings.tier.slice(0, 10).forEach(id => pool.add(id));
            row.rankings.v2.slice(0, 10).forEach(id => pool.add(id));
            row.rankings.bm25.slice(0, DEEP_POOL).forEach(id => pool.add(id));
            row.rankings.vector.slice(0, DEEP_POOL).forEach(id => pool.add(id));
        }
        labels.candidates[q.qid] ??= {};
        for (const id of pool) {
            if (!(id in labels.candidates[q.qid])) jobs.push({ q, candidate: byId.get(id)! });
        }
    }
    console.log(`${jobs.length} new (question, candidate) judgements`);

    let done = 0;
    await mapLimit(jobs, 8, async ({ q, candidate }) => {
        const reference = byId.get(q.source_id)!;
        labels.candidates[q.qid][candidate.id] = await judge.invoke([
            ["system", "You label a memory-retrieval benchmark. Judge strictly but fairly; paraphrases of the same fact count."],
            ["human", candidatePrompt(q, reference, candidate)],
        ]);
        if (++done % 200 === 0) {
            writeJson(labelsPath, labels);
            console.log(`  ${done}/${jobs.length}`);
        }
    });

    const summaryJobs = questions.filter(q => !(q.qid in labels.summary_has_answer));
    await mapLimit(summaryJobs, 8, async q => {
        labels.summary_has_answer[q.qid] = await judge.invoke([
            ["system", "You check whether a short summary still contains a specific fact."],
            ["human", `QUESTION: ${q.question}\nEXPECTED ANSWER: ${q.expected_answer}\n\nSUMMARY:\n${byId.get(q.source_id)!.dense_summary}\n\nAnswer true only if the summary alone contains the expected answer.`],
        ]);
    });

    writeJson(labelsPath, labels);
    const invalid = questions.filter(q => !labels.candidates[q.qid][q.source_id].acceptable);
    console.log(`labelled; ${invalid.length} questions fail validation (source does not answer): ${invalid.map(q => q.qid).join(", ")}`);
}

main().catch(e => { console.error(e); process.exit(1); });
