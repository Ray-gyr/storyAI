/**
 * 基准测试 · 出题（PROTOCOL.md 第 4 节）
 *
 * 只给出题模型看片段原文（不看摘要），每个池子（early / late）出：
 *   detail 20 道、vague 15 道（不出现专有名词）、temporal 10 道（"第 n 次某类事件"）
 * temporal 题先用 LLM 给每个片段标注出现了哪些反复事件，按 start_turn 计序号。
 *
 * 运行：npx tsx --env-file=.env scripts/eval/benchmark/make_questions.ts <dev|test>
 * 输出：out/<story>/events.json, out/<story>/questions.json
 */
import { ChatOpenAI } from "@langchain/openai";
import { join } from "node:path";
import { z } from "zod";
import { STORIES } from "./stories";
import { Chunk, chunkContent, evenly, existsAt, loadStory, mapLimit, Question, QuestionType, wordCount, writeJson } from "./common";

const STORY_NAME = process.argv[2] as "dev" | "test";
const SPEC = STORIES[STORY_NAME];
if (!SPEC) throw new Error("usage: make_questions.ts <dev|test>");

const COUNTS: Record<QuestionType, number> = { detail: 20, vague: 15, temporal: 10 };
const MIN_WORDS = 40;
const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth"];

const llm = new ChatOpenAI({ modelName: "gpt-4o-mini", openAIApiKey: process.env.OPENAI_API_KEY, temperature: 0.4 });
const tagger = new ChatOpenAI({ modelName: "gpt-4o-mini", openAIApiKey: process.env.OPENAI_API_KEY, temperature: 0 });

const QuestionSchema = z.object({
    question: z.string().describe("The player's question, first person, max 25 words."),
    expected_answer: z.string().describe("The short correct answer, taken from the passage."),
});
// 每类事件单独回答是 / 否（返回编号数组时模型常把 0 当默认值，导致第 0 类被大量误标）
const TagSchema = z.object(Object.fromEntries(SPEC.recurringEvents.map((event, i) => [
    `event_${i}`,
    z.boolean().describe(`True only if a NEW instance of "${event}" happens in this passage.`),
])));

const SYSTEM = `You write test questions for a memory-retrieval benchmark of a text adventure.
The player (${SPEC.protagonist}) asks the narrator about something that happened earlier in the story.
You see one passage of the story's raw narration. Questions must be answerable from this passage alone.`;

const TYPE_INSTRUCTIONS: Record<"detail" | "vague", string> = {
    detail: `Pick one specific, concrete detail in the passage (an object, something someone said, a number, a consequence) that is unlikely to be true elsewhere in the story. Write a natural first-person player question about it. Do not copy sentences from the passage.`,
    vague: `Pick one specific, concrete detail in the passage (an object, something someone said, a number, a consequence) that is unlikely to be true elsewhere in the story. Write a natural first-person player question about it that uses NO proper names at all: refer to people, places, and things only by description ("the engineer", "the old woman at the well", "the thing I pulled from the wreck"). Do not copy sentences from the passage.`,
};

async function ask(instructions: string, passage: string, avoid: string[]): Promise<{ question: string; expected_answer: string }> {
    const avoidText = avoid.length ? `\n\nAsk about a different detail than these existing questions:\n${avoid.map(q => `- ${q}`).join("\n")}` : "";
    return llm.withStructuredOutput(QuestionSchema).invoke([
        ["system", `${SYSTEM}\n\n${instructions}${avoidText}`],
        ["human", `Passage:\n${passage}`],
    ]);
}

async function tagEvents(chunks: Chunk[]): Promise<Record<string, number[]>> {
    const tags = await mapLimit(chunks, 8, async chunk => {
        const res = await tagger.withStructuredOutput(TagSchema).invoke([
            ["system", `For each recurring event type, decide whether a NEW instance of it happens in this passage: it starts here, or is clearly a distinct new episode. Answer false if the event is only mentioned or remembered, or if the passage only shows the continuing consequences of an earlier instance (for example, an injury or damage that already happened).`],
            ["human", chunkContent(chunk)],
        ]) as Record<string, boolean>;
        return [chunk.id, SPEC.recurringEvents.map((_, i) => i).filter(i => res[`event_${i}`])] as const;
    });
    return Object.fromEntries(tags);
}

