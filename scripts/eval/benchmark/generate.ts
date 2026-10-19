/**
 * 基准测试 · 生成故事（见 PROTOCOL.md）
 *
 * 自动玩家 LLM 驱动真实的故事流水线跑 300 回合（12 章 x 25 回合）。两类回合由脚本直接写入玩家行动，
 * 不依赖自动玩家（第一版完全交给自动玩家，它在每回合的危机面前忽略了章节指令，场景几乎不切换）：
 *   - 每章第 1 回合：转场（"一段时间后，我前往<地点>去<目标>"）
 *   - 每章第 RECURRING_EVENT_ROUND_IN_CHAPTER 回合：触发该章的反复事件（3 类轮流）
 * 在 SNAPSHOT_ROUNDS 存历史快照：当时的世界状态、滑动窗口、待归档区、已有记忆片段与快照时间戳
 * （评测时用片段的 created_at <= 时间戳 还原"当时已有的片段"）。每回合记录一行 rounds.jsonl（行动、当前地点）。
 * 结束后导出全部片段（含原文）与完整对话记录。中断后重新运行会从上次进度继续。
 *
 * --smoke：4 章 x 8 回合的缩短版，用于验证生成流程（输出到 out/smoke-<story>，不存快照）。
 *
 * 前置：本地已启动服务（npx next build && npx next start -p 3123）
 * 运行：npx tsx --env-file=.env scripts/eval/benchmark/generate.ts <dev|test> [--smoke]
 * 输出：scripts/eval/benchmark/out/<story>/{progress.json, rounds.jsonl, snapshot_<round>.json, corpus.json, transcript.json}
 */
import { ChatOpenAI } from "@langchain/openai";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPineconeIndex } from "../../../src/lib/Init";
import { loadIndexedMemories } from "../../../src/lib/memoryStore";
import { redis } from "../../../src/lib/redis";
import { getSession } from "../../../src/lib/sessionStore";
import { RECURRING_EVENT_ROUND_IN_CHAPTER, ROUNDS_PER_CHAPTER, SNAPSHOT_ROUNDS, STORIES, StorySpec } from "./stories";

const BASE = process.env.EVAL_BASE_URL || "http://localhost:3123";
const STORY = STORIES[process.argv[2] as "dev" | "test"];
if (!STORY) throw new Error("usage: generate.ts <dev|test> [--smoke]");
const SMOKE = process.argv.includes("--smoke");
const CHAPTERS = SMOKE ? 4 : STORY.chapters.length;
const ROUNDS_PER = SMOKE ? 8 : ROUNDS_PER_CHAPTER;
const EVENT_ROUND = SMOKE ? 5 : RECURRING_EVENT_ROUND_IN_CHAPTER;
const SNAPSHOTS = SMOKE ? [] : SNAPSHOT_ROUNDS;
const TOTAL_ROUNDS = CHAPTERS * ROUNDS_PER;
const OUT_DIR = join(process.cwd(), "scripts", "eval", "benchmark", "out", SMOKE ? `smoke-${STORY.name}` : STORY.name);

const playerLLM = new ChatOpenAI({
    modelName: "gpt-4o-mini",
    openAIApiKey: process.env.OPENAI_API_KEY,
    temperature: 0.9,
});

type Turn = { turn_id: number; role: string; text: string };
type Progress = { sessionId: string; completedRounds: number };
type StateSummary = { current_location?: string; known_characters: { name: string }[]; known_locations: { name: string }[]; known_items: { name: string }[] };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${BASE}${path}`, init);
    if (!res.ok) throw new Error(`${path} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json() as Promise<T>;
}

function chapterOf(round: number) {
    return { chapterIndex: Math.floor((round - 1) / ROUNDS_PER), roundInChapter: (round - 1) % ROUNDS_PER + 1 };
}

