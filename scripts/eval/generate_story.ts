/**
 * 检索实验 · 数据生成：用一个"自动玩家" LLM 驱动真实的故事流水线，生成一个约 100 回合的新故事。
 *
 * 前置：本地已启动服务（npx next build && npx next start -p 3123）
 * 运行：npx tsx --env-file=.env scripts/eval/generate_story.ts [rounds]
 * 输出：scripts/eval/out/session.json（记录 sessionId，后续脚本使用）
 */
import { ChatOpenAI } from "@langchain/openai";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.EVAL_BASE_URL || "http://localhost:3123";
const ROUNDS = Number(process.argv[2] || 100);
const OUT_DIR = join(process.cwd(), "scripts", "eval", "out");

// 刻意设计多个具名角色、地点、物品，让实体在故事中反复出现
const STORY_SETTING = `A rain-soaked harbor city called Greyhaven, ruled by three rival merchant guilds.
The player is Mara Voss, a disgraced former guild investigator who now works as a smuggler's fixer.
Her old partner, Captain Ilya Renn of the Harbor Watch, has been found dead in the Saltmarket with a black wax seal in his hand.
Key figures: Old Tobin (a blind fence who runs the Lantern Pawnshop), Sister Elka (a healer at the Drowned Chapel), Lord Casimir Vael (head of the Vael Guild), and Jory (a street kid who carries messages).
Key places: the Saltmarket, the Lantern Pawnshop, the Drowned Chapel, the Vael counting house, the old lighthouse, the Sunken Docks.
Mara carries a brass lockpick set, a cracked spyglass, and Ilya's black wax seal.
Grounded noir mystery with political intrigue, no magic.`;

const playerLLM = new ChatOpenAI({
    modelName: "gpt-4o-mini",
    openAIApiKey: process.env.OPENAI_API_KEY,
    temperature: 0.9,
});

type Turn = { turn_id: number; role: string; text: string };

async function startStory(): Promise<{ sessionId: string; firstPrompt: string }> {
    const res = await fetch(`${BASE}/api/story/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storySetting: STORY_SETTING }),
    });
    if (!res.ok) throw new Error(`start failed: HTTP ${res.status} ${await res.text()}`);
    return res.json();
}

async function loadTranscript(sessionId: string): Promise<Turn[]> {
    const res = await fetch(`${BASE}/api/story/load?sessionId=${sessionId}`);
    if (!res.ok) throw new Error(`load failed: HTTP ${res.status}`);
    return (await res.json()).transcript;
}

async function loadKnownEntities(sessionId: string): Promise<string[]> {
    const res = await fetch(`${BASE}/api/detail?sessionId=${sessionId}`);
    if (!res.ok) return [];
    const s = (await res.json()).currentState;
    if (!s) return [];
    return [...s.known_characters, ...s.known_locations, ...s.known_items].map((e: { name: string }) => e.name);
}

async function nextPlayerAction(transcript: Turn[], entities: string[], round: number): Promise<string> {
    const recent = transcript.slice(-4).map(t => `${t.role.toUpperCase()}: ${t.text}`).join("\n\n");
    // 每隔几回合要求回到早先出现过的人/物/地点，制造"回忆型"情节，便于后续出检索题
    const revisit = round % 4 === 0
        ? `This turn, deliberately return to or follow up on something from EARLIER in the story (not the current scene): pick one of these known entities and act on it: ${entities.join(", ")}.`
        : "Advance the investigation with a concrete, decisive action.";

    const msg = await playerLLM.invoke([
        ["system", `You are the player in a text adventure, playing Mara Voss. Reply with ONE short player action in first person (max 25 words), like a real player typing a command. No narration, no quotes. ${revisit}`],
        ["human", `Recent story:\n${recent}\n\nYour next action:`],
    ]);
    return String(msg.content).trim().replace(/^"|"$/g, "");
}

async function playTurn(sessionId: string, userInput: string): Promise<string> {
    for (let attempt = 1; attempt <= 4; attempt++) {
        const res = await fetch(`${BASE}/api/story/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId, userInput }),
        });
        if (res.ok) return res.text();
        console.warn(`  chat HTTP ${res.status} (attempt ${attempt}): ${(await res.text()).slice(0, 120)}`);
        await new Promise(r => setTimeout(r, 5000 * attempt));
    }
    throw new Error("chat failed after retries");
}

async function main() {
    mkdirSync(OUT_DIR, { recursive: true });
    const { sessionId } = await startStory();
    writeFileSync(join(OUT_DIR, "session.json"), JSON.stringify({ sessionId, rounds: ROUNDS, setting: STORY_SETTING }, null, 2));
    console.log(`sessionId=${sessionId}`);

    let entities: string[] = [];
    for (let round = 1; round <= ROUNDS; round++) {
        const transcript = await loadTranscript(sessionId);
        if (round % 5 === 1) entities = await loadKnownEntities(sessionId);
        const action = await nextPlayerAction(transcript, entities, round);
        const reply = await playTurn(sessionId, action);
        console.log(`[${round}/${ROUNDS}] ${action}  →  ${reply.length} chars`);
    }
    console.log("done");
}

main().catch(e => { console.error(e); process.exit(1); });
