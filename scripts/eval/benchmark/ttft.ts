/**
 * 线上首字延迟（TTFT）测量
 *
 * TTFT = 客户端发出 POST /api/story/chat 到收到第一段非空文本（接口在模型吐出第一段后才返回响应）。
 * 对线上地址新建 SESSIONS 个故事，各连续玩 ROUNDS 回合（自动玩家，每 5 回合问一次过去的事）：
 *   - 第 1 回合可能是冷启动，单独报告
 *   - 第 2~20 回合：记忆片段还很少（窗口 5 + 待归档 10 回合后才开始切片）
 *   - 第 21~ROUNDS 回合：已有记忆片段，检索在真正工作 —— 主要报告这一段的 p50 / p95
 * 每回合发出前等会话锁释放（上一回合的后台收尾结束），避免请求在服务器端排队等锁；
 * 本地 .env 的 Redis 与线上不是同一个库时，改为固定等待 IDLE_FALLBACK_MS。
 * 测完删除测试会话。
 *
 * 运行：npx tsx --env-file=.env scripts/eval/benchmark/ttft.ts [baseUrl] [rounds] [sessions]
 * 输出：out/ttft.json
 */
import { ChatOpenAI } from "@langchain/openai";
import { join } from "node:path";
import { DEFAULT_STORY_SETTING } from "../../../src/lib/constants";
import { redis } from "../../../src/lib/redis";
import { getSession } from "../../../src/lib/sessionStore";
import { BENCH_DIR, writeJson } from "./common";

const BASE = process.argv[2] || "https://story-ai-ray.vercel.app";
const ROUNDS = Number(process.argv[3] || 40);
const SESSIONS = Number(process.argv[4] || 2);
const IDLE_FALLBACK_MS = 15_000;

const SETTINGS = [
    DEFAULT_STORY_SETTING,
    "A low-fantasy expedition. The protagonist, a cartographer named Edda Voss, leads a small caravan across a cursed salt desert to deliver a sealed reliquary to a mountain monastery, while a rival mercenary company tries to steal it. Grounded, tense, practical tone.",
];

const playerLLM = new ChatOpenAI({ modelName: "gpt-4o-mini", temperature: 0.9, openAIApiKey: process.env.OPENAI_API_KEY });

type TurnTiming = { round: number; input: string; ttft_ms: number; total_ms: number; chars: number; lock_retries: number };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function playerAction(lastNarration: string, round: number): Promise<string> {
    const rule = round % 5 === 0
        ? "This turn, ask the narrator about something that happened EARLIER in the story (a person, an item, a decision)."
        : "Take a reasonable action that moves toward your goal.";
    const msg = await playerLLM.invoke([
        ["system", `You are the player in a text adventure. Reply with ONE short player action in first person (max 20 words), like a real player typing. No narration, no quotes. ${rule}`],
        ["human", `Narrator:\n${lastNarration}\n\nYour action:`],
    ]);
    return String(msg.content).trim().replace(/^"|"$/g, "");
}

async function waitForIdle(sessionId: string, sharedRedis: boolean) {
    if (!sharedRedis) return sleep(IDLE_FALLBACK_MS);
    for (let i = 0; i < 120; i++) {
        if (!(await redis.exists(`lock:${sessionId}`))) return;
        await sleep(1000);
    }
}

/** 发一回合并计时；409（锁未释放）时等待重试，重试等待不计入 TTFT */
async function timedTurn(sessionId: string, userInput: string): Promise<{ ttft: number; total: number; text: string; retries: number }> {
    for (let retries = 0; ; retries++) {
        const t0 = performance.now();
        const res = await fetch(`${BASE}/api/story/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId, userInput }),
        });
        if (res.status === 409 && retries < 10) { await res.text(); await sleep(2000); continue; }
        if (!res.ok || !res.body) throw new Error(`chat HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let ttft: number | null = null;
        let text = "";
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            if (ttft === null && chunk.trim().length > 0) ttft = performance.now() - t0;
            text += chunk;
        }
        return { ttft: ttft ?? performance.now() - t0, total: performance.now() - t0, text, retries };
    }
}

async function runSession(index: number): Promise<{ sessionId: string; shared_redis: boolean; turns: TurnTiming[] }> {
    const start = await fetch(`${BASE}/api/story/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storySetting: SETTINGS[index % SETTINGS.length] }),
    });
    if (!start.ok) throw new Error(`start HTTP ${start.status}: ${(await start.text()).slice(0, 200)}`);
    const { sessionId, firstPrompt } = await start.json() as { sessionId: string; firstPrompt: string };
    const sharedRedis = Boolean(await getSession(sessionId).catch(() => null));
    console.log(`[session ${index}] ${sessionId} (local Redis ${sharedRedis ? "is" : "is NOT"} the production DB)`);

    const turns: TurnTiming[] = [];
    let last = firstPrompt;
    try {
        for (let round = 1; round <= ROUNDS; round++) {
            const input = await playerAction(last, round);
            await waitForIdle(sessionId, sharedRedis);
            const { ttft, total, text, retries } = await timedTurn(sessionId, input);
            turns.push({ round, input, ttft_ms: Math.round(ttft), total_ms: Math.round(total), chars: text.length, lock_retries: retries });
            console.log(`[session ${index}] round ${round}: TTFT ${(ttft / 1000).toFixed(2)}s, total ${(total / 1000).toFixed(2)}s${retries ? `, ${retries} lock retries` : ""}`);
            last = text;
        }
    } finally {
        await waitForIdle(sessionId, sharedRedis);
        await fetch(`${BASE}/api/story/delete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId }),
        }).catch(e => console.error("delete failed", e));
    }
    return { sessionId, shared_redis: sharedRedis, turns };
}

function stats(values: number[]) {
    const s = [...values].sort((a, b) => a - b);
    const q = (p: number) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
    return s.length ? { n: s.length, p50_s: +(q(0.5) / 1000).toFixed(2), p95_s: +(q(0.95) / 1000).toFixed(2), max_s: +(s[s.length - 1] / 1000).toFixed(2) } : null;
}

async function main() {
    const sessions = await Promise.all(Array.from({ length: SESSIONS }, (_, i) => runSession(i)));
    const all = sessions.flatMap(s => s.turns);
    const band = (lo: number, hi: number) => all.filter(t => t.round >= lo && t.round <= hi);
    const summary = {
        base: BASE,
        measured_at: new Date().toISOString(),
        first_turn_cold: stats(band(1, 1).map(t => t.ttft_ms)),
        ttft_rounds_2_20: stats(band(2, 20).map(t => t.ttft_ms)),
        ttft_rounds_21_plus: stats(band(21, ROUNDS).map(t => t.ttft_ms)),
        ttft_recall_questions_21_plus: stats(band(21, ROUNDS).filter(t => t.round % 5 === 0).map(t => t.ttft_ms)),
        total_rounds_21_plus: stats(band(21, ROUNDS).map(t => t.total_ms)),
        lock_retries: all.reduce((a, t) => a + t.lock_retries, 0),
    };
    console.log(JSON.stringify(summary, null, 2));
    writeJson(join(BENCH_DIR, "out", "ttft.json"), { summary, sessions });
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
