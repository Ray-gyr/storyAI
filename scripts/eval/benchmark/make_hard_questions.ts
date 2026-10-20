/**
 * 基准测试 · 检索难题集（只用开发故事，输出到 out/dev-hard/）
 *
 * 第 2 版题目会交代人物、地点和当时的情境，检索几乎没有难度（开发故事上非时间类题只漏 1 道），
 * 测不出摘要质量对检索的影响。这里出一批信息量少、像玩家随口一问的题：
 *   - 不超过 15 个词，不交代场景，只点出一个人或物和要问的事
 *   - 只问与剧情相关的事实；不出"第几次"类时间题
 *   - 对照全故事目录，选在整个故事里只有一个答案的事实（之后还有一致性校验）
 * 之后与其他题目一样经过 screen_questions.ts、人工核对、retrieve / label / validate。
 *
 * 前置：out/dev-hard/ 下已复制开发故事的 corpus.json、snapshot_*.json、transcript.json
 * 运行：npx tsx --env-file=.env scripts/eval/benchmark/make_hard_questions.ts [count]
 * 输出：out/dev-hard/questions.json
 */
import { ChatOpenAI } from "@langchain/openai";
import { join } from "node:path";
import { z } from "zod";
import { STORIES } from "./stories";
import { Chunk, chunkContent, evenly, existsAt, loadStory, mapLimit, Question, wordCount, writeJson } from "./common";

const STORY_DIR_NAME = "dev-hard";
const SPEC = STORIES.dev;
const COUNT = Number(process.argv[2] || 60);
const MIN_WORDS = 40;

const llm = new ChatOpenAI({ modelName: "gpt-6.1-sol", openAIApiKey: process.env.OPENAI_API_KEY });

const QuestionSchema = z.object({
    question: z.string().describe("The player's short question, first person, max 15 words, no scene-setting clause."),
    expected_answer: z.string().describe("The short correct answer, taken from the passage."),
    why_unique: z.string().describe("One sentence: why this question has only one answer across the whole story."),
});

const SYSTEM = `You write retrieval test questions for a text adventure. Late in the story, the player (${SPEC.protagonist}) casually asks the narrator about something from earlier, the way a real player types mid-game: short and with little context.

Rules:
- Max 15 words. No scene-setting clauses such as "When I ..." or "At the ..."; name at most one person or object and what you want to know (e.g. "What did the pawnbroker refuse to do?", "Who told me the logs were damaged?").
- Ask only about something story-relevant: a decision, what someone said or revealed, an item gained, lost or used, an outcome, or a clue. No sensory trivia, gestures or scenery.
- The question must have ONE answer across the whole story: check the STORY OUTLINE and avoid facts that happen more than once or change over time.
- It must be answerable from the PASSAGE. Do not copy sentences from it.

STORY OUTLINE:
`;

async function main() {
    const { dir, chunks, snapshots } = loadStory(STORY_DIR_NAME);
    const inStory = chunks.filter(c => existsAt(c, snapshots[300])).sort((a, b) => a.start_turn - b.start_turn);
    const outline = inStory.map(c => `turns ${c.start_turn}-${c.end_turn}: ${c.dense_summary}`).join("\n");
    const sources = evenly(inStory.filter(c => wordCount(chunkContent(c)) >= MIN_WORDS), COUNT);

    const generated = await mapLimit(sources, 6, async (chunk: Chunk) => ({
        chunk,
        q: await llm.withStructuredOutput(QuestionSchema).invoke([
            ["system", SYSTEM + outline],
            ["human", `PASSAGE:\n${chunkContent(chunk)}`],
        ]),
    }));

    const questions: Question[] = generated.map(({ chunk, q }, i) => ({
        qid: `hard-${i + 1}`,
        pool: existsAt(chunk, snapshots[100]) ? "early" : "late",
        type: "detail",
        source_id: chunk.id,
        source_turns: [chunk.start_turn, chunk.end_turn],
        question: q.question,
        expected_answer: q.expected_answer,
    }));
    writeJson(join(dir, "questions.json"), { story: STORY_DIR_NAME, version: "hard-1", model: "gpt-6.1-sol", questions });
    console.log(`saved ${questions.length} hard questions`);
}

main().catch(e => { console.error(e); process.exit(1); });