/** 由脚本直接写入的玩家行动；其余回合返回 null，交给自动玩家 */
function scriptedAction(spec: StorySpec, round: number): string | null {
    const { chapterIndex, roundInChapter } = chapterOf(round);
    const chapter = spec.chapters[chapterIndex];
    if (roundInChapter === 1 && round > 1) return `Some time later, I travel to ${chapter.location} to ${chapter.objective}.`;
    if (roundInChapter === 1) return `I head for ${chapter.location} to ${chapter.objective}.`;
    if (roundInChapter === EVENT_ROUND) return spec.eventTriggers[chapterIndex % spec.eventTriggers.length];
    return null;
}

async function autoPlayerAction(spec: StorySpec, transcript: Turn[], entities: string[], round: number): Promise<string> {
    const { chapterIndex } = chapterOf(round);
    const chapter = spec.chapters[chapterIndex];
    const rules = [
        `Current chapter (${chapterIndex + 1}/${CHAPTERS}): you are at ${chapter.location}. Goal: ${chapter.objective}.`,
        "Prefer actions that advance the chapter goal. If something blocks you, deal with it in one or two turns, then return to the goal.",
        "Never stay in the same fight, chase, or standoff for more than 3 turns in a row; resolve it decisively (win, escape, surrender, or negotiate) and move on.",
    ];
    if (round % 4 === 0 && entities.length > 0) {
        rules.push(`This turn, follow up on something from EARLIER in the story (not the current scene), involving one of: ${entities.join(", ")}.`);
    }
    const recent = transcript.slice(-4).map(t => `${t.role.toUpperCase()}: ${t.text}`).join("\n\n");
    const msg = await playerLLM.invoke([
        ["system", `You are the player in a text adventure, playing ${spec.protagonist}. Reply with ONE short player action in first person (max 25 words), like a real player typing a command. No narration, no quotes.\n\n${rules.join("\n")}`],
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
        console.log(`started ${STORY.name}${SMOKE ? " (smoke)" : ""} story: sessionId=${sessionId}`);
    }

    let entities: string[] = [];
    for (let round = progress.completedRounds + 1; round <= TOTAL_ROUNDS; round++) {
        const { transcript } = await api<{ transcript: Turn[] }>(`/api/story/load?sessionId=${progress.sessionId}`);
        if (round % 5 === 1 || entities.length === 0) {
            const s = (await api<{ currentState?: StateSummary }>(`/api/detail?sessionId=${progress.sessionId}`)).currentState;
            entities = s ? [...s.known_characters, ...s.known_locations, ...s.known_items].map(e => e.name) : [];
        }
        const scripted = scriptedAction(STORY, round);
        const action = scripted ?? await autoPlayerAction(STORY, transcript, entities, round);
        const reply = await playTurn(progress.sessionId, action);
        progress.completedRounds = round;
        writeFileSync(progressPath, JSON.stringify(progress));

        // 记录本回合结束后的地点（等收尾完成，状态才会更新）
        await waitForIdle(progress.sessionId);
        const state = (await api<{ currentState?: StateSummary }>(`/api/detail?sessionId=${progress.sessionId}`)).currentState;
        const { chapterIndex, roundInChapter } = chapterOf(round);
        appendFileSync(join(OUT_DIR, "rounds.jsonl"), JSON.stringify({
            round, chapter: chapterIndex + 1, round_in_chapter: roundInChapter, scripted: scripted !== null,
            action, location: state?.current_location ?? null, reply_chars: reply.length,
        }) + "\n");
        console.log(`[${round}/${TOTAL_ROUNDS}]${scripted ? " (scripted)" : ""} ${action}  ->  ${reply.length} chars @ ${state?.current_location ?? "?"}`);
        if (SNAPSHOTS.includes(round)) await takeSnapshot(progress.sessionId, round);
    }

    await waitForIdle(progress.sessionId);
    await exportCorpus(progress.sessionId);
    console.log("done");
}

main().catch(e => { console.error(e); process.exit(1); });
