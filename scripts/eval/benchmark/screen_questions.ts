/**
 * 基准测试 · 题目质量筛选（question set 2）。只看题目与出处原文，不看任何检索或回答结果。
 *
 * 保留标准（gpt-6.1-sol 逐题判断，再人工核对所有被淘汰的题）：
 *   1. realistic：玩家回顾剧情时会想问的事（决定、对话、物品、结果、线索），而非纯感官的冷门细节
 *   2. specific：答案只属于这一刻，不是故事里反复出现的事实
 *   3. event_matches（仅 temporal）：出处原文确实描写了题目所说的那类事件
 *
 * 运行：npx tsx --env-file=.env scripts/eval/benchmark/screen_questions.ts <dev|test>
 * 输出：out/<story>/screening.json（{ qid: { keep, reason, ... } }）
 */
import { ChatOpenAI } from "@langchain/openai";
import { join } from "node:path";
import { z } from "zod";
import { chunkContent, loadJsonIfExists, loadQuestions, loadStory, mapLimit, writeJson } from "./common";

const STORY_NAME = process.argv[2];

const screener = new ChatOpenAI({ modelName: "gpt-6.1-sol", openAIApiKey: process.env.OPENAI_API_KEY })
    .withStructuredOutput(z.object({
        realistic: z.boolean().describe("A player looking back on this story could plausibly want to recall this: a decision, something said, an item, an outcome, a clue. False for pure sensory trivia with no story relevance (the material of an awning, the sound of hinges, dust falling)."),
        specific: z.boolean().describe("The answer belongs to this moment and is not a generic fact that recurs throughout the story."),
        event_matches: z.boolean().nullable().describe("Temporal questions only: the passage actually depicts the stated event type. Null for other question types."),
        reason: z.string().describe("One sentence explaining the decision."),
    }));

async function main() {
    const { dir, chunks } = loadStory(STORY_NAME);
    const byId = new Map(chunks.map(c => [c.id, c]));
    const questions = loadQuestions(STORY_NAME);
    // 已筛过的题不再重筛（判定有随机性，且人工核对基于已有判定）；只筛新增的题（如补题）
    const previous = loadJsonIfExists<Record<string, { keep: boolean }>>(join(dir, "screening.json"), {});
    const pending = questions.filter(q => !(q.qid in previous));
    console.log(`${pending.length} questions to screen (${questions.length - pending.length} already screened)`);

    const results = await mapLimit(pending, 8, async q => {
        const temporal = q.type === "temporal" ? `\nThe question refers to occurrence #${q.ordinal} of the recurring event "${q.event}".` : "";
        const r = await screener.invoke([
            ["system", "You review test questions for a memory benchmark of a text adventure. Each question is a player asking the narrator about an earlier moment of the story. Judge the question's quality, not whether it is easy."],
            ["human", `QUESTION (${q.type}): ${q.question}\nEXPECTED ANSWER: ${q.expected_answer}${temporal}\n\nSOURCE PASSAGE:\n${chunkContent(byId.get(q.source_id)!)}`],
        ]);
        const keep = r.realistic && r.specific && (q.type !== "temporal" || r.event_matches !== false);
        return [q.qid, { keep, ...r }] as const;
    });

    const screening = { ...previous, ...Object.fromEntries(results) };
    writeJson(join(dir, "screening.json"), screening);
    const dropped = results.filter(([, v]) => !v.keep);
    console.log(`newly screened: keep ${results.length - dropped.length}/${results.length}`);
    for (const type of ["detail", "vague", "temporal"]) {
        const ofType = questions.filter(q => q.type === type);
        console.log(`  ${type}: keep ${ofType.filter(q => screening[q.qid].keep).length}/${ofType.length}`);
    }
}

main().catch(e => { console.error(e); process.exit(1); });
