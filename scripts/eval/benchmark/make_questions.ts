/**
 * 基准测试 · 出题，第 2 版（question set 2；第 1 版的题目与结果存档在 out/<story>/qset1/）
 *
 * 第 1 版的问题（人工核对时发现，见 RESULTS.md）：
 *   - 反复事件按"片段"计数，持续的缺水被算成 42 次，出现"第 42 次缺水危机"这类无法回答的题
 *   - 问随时间变化的状态（"水还剩多少"），同一问题在不同时刻答案不同
 *   - 问在故事里反复出现的事实，题目有歧义
 * 第 2 版：
 *   - 出题模型 gpt-6.1-sol，附上全故事的摘要目录，要求选这一段独有、且不随时间变化的事实
 *   - 反复事件按"情节"计数：只有新开始的一次才算，相邻片段延续的同一件事合并；时间类题序号上限 5
 *   - 每个池子（early / late）：detail 20、vague 15（不出现专有名词）、temporal 至多 10（每段情节至多 2 题）
 *   - 标注之后由 validate_questions.ts 再做一致性检查，答案有歧义的题作废
 *
 * 运行：npx tsx --env-file=.env scripts/eval/benchmark/make_questions.ts <dev|test> [--topup]
 * 输出：out/<story>/events.json, out/<story>/questions.json
 */
import { ChatOpenAI } from "@langchain/openai";
import { join } from "node:path";
import { z } from "zod";
import { STORIES } from "./stories";
import { BENCH_DIR, Chunk, chunkContent, evenly, existsAt, loadStory, mapLimit, Question, QuestionType, readJson, wordCount, writeJson } from "./common";

const STORY_NAME = process.argv[2] as "dev" | "test";
const SPEC = STORIES[STORY_NAME];
if (!SPEC) throw new Error("usage: make_questions.ts <dev|test>");

const QUESTION_MODEL = "gpt-6.1-sol";
const COUNTS = { detail: 20, vague: 15, temporal: 10 };
const MAX_ORDINAL = 5;
const MIN_WORDS = 40;
const ORDINALS = ["first", "second", "third", "fourth", "fifth"];

const llm = new ChatOpenAI({ modelName: QUESTION_MODEL, openAIApiKey: process.env.OPENAI_API_KEY });

const QuestionSchema = z.object({
    question: z.string().describe("The player's question, first person, max 25 words."),
    expected_answer: z.string().describe("The short correct answer, taken from the passage."),
    why_unique: z.string().describe("One sentence: why this fact appears only in this passage and does not change over time."),
});

const SYSTEM = `You write test questions for a memory-retrieval benchmark of a text adventure.
Late in the story, the player (${SPEC.protagonist}) asks the narrator about something that happened earlier.
You get the STORY OUTLINE (a one-line summary of every passage, with turn numbers) and ONE passage of raw narration.

Rules for every question:
- It must be answerable from this passage alone, with one clear answer.
- Pick a fact that is unique to this passage: check the outline and avoid facts, objects, or exchanges that recur in other passages.
- Avoid states that change over time (how much of something is left, where someone currently is, how tired or hurt someone is) unless the question pins down the exact moment.
- Write it the way a player would ask, with enough context (who, where, what was happening) to identify the moment. Do not copy sentences from the passage.${process.argv.includes("--topup") ? `
- Ask only about something story-relevant: a decision, what someone said or revealed, an item gained, lost or used, an outcome, or a clue. Never ask about incidental sensory detail, gestures, posture, where someone looked, or scenery.` : ""}`;

const TYPE_INSTRUCTIONS = {
    detail: "Ask about one specific, concrete detail: an object, something someone said, a decision, or a consequence.",
    vague: "Ask about one specific, concrete detail, but use NO proper names at all: refer to people, places, and things only by description (\"the blind guide\", \"the city guard captain\", \"the thing I pulled from the wreck\"). The description must still identify them unambiguously.",
};

const TagSchema = z.object(Object.fromEntries(SPEC.recurringEvents.map((event, i) => [
    `event_${i}`,
    z.boolean().describe(`True only if a NEW, distinct episode of "${event}" begins in this passage.`),
])));

function outlineOf(chunks: Chunk[]): string {
    return chunks.map(c => `turns ${c.start_turn}-${c.end_turn}: ${c.dense_summary}`).join("\n");
}

async function ask(outline: string, instructions: string, passage: string, avoid: string[]) {
    const avoidText = avoid.length ? `\n\nAsk about a different detail than these existing questions:\n${avoid.map(q => `- ${q}`).join("\n")}` : "";
    return llm.withStructuredOutput(QuestionSchema).invoke([
        ["system", `${SYSTEM}\n\n${instructions}${avoidText}\n\nSTORY OUTLINE:\n${outline}`],
        ["human", `PASSAGE:\n${passage}`],
    ]);
}

