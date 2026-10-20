/**
 * 端到端检查：故事模型对回忆型问题的回答，是否与过去发生的事一致？
 *
 * 对每道回忆题，用线上同样的方式组装上下文并让故事模型作答，比较两种条件（由 mode 决定）：
 *   prompt       （默认）两边都用线上混合检索，只换写作 prompt：
 *                  before = 修改前的 prompt（legacy_prompts.ts），after = 现在的线上 prompt
 *   shortcircuit 复现"移除意图短路"的对比（写作 prompt 用修改前的版本，与当时一致）：
 *                  before = 被旧路由短路的题拿不到任何长记忆，after = 每题都检索
 *   pacing       两边都用线上混合检索，before = 修改节奏规则之前的 prompt（PRE_PACING），after = 现在的线上 prompt；
 *                检查节奏修改有没有损害记忆忠实
 * 再由裁判 LLM 判断回答与标准事实的关系：correct / contradicts / absent。
 *
 * 运行：npx tsx --env-file=.env scripts/eval/e2e_recall.ts [prompt|shortcircuit|pacing]
 * 输入：scripts/eval/out/corpus.json, questions.json（shortcircuit 模式需含 short_circuited 字段）,
 *       questions_holdout.json（仅 prompt 模式）
 * 输出：scripts/eval/out/e2e_recall_<mode>.json
 */
import { StringOutputParser } from "@langchain/core/output_parsers";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { ChatOpenAI } from "@langchain/openai";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { getStoryLLM } from "../../src/lib/Init";
import { storyWorkerPrompt } from "../../src/lib/prompt";
import { writerPromptInputs } from "../../src/lib/storyGenerator";
import { translateUserIntent } from "../../src/lib/query";
import { getSession } from "../../src/lib/sessionStore";
import { retrieveMemories, startDenseSearch } from "../../src/lib/hybridRetriever";
import { LEGACY_STORY_WORKER_SYSTEM_TEMPLATE, PRE_PACING_STORY_WORKER_SYSTEM_TEMPLATE } from "./legacy_prompts";

const OUT_DIR = join(process.cwd(), "scripts", "eval", "out");
const MODE = (process.argv[2] || "prompt") as "prompt" | "shortcircuit" | "pacing";
const CONCURRENCY = 6;

type Question = { qid: string; type: string; question: string; target_fact: string; gold_id: string; short_circuited?: boolean };
type Verdict = "correct" | "contradicts" | "absent";

const VerdictSchema = z.object({
    reasoning: z.string().describe("One sentence comparing the response with the correct fact."),
    verdict: z.enum(["correct", "contradicts", "absent"]).describe(
        "correct: the response states or clearly reflects the correct fact. contradicts: the response states something incompatible with it. absent: the response does not address it."
    ),
});

const judge = new ChatOpenAI({
    modelName: "gpt-4o-mini",
    openAIApiKey: process.env.OPENAI_API_KEY,
    temperature: 0,
}).withStructuredOutput(VerdictSchema);

const promptFrom = (system: string) => ChatPromptTemplate.fromMessages([
    ["system", system],
    new MessagesPlaceholder("chatHistory"),
    ["human", "{input}"],
]);
const legacyStoryWorkerPrompt = promptFrom(LEGACY_STORY_WORKER_SYSTEM_TEMPLATE);
const prePacingStoryWorkerPrompt = promptFrom(PRE_PACING_STORY_WORKER_SYSTEM_TEMPLATE);

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: limit }, async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i]);
        }
    }));
    return results;
}

const loadQuestions = (file: string): Question[] =>
    JSON.parse(readFileSync(join(OUT_DIR, file), "utf-8")).questions.map((q: Question) => ({ ...q, qid: `${file.replace(".json", "")}:${q.qid}` }));