async function main() {
    const { dir, chunks, snapshots } = loadStory(STORY_NAME);
    const inStory = chunks.filter(c => existsAt(c, snapshots[300])).sort((a, b) => a.start_turn - b.start_turn);
    const usable = (c: Chunk) => wordCount(chunkContent(c)) >= MIN_WORDS;
    const pools = {
        early: inStory.filter(c => existsAt(c, snapshots[100])),
        late: inStory.filter(c => !existsAt(c, snapshots[100])),
    };
    console.log(`chunks: ${inStory.length} (early ${pools.early.length}, late ${pools.late.length}); usable early ${pools.early.filter(usable).length}, late ${pools.late.filter(usable).length}`);

    // 反复事件：标注 + 按 start_turn 计序号（从故事开头算起）
    const tags = await tagEvents(inStory);
    const occurrences = SPEC.recurringEvents.map((_, e) => inStory.filter(c => tags[c.id].includes(e)));
    writeJson(join(dir, "events.json"), {
        events: SPEC.recurringEvents,
        occurrences: occurrences.map(list => list.map(c => ({ id: c.id, turns: [c.start_turn, c.end_turn] }))),
    });
    occurrences.forEach((list, e) => console.log(`event ${e} "${SPEC.recurringEvents[e]}": ${list.length} occurrences`));

    const questions: Question[] = [];
    for (const [poolName, poolChunks] of Object.entries(pools) as ["early" | "late", Chunk[]][]) {
        // detail + vague：均匀抽 35 个来源片段，其中均匀的 15 个出 vague，其余出 detail
        const sources = poolChunks.filter(usable);
        const n = COUNTS.detail + COUNTS.vague;
        const picked = sources.length >= n ? evenly(sources, n) : Array.from({ length: n }, (_, i) => sources[i % sources.length]);
        const vagueSlots = new Set(evenly([...Array(n).keys()], COUNTS.vague));
        const plain = picked.map((chunk, i) => ({ chunk, type: (vagueSlots.has(i) ? "vague" : "detail") as QuestionType }));

        // temporal：early 池取第 1、2 次发生，late 池取第 3 次及以后
        const temporalCandidates = occurrences.flatMap((list, e) => list
            .map((chunk, idx) => ({ chunk, event: e, ordinal: idx + 1 }))
            .filter(o => usable(o.chunk) && poolChunks.includes(o.chunk))
            .filter(o => poolName === "early" ? o.ordinal <= 2 : o.ordinal >= 3))
            .sort((a, b) => a.chunk.start_turn - b.chunk.start_turn);
        const temporal = temporalCandidates.length >= COUNTS.temporal
            ? evenly(temporalCandidates, COUNTS.temporal)
            : Array.from({ length: Math.min(COUNTS.temporal, temporalCandidates.length * 2) }, (_, i) => temporalCandidates[i % temporalCandidates.length]);

        const jobs = [
            ...plain.map(p => ({ ...p, event: undefined as number | undefined, ordinal: undefined as number | undefined })),
            ...temporal.map(t => ({ chunk: t.chunk, type: "temporal" as QuestionType, event: t.event, ordinal: t.ordinal })),
        ];
        const asked = new Map<string, string[]>();
        // 顺序生成：同一片段被抽中两次时，第二题要避开第一题问过的细节
        for (const job of jobs) {
            const previous = asked.get(job.chunk.id) ?? [];
            const instructions = job.type === "temporal"
                ? `This passage depicts occurrence number ${job.ordinal} (counted from the start of the story) of a recurring event: "${SPEC.recurringEvents[job.event!]}". Write a first-person player question that identifies the event by its type and its ordinal ("the ${ORDINALS[job.ordinal! - 1]} time ...") and asks about a specific detail of this occurrence. Do not mention other details of the passage that would identify it without the ordinal.`
                : TYPE_INSTRUCTIONS[job.type as "detail" | "vague"];
            const q = await ask(instructions, chunkContent(job.chunk), previous);
            asked.set(job.chunk.id, [...previous, q.question]);
            questions.push({
                qid: `${poolName}-${job.type}-${questions.filter(x => x.pool === poolName && x.type === job.type).length + 1}`,
                pool: poolName,
                type: job.type,
                source_id: job.chunk.id,
                source_turns: [job.chunk.start_turn, job.chunk.end_turn],
                question: q.question,
                expected_answer: q.expected_answer,
                ...(job.type === "temporal" ? { event: SPEC.recurringEvents[job.event!], ordinal: job.ordinal } : {}),
            });
        }
        console.log(`${poolName}: ${jobs.length} questions (${temporalCandidates.length} temporal candidates)`);
    }

    writeJson(join(dir, "questions.json"), { story: STORY_NAME, model: "gpt-4o-mini", questions });
    console.log(`saved ${questions.length} questions`);
}

main().catch(e => { console.error(e); process.exit(1); });
