/**
 * 基准测试 · 生成故事（见 PROTOCOL.md）
 *
 * 自动玩家 LLM 驱动真实的故事流水线跑 300 回合，并在 SNAPSHOT_ROUNDS 存历史快照：
 * 当时的世界状态、滑动窗口、待归档区、已有记忆片段，以及快照时间戳
 * （评测时用片段的 created_at <= 时间戳 还原"当时已有的片段"）。
 * 结束后导出全部片段（含原文）与完整对话记录。中断后重新运行会从上次进度继续。
 *
 * 前置：本地已启动服务（npx next build && npx next start -p 3123）
 * 运行：npx tsx --env-file=.env scripts/eval/benchmark/generate.ts <dev|test>
 * 输出：scripts/eval/benchmark/out/<story>/{progress.json, snapshot_<round>.json, corpus.json, transcript.json}
 */
import { ChatOpenAI } from "@langchain/openai";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPineconeIndex } from "../../../src/lib/Init";
import { loadIndexedMemories } from "../../../src/lib/memoryStore";
import { redis } from "../../../src/lib/redis";
import { getSession } from "../../../src/lib/sessionStore";
import { ROUNDS_PER_CHAPTER, SNAPSHOT_ROUNDS, STORIES, StorySpec } from "./stories";

const BASE = process.env.EVAL_BASE_URL || "http://localhost:3123";
const STORY = STORIES[process.argv[2] as "dev" | "test"];
if (!STORY) throw new Error("usage: generate.ts <dev|test>");
const TOTAL_ROUNDS = STORY.chapters.length * ROUNDS_PER_CHAPTER;
const OUT_DIR = join(process.cwd(), "scripts", "eval", "benchmark", "out", STORY.name);
/** 每章的第几回合主动触发一次反复事件 */
const RECURRING_EVENT_ROUND_IN_CHAPTER = 12;

const playerLLM = new ChatOpenAI({
    modelName: "gpt-4o-mini",
    openAIApiKey: process.env.OPENAI_API_KEY,
    temperature: 0.9,
});

type Turn = { turn_id: number; role: string; text: string };
type Progress = { sessionId: string; completedRounds: number };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${BASE}${path}`, init);
    if (!res.ok) throw new Error(`${path} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json() as Promise<T>;
}

/** 与 PROTOCOL.md 中描述的自动玩家规则一致；两个故事只有 spec 不同 */
function playerInstructions(spec: StorySpec, round: number, entities: string[]): string {
    const chapterIndex = Math.floor((round - 1) / ROUNDS_PER_CHAPTER);
    const roundInChapter = (round - 1) % ROUNDS_PER_CHAPTER + 1;
    const chapter = spec.chapters[chapterIndex];

    const lines = [
        roundInChapter === 1
            ? `A NEW CHAPTER begins (${chapterIndex + 1}/${spec.chapters.length}). Leave the current scene: travel to ${chapter.location} now and start working on: ${chapter.objective}.`
            : `Current chapter (${chapterIndex + 1}/${spec.chapters.length}): you are at or heading to ${chapter.location}. Goal: ${chapter.objective}.`,
        "Never stay in the same fight, chase, or standoff for more than 3 turns in a row; resolve it decisively (win, escape, surrender, or negotiate) and move on.",
    ];
    if (roundInChapter === RECURRING_EVENT_ROUND_IN_CHAPTER) {
        const event = spec.recurringEvents[chapterIndex % spec.recurringEvents.length];
        lines.push(`This turn, deliberately take an action that leads to: ${event}.`);
    } else if (round % 4 === 0 && entities.length > 0) {
        lines.push(`This turn, follow up on something from EARLIER in the story (not the current scene), involving one of: ${entities.join(", ")}.`);
    }
    return lines.join("\n");
}

async function nextPlayerAction(spec: StorySpec, transcript: Turn[], entities: string[], round: number): Promise<string> {
    const recent = transcript.slice(-4).map(t => `${t.role.toUpperCase()}: ${t.text}`).join("\n\n");
    const msg = await playerLLM.invoke([
        ["system", `You are the player in a text adventure, playing ${spec.protagonist}. Reply with ONE short player action in first person (max 25 words), like a real player typing a command. No narration, no quotes.\n\n${playerInstructions(spec, round, entities)}`],
        ["human", `Recent story:\n${recent}\n\nYour next action:`],
    ]);
    return String(msg.content).trim().replace(/^"|"$/g, "");
}