async function main() {
    const corpus = JSON.parse(readFileSync(join(OUT_DIR, "corpus.json"), "utf-8"));
    const questions = MODE !== "shortcircuit"
        ? [...loadQuestions("questions.json"), ...loadQuestions("questions_holdout.json")]
        : loadQuestions("questions.json");
    if (MODE === "shortcircuit" && !questions.some(q => q.short_circuited !== undefined)) {
        throw new Error("questions.json has no short_circuited field; the 'before' condition cannot be reconstructed");
    }
    const goldById = new Map<string, string>(corpus.chunks.map((c: { id: string; dense_summary: string }) => [c.id, c.dense_summary]));

    const session = await getSession(corpus.sessionId);
    if (!session) throw new Error(`session ${corpus.sessionId} not found`);
    const { currentState, memoryManager } = session;

    const chains = {
        legacy: legacyStoryWorkerPrompt.pipe(getStoryLLM()).pipe(new StringOutputParser()),
        prePacing: prePacingStoryWorkerPrompt.pipe(getStoryLLM()).pipe(new StringOutputParser()),
        current: storyWorkerPrompt.pipe(getStoryLLM()).pipe(new StringOutputParser()),
    };

    // 与线上生成完全一致的 prompt 组装；memories 为空时即"拿不到任何长记忆"
    const write = (prompt: keyof typeof chains, input: string, memories: { dense_summary: string }[]) =>
        chains[prompt].invoke(writerPromptInputs({
            state: currentState,
            memories,
            unprocessedArchive: memoryManager.unprocessedArchive,
            chatHistory: memoryManager.chatHistory,
            input,
        }));

    const grade = async (q: Question, response: string): Promise<{ verdict: Verdict; reasoning: string }> =>
        judge.invoke([
            ["system", "You check whether a story response is consistent with a known past fact. The player asked about something that happened earlier; the response is the narrator's reply."],
            ["human", `PLAYER QUESTION: ${q.question}\n\nCORRECT FACT: ${q.target_fact}\nFull memory: ${goldById.get(q.gold_id)}\n\nRESPONSE:\n${response}`],
        ]);

    const rows = await mapLimit(questions, CONCURRENCY, async q => {
        const intent = await translateUserIntent(currentState, memoryManager.chatHistory.slice(-3), q.question);
        const memories = await retrieveMemories({
            rawInput: q.question,
            intent,
            dense: startDenseSearch(q.question, corpus.sessionId),
            sessionId: corpus.sessionId,
        });
        const goldRetrieved = memories.some(m => m.id === q.gold_id);

        const [beforeResponse, afterResponse] = MODE === "prompt"
            ? await Promise.all([write("legacy", q.question, memories), write("current", q.question, memories)])
            : MODE === "pacing"
                ? await Promise.all([write("prePacing", q.question, memories), write("current", q.question, memories)])
                : await Promise.all([write("legacy", q.question, q.short_circuited ? [] : memories), write("legacy", q.question, memories)]);
        const [before, after] = await Promise.all([grade(q, beforeResponse), grade(q, afterResponse)]);
        console.log(`${q.qid.padEnd(28)} gold@10=${goldRetrieved ? "y" : "n"}  before=${before.verdict.padEnd(11)} after=${after.verdict}`);
        return {
            qid: q.qid, type: q.type, question: q.question, short_circuited: q.short_circuited, gold_retrieved: goldRetrieved,
            before: { ...before, response: beforeResponse },
            after: { ...after, response: afterResponse },
        };
    });

    const tally = (key: "before" | "after", subset = rows) =>
        Object.fromEntries((["correct", "contradicts", "absent"] as Verdict[]).map(v => [v, subset.filter(r => r[key].verdict === v).length]));
    const retrieved = rows.filter(r => r.gold_retrieved);
    const summary = {
        mode: MODE,
        all: { n: rows.length, before: tally("before"), after: tally("after") },
        // 正确片段已在前 10 条记忆里时，回答是否用上了它
        gold_retrieved: { n: retrieved.length, before: tally("before", retrieved), after: tally("after", retrieved) },
        paired: {
            improved: rows.filter(r => r.before.verdict !== "correct" && r.after.verdict === "correct").length,
            worsened: rows.filter(r => r.before.verdict === "correct" && r.after.verdict !== "correct").length,
        },
    };
    console.log(JSON.stringify(summary, null, 2));
    writeFileSync(join(OUT_DIR, `e2e_recall_${MODE}.json`), JSON.stringify({ summary, rows }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