/** 按"情节"标注反复事件：只算新开始的一次；与上一段相邻且同样被标注的视为同一段情节的延续 */
async function tagEpisodes(chunks: Chunk[]) {
    const tags = await mapLimit(chunks, 8, async (chunk, i) => {
        const previous = i > 0 ? `PREVIOUS PASSAGE (summary): ${chunks[i - 1].dense_summary}\n\n` : "";
        const res = await llm.withStructuredOutput(TagSchema).invoke([
            ["system", "For each recurring event type, decide whether a NEW, distinct episode of it begins in the CURRENT passage. Answer false if the event is only mentioned or remembered, or if the passage continues an episode already underway in the previous passage (an ongoing shortage, the same fight, the same negotiation)."],
            ["human", `${previous}CURRENT PASSAGE:\n${chunkContent(chunk)}`],
        ]) as Record<string, boolean>;
        return SPEC.recurringEvents.map((_, e) => Boolean(res[`event_${e}`]));
    });
    // 情节序号：标注为"新开始"的片段计数；紧邻的上一段也被标注时视为延续，不重复计数
    return SPEC.recurringEvents.map((_, e) => {
        const episodes: { chunk: Chunk; ordinal: number }[] = [];
        chunks.forEach((chunk, i) => {
            if (tags[i][e] && !(i > 0 && tags[i - 1][e])) episodes.push({ chunk, ordinal: episodes.length + 1 });
        });
        return episodes;
    });
}

/**
 * 补题（--topup）：筛选（screening.json）与人工核对（manual_review.json）之后，detail / vague 不足目标数量时，
 * 从尚未作为保留题来源的片段补出新题（要求只问与剧情相关的内容），追加到 questions.json。
 * 同一片段已出过的题会作为"需避开"列表交给出题模型。新题之后同样要经过筛选与人工核对。
 */
async function topUp() {
    const { dir, chunks, snapshots } = loadStory(STORY_NAME);
    const file = readJson<{ story: string; version: number; model: string; questions: Question[] }>(join(dir, "questions.json"));
    const screening = readJson<Record<string, { keep: boolean }>>(join(dir, "screening.json"));
    const manual = readJson<Record<string, Record<string, string>>>(join(BENCH_DIR, "manual_review.json"))[STORY_NAME] ?? {};
    const kept = file.questions.filter(q => screening[q.qid]?.keep && !(q.qid in manual));
    const inStory = chunks.filter(c => existsAt(c, snapshots[300])).sort((a, b) => a.start_turn - b.start_turn);
    const outline = outlineOf(inStory);
    const usable = (c: Chunk) => wordCount(chunkContent(c)) >= MIN_WORDS;
    const pools = { early: inStory.filter(c => existsAt(c, snapshots[100])), late: inStory.filter(c => !existsAt(c, snapshots[100])) };
    const OVERGENERATE = 1.5;

    const added: Question[] = [];
    for (const [poolName, poolChunks] of Object.entries(pools) as ["early" | "late", Chunk[]][]) {
        const keptSources = new Set(kept.filter(q => q.pool === poolName).map(q => q.source_id));
        const free = poolChunks.filter(c => usable(c) && !keptSources.has(c.id));
        for (const type of ["detail", "vague"] as const) {
            const deficit = COUNTS[type] - kept.filter(q => q.pool === poolName && q.type === type).length;
            if (deficit <= 0) continue;
            const sources = evenly(free, Math.min(free.length, Math.ceil(deficit * OVERGENERATE)));
            const generated = await mapLimit(sources, 6, async chunk => {
                const avoid = file.questions.filter(q => q.source_id === chunk.id).map(q => q.question);
                return { chunk, q: await ask(outline, TYPE_INSTRUCTIONS[type], chunkContent(chunk), avoid) };
            });
            let n = file.questions.filter(q => q.pool === poolName && q.type === type).length
                + added.filter(q => q.pool === poolName && q.type === type).length;
            for (const { chunk, q } of generated) {
                added.push({
                    qid: `${poolName}-${type}-${++n}`,
                    pool: poolName,
                    type,
                    source_id: chunk.id,
                    source_turns: [chunk.start_turn, chunk.end_turn],
                    question: q.question,
                    expected_answer: q.expected_answer,
                    topup: true,
                } as Question);
            }
            console.log(`${poolName} ${type}: kept ${COUNTS[type] - deficit}/${COUNTS[type]}, generated ${generated.length} top-up candidates`);
        }
    }
    file.questions.push(...added);
    writeJson(join(dir, "questions.json"), file);
    console.log(`appended ${added.length} top-up questions`);
}