async function playTurn(sessionId: string, userInput: string): Promise<string> {
    for (let attempt = 1; attempt <= 5; attempt++) {
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

/** 等上一回合的后台收尾（写记忆、存档）完成：会话锁释放即表示完成 */
async function waitForIdle(sessionId: string): Promise<void> {
    for (let i = 0; i < 180; i++) {
        if (!(await redis.exists(`lock:${sessionId}`))) return;
        await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error("session lock not released within 180s");
}

async function takeSnapshot(sessionId: string, round: number): Promise<void> {
    await waitForIdle(sessionId);
    const [session, memories, transcript] = await Promise.all([
        getSession(sessionId),
        loadIndexedMemories(sessionId),
        api<{ transcript: Turn[] }>(`/api/story/load?sessionId=${sessionId}`),
    ]);
    if (!session) throw new Error("session missing at snapshot");
    const snapshot = {
        round,
        taken_at: Date.now(),
        turn_count: transcript.transcript.length,
        last_turn_id: transcript.transcript[transcript.transcript.length - 1]?.turn_id,
        currentState: session.currentState,
        chatHistory: session.memoryManager.chatHistory,
        unprocessedArchive: session.memoryManager.unprocessedArchive,
        chunk_ids: memories.map(m => m.id),
    };
    writeFileSync(join(OUT_DIR, `snapshot_${round}.json`), JSON.stringify(snapshot, null, 2));
    console.log(`snapshot @ round ${round}: ${snapshot.chunk_ids.length} chunks, ${snapshot.turn_count} turns`);
}

async function exportCorpus(sessionId: string): Promise<void> {
    const index = getPineconeIndex().namespace(sessionId);
    const ids: string[] = [];
    let paginationToken: string | undefined;
    do {
        const page = await index.listPaginated({ limit: 100, paginationToken });
        ids.push(...(page.vectors ?? []).map(v => v.id).filter((id): id is string => Boolean(id)));
        paginationToken = page.pagination?.next;
    } while (paginationToken);
    const chunks: Record<string, unknown>[] = [];
    for (let i = 0; i < ids.length; i += 100) {
        const res = await index.fetch({ ids: ids.slice(i, i + 100) });
        for (const [id, record] of Object.entries(res.records ?? {})) chunks.push({ id, ...(record.metadata ?? {}) });
    }
    chunks.sort((a, b) => Number(a.start_turn) - Number(b.start_turn));
    const { transcript } = await api<{ transcript: Turn[] }>(`/api/story/load?sessionId=${sessionId}`);
    writeFileSync(join(OUT_DIR, "corpus.json"), JSON.stringify({ sessionId, story: STORY.name, chunks }, null, 2));
    writeFileSync(join(OUT_DIR, "transcript.json"), JSON.stringify(transcript, null, 2));
    console.log(`exported ${chunks.length} chunks, ${transcript.length} turns`);
}

async function main() {
    mkdirSync(OUT_DIR, { recursive: true });
    const progressPath = join(OUT_DIR, "progress.json");
    let progress: Progress;
    if (existsSync(progressPath)) {
        progress = JSON.parse(readFileSync(progressPath, "utf-8"));
        console.log(`resuming ${progress.sessionId} after round ${progress.completedRounds}`);
    } else {
        const { sessionId } = await api<{ sessionId: string }>("/api/story/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ storySetting: STORY.setting }),
        });
        progress = { sessionId, completedRounds: 0 };
        writeFileSync(progressPath, JSON.stringify(progress));
        console.log(`started ${STORY.name} story: sessionId=${sessionId}`);
    }

    let entities: string[] = [];
    for (let round = progress.completedRounds + 1; round <= TOTAL_ROUNDS; round++) {
        const { transcript } = await api<{ transcript: Turn[] }>(`/api/story/load?sessionId=${progress.sessionId}`);
        if (round % 5 === 1 || entities.length === 0) {
            const detail = await api<{ currentState?: { known_characters: { name: string }[]; known_locations: { name: string }[]; known_items: { name: string }[] } }>(`/api/detail?sessionId=${progress.sessionId}`);
            const s = detail.currentState;
            entities = s ? [...s.known_characters, ...s.known_locations, ...s.known_items].map(e => e.name) : [];
        }
        const action = await nextPlayerAction(STORY, transcript, entities, round);
        const reply = await playTurn(progress.sessionId, action);
        progress.completedRounds = round;
        writeFileSync(progressPath, JSON.stringify(progress));
        console.log(`[${round}/${TOTAL_ROUNDS}] ${action}  ->  ${reply.length} chars`);
        if (SNAPSHOT_ROUNDS.includes(round)) await takeSnapshot(progress.sessionId, round);
    }

    await waitForIdle(progress.sessionId);
    await exportCorpus(progress.sessionId);
    console.log("done");
}

main().catch(e => { console.error(e); process.exit(1); });
