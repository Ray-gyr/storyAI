/**
 * 基准测试 · 剧情推进检查（写作 prompt 的"Story Drive"规则）
 *
 * 试玩反馈：剧情没有引导性，每轮只是"没有人出现""一切安静"，结尾复述现状。
 * 从开发、测试故事的第 100 / 200 / 300 回合快照出发，各连续玩 TURNS 回合，新旧写作 prompt 各跑一遍：
 *   - 玩家：被动型自动玩家（gpt-4o-mini），只对叙述者给出的情况做简单反应，或问"接下来能做什么"，
 *     不自己推进目标（基准测试的自动玩家会主动推进章节目标，测不出叙述者的引导）
 *   - 检索：线上 retrieveMemories（只用快照时已有的片段）；世界状态不随回合更新（只玩几回合，影响小）
 *   - 裁判：gpt-6-luna，3 票多数，逐回合判断：
 *       new_development  解决玩家行动之外，有没有带出推动剧情的新进展
 *       forward_ending   结尾是否指向下一步（可回应或追查的新情况），而不是复述现状
 *       crisis_ending    结尾是否是迫在眉睫的危险（不能回到修改节奏前的 72%）
 *
 * 运行：npx tsx --env-file=.env scripts/eval/benchmark/drive_check.ts [turns]
 * 输出：out/drive_check.json
 */
import { StringOutputParser } from "@langchain/core/output_parsers";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { ChatOpenAI } from "@langchain/openai";
import { join } from "node:path";
import { z } from "zod";
import { retrieveMemories, startDenseSearch } from "../../../src/lib/hybridRetriever";
import { getStoryLLM } from "../../../src/lib/Init";
import { ChatTurn } from "../../../src/lib/memoryManager";
import { storyWorkerPrompt } from "../../../src/lib/prompt";
import { translateUserIntent } from "../../../src/lib/query";
import { writerPromptInputs } from "../../../src/lib/storyGenerator";
import { PRE_DRIVE_STORY_WORKER_SYSTEM_TEMPLATE } from "../legacy_prompts";
import { BENCH_DIR, loadStory, mapLimit, SNAPSHOTS, wordCount, writeJson } from "./common";
import { STORIES } from "./stories";

const TURNS = Number(process.argv[2] || 6);
const VOTES = 3;

const prompts = {
    before: ChatPromptTemplate.fromMessages([
        ["system", PRE_DRIVE_STORY_WORKER_SYSTEM_TEMPLATE],
        new MessagesPlaceholder("chatHistory"),
        ["human", "{input}"],
    ]),
    after: storyWorkerPrompt,
};

const playerLLM = new ChatOpenAI({ modelName: "gpt-4o-mini", temperature: 0.9, openAIApiKey: process.env.OPENAI_API_KEY });
const judgeLLM = new ChatOpenAI({ modelName: "gpt-6-luna", openAIApiKey: process.env.OPENAI_API_KEY })
    .withStructuredOutput(z.object({
        reasoning: z.string().describe("One or two sentences."),
        new_development: z.boolean().describe("Besides resolving the player's action, does the turn introduce something new that moves the story forward: a new person, a lead or information, an opportunity, a rival's move, a deadline, or a consequence of an earlier choice? Atmosphere, 'no one appears' or 'it stays quiet' do not count."),
        forward_ending: z.boolean().describe("Does the last paragraph end on something new the player can respond to or pursue, rather than restating the current situation (e.g. 'the door is shut and the tools are in your hands')?"),
        crisis_ending: z.boolean().describe("Does it end in immediate danger (an attack, a threat closing in, a collapse) that demands a reaction right now?"),
    }));