async function main() {
    if (process.argv.includes("--topup")) return topUp();
    const { dir, chunks, snapshots } = loadStory(STORY_NAME);
    const inStory = chunks.filter(c => existsAt(c, snapshots[300])).sort((a, b) => a.start_turn - b.start_turn);
    const usable = (c: Chunk) => wordCount(chunkContent(c)) >= MIN_WORDS;
    const pools = {
        early: inStory.filter(c => existsAt(c, snapshots[100])),
        late: inStory.filter(c => !existsAt(c, snapshots[100])),
    };
    const outline = outlineOf(inStory);
    console.log(`chunks: ${inStory.length} (early ${pools.early.length}, late ${pools.late.length}); usable early ${pools.early.filter(usable).length}, late ${pools.late.filter(usable).length}`);

    const episodes = await tagEpisodes(inStory);
    writeJson(join(dir, "events.json"), {
        version: 2,
        events: SPEC.recurringEvents,
        episodes: episodes.map(list => list.map(ep => ({ ordinal: ep.ordinal, id: ep.chunk.id, turns: [ep.chunk.start_turn, ep.chunk.end_turn] }))),
    });
    episodes.forEach((list, e) => console.log(`event ${e} "${SPEC.recurringEvents[e]}": ${list.length} episodes`));

    const questions: Question[] = [];
    for (const [poolName, poolChunks] of Object.entries(pools) as ["early" | "late", Chunk[]][]) {
        const sources = poolChunks.filter(usable);
        const n = COUNTS.detail + COUNTS.vague;
        const picked = sources.length >= n ? evenly(sources, n) : Array.from({ length: n }, (_, i) => sources[i % sources.length]);
        const vagueSlots = new Set(evenly([...Array(n).keys()], COUNTS.vague));
        const plain = picked.map((chunk, i) => ({ chunk, type: (vagueSlots.has(i) ? "vague" : "detail") as QuestionType, event: undefined as number | undefined, ordinal: undefined as number | undefined }));

        // temporal：early 池取第 1、2 次，late 池取第 3~5 次；每段情节至多 2 题
        const candidates = episodes.flatMap((list, e) => list
            .filter(ep => ep.ordinal <= MAX_ORDINAL && usable(ep.chunk) && poolChunks.includes(ep.chunk))
            .filter(ep => poolName === "early" ? ep.ordinal <= 2 : ep.ordinal >= 3)
            .map(ep => ({ chunk: ep.chunk, type: "temporal" as QuestionType, event: e, ordinal: ep.ordinal })))
            .sort((a, b) => a.chunk.start_turn - b.chunk.start_turn);
        const temporal = candidates.length >= COUNTS.temporal
            ? evenly(candidates, COUNTS.temporal)
            : Array.from({ length: Math.min(COUNTS.temporal, candidates.length * 2) }, (_, i) => candidates[i % candidates.length]);

        // 按来源片段分组：同一片段的多道题按顺序出（后一题避开前一题问过的细节），不同片段之间并行
        const jobs = [...plain, ...temporal].map((job, order) => ({ ...job, order }));
        const groups = [...new Set(jobs.map(j => j.chunk.id))].map(id => jobs.filter(j => j.chunk.id === id));
        const generated = (await mapLimit(groups, 6, async group => {
            const asked: string[] = [];
            const out: { order: number; job: typeof jobs[number]; q: z.infer<typeof QuestionSchema> }[] = [];
            for (const job of group) {
                const instructions = job.type === "temporal"
                    ? `This passage shows the ${ORDINALS[job.ordinal! - 1]} distinct episode (counted from the start of the story) of a recurring event: "${SPEC.recurringEvents[job.event!]}". Ask about a specific detail of this episode, identifying it ONLY by the event type and its ordinal ("the ${ORDINALS[job.ordinal! - 1]} time ..."). Do not mention other details that would identify it without the ordinal.`
                    : TYPE_INSTRUCTIONS[job.type as "detail" | "vague"];
                const q = await ask(outline, instructions, chunkContent(job.chunk), asked);
                asked.push(q.question);
                out.push({ order: job.order, job, q });
            }
            return out;
        })).flat().sort((a, b) => a.order - b.order);

        for (const { job, q } of generated) {
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
        console.log(`${poolName}: ${plain.length + temporal.length} questions (${candidates.length} temporal episode candidates)`);
    }

    writeJson(join(dir, "questions.json"), { story: STORY_NAME, version: 2, model: QUESTION_MODEL, questions });
    console.log(`saved ${questions.length} questions`);
}

main().catch(e => { console.error(e); process.exit(1); });