async function passivePlayer(protagonist: string, lastNarration: string): Promise<string> {
    const msg = await playerLLM.invoke([
        ["system", `You are a casual player in a text adventure, playing ${protagonist}. You do not plan ahead or set your own goals. Reply with ONE short action (max 12 words): pick one of the options the narrator offered, do the obvious simple thing, or ask "what can I do next?" or about an item you have. No narration, no quotes.`],
        ["human", `Narrator:\n${lastNarration}\n\nYour action:`],
    ]);
    return String(msg.content).trim().replace(/^"|"$/g, "");
}

async function judge(framework: string, task: string, previous: string, action: string, response: string) {
    const votes: Awaited<ReturnType<typeof judgeLLM.invoke>>[] = [];
    for (let i = 0; i < VOTES; i++) {
        votes.push(await judgeLLM.invoke([
            ["system", "You review one turn of a text adventure for story momentum."],
            ["human", `STORY FRAMEWORK: ${framework}\nCURRENT TASK: ${task}\n\nPREVIOUS NARRATION:\n${previous}\n\nPLAYER ACTION: ${action}\n\nNARRATOR RESPONSE (judge this):\n${response}`],
        ]));
    }
    const majority = (k: "new_development" | "forward_ending" | "crisis_ending") => votes.filter(v => v[k]).length * 2 > VOTES;
    return { new_development: majority("new_development"), forward_ending: majority("forward_ending"), crisis_ending: majority("crisis_ending"), reasoning: votes[0].reasoning };
}

async function rollout(story: "dev" | "test", round: number, variant: "before" | "after") {
    const { sessionId, snapshots } = loadStory(story);
    const snap = snapshots[round];
    const state = snap.currentState;
    const history: ChatTurn[] = [...snap.chatHistory];
    let turnId = Math.max(0, ...history.map(t => t.turn_id));
    const chain = prompts[variant].pipe(getStoryLLM()).pipe(new StringOutputParser());
    const turns = [];
    for (let t = 0; t < TURNS; t++) {
        const previous = [...history].reverse().find(h => h.role === "assistant")?.text ?? "";
        const action = await passivePlayer(STORIES[story].protagonist, previous);
        const intent = await translateUserIntent(state, history.slice(-3), action).catch(() => null);
        const memories = await retrieveMemories({
            rawInput: action,
            intent: intent ?? { search_query: action, characters_involved: [], items_involved: [], locations_involved: [] },
            dense: startDenseSearch(action, sessionId, { createdBefore: snap.taken_at }),
            sessionId,
            createdBefore: snap.taken_at,
        });
        const response = await chain.invoke(writerPromptInputs({ state, memories, unprocessedArchive: snap.unprocessedArchive, chatHistory: history, input: action }));
        history.push({ turn_id: ++turnId, role: "user", text: action }, { turn_id: ++turnId, role: "assistant", text: response });
        turns.push({ action, response, words: wordCount(response), ...(await judge(state.world_bible.story_framework, state.current_task, previous, action, response)) });
    }
    return { story, round, variant, turns };
}

async function main() {
    const jobs = (["dev", "test"] as const).flatMap(story => SNAPSHOTS.flatMap(round => (["before", "after"] as const).map(variant => ({ story, round, variant }))));
    const runs = await mapLimit(jobs, 6, j => rollout(j.story, j.round, j.variant));
    const summary = Object.fromEntries((["before", "after"] as const).map(v => {
        const turns = runs.filter(r => r.variant === v).flatMap(r => r.turns);
        const rate = (k: "new_development" | "forward_ending" | "crisis_ending") => `${turns.filter(t => t[k]).length}/${turns.length}`;
        const words = turns.map(t => t.words).sort((a, b) => a - b);
        return [v, { new_development: rate("new_development"), forward_ending: rate("forward_ending"), crisis_ending: rate("crisis_ending"), median_words: words[Math.floor(words.length / 2)] }];
    }));
    console.log(JSON.stringify(summary, null, 2));
    writeJson(join(BENCH_DIR, "out", "drive_check.json"), { turns_per_rollout: TURNS, summary, runs });
}

main().catch(e => { console.error(e); process.exit(1); });
