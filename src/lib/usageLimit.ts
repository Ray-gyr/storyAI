/**
 * Token 用量限制：保护 API 账单，防止滥用
 *
 * 两层上限（都按模型实际返回的 token 用量计，含输入、输出与推理 token；向量嵌入不计）：
 *   - 每个客户端（按 IP）每个时间窗口的上限：超出后要等到本窗口结束才能继续
 *   - 全站每天（UTC）的总上限：防止换 IP 刷量
 * 每回合开始前检查（聊天、开新故事），超限的请求直接返回 429，不调用任何模型。
 * 当前回合不会被中途打断，所以实际用量可能略超上限（最多一回合）。
 *
 * 归属：路由用 runWithUsageClient 包住处理过程；模型调用开始时（handleLLMStart，仍在请求的异步上下文里）
 * 记下这次调用属于哪个客户端，结束时（handleLLMEnd，可能已在流式输出或 after() 收尾里）按记录记账。
 *
 * 上限可用环境变量调整：USAGE_CLIENT_TOKENS_PER_WINDOW、USAGE_WINDOW_MINUTES、USAGE_DAILY_TOKENS
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { LLMResult } from "@langchain/core/outputs";
import { redis } from "./redis";

const envNumber = (name: string, fallback: number) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const USAGE_LIMITS = {
    /** 每个客户端每个窗口的 token 上限 */
    clientTokensPerWindow: envNumber("USAGE_CLIENT_TOKENS_PER_WINDOW", 1_000_000),
    windowMinutes: envNumber("USAGE_WINDOW_MINUTES", 60),
    /** 全站每天的 token 上限 */
    dailyTokens: envNumber("USAGE_DAILY_TOKENS", 30_000_000),
};

const usageContext = new AsyncLocalStorage<{ clientId: string }>();

/** 在该客户端的用量上下文里执行（其中发起的模型调用都记到这个客户端名下） */
export function runWithUsageClient<T>(clientId: string, fn: () => T): T {
    return usageContext.run({ clientId }, fn);
}

/** 客户端标识：Vercel 会在 x-forwarded-for 的第一项给出真实 IP */
export function clientIdFrom(req: Request): string {
    const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    return forwarded || req.headers.get("x-real-ip") || "local";
}

function windowInfo(now = Date.now()) {
    const windowMs = USAGE_LIMITS.windowMinutes * 60_000;
    const index = Math.floor(now / windowMs);
    return { index, resetsInMs: (index + 1) * windowMs - now, ttlSeconds: Math.ceil(windowMs / 1000) + 60 };
}

function dayInfo(now = Date.now()) {
    const day = new Date(now).toISOString().slice(0, 10);
    const nextMidnight = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1);
    return { day, resetsInMs: nextMidnight - now };
}

const clientKey = (clientId: string, index: number) => `usage:client:${clientId}:${index}`;
const dayKey = (day: string) => `usage:day:${day}`;

const minutesText = (ms: number) => {
    const minutes = Math.max(1, Math.ceil(ms / 60_000));
    return minutes >= 60 ? `${Math.ceil(minutes / 60)} hour${minutes > 60 ? "s" : ""}` : `${minutes} minute${minutes > 1 ? "s" : ""}`;
};

export type UsageCheck = { allowed: true } | { allowed: false; retryAfterSeconds: number; message: string };

/** 回合开始前检查；Redis 出错时放行（不因限流故障让游戏不可用） */
export async function checkUsage(clientId: string): Promise<UsageCheck> {
    const win = windowInfo();
    const day = dayInfo();
    try {
        const [clientUsed, dayUsed] = await Promise.all([
            redis.get<number>(clientKey(clientId, win.index)),
            redis.get<number>(dayKey(day.day)),
        ]);
        if ((dayUsed ?? 0) >= USAGE_LIMITS.dailyTokens) {
            return {
                allowed: false,
                retryAfterSeconds: Math.ceil(day.resetsInMs / 1000),
                message: `This demo has reached its daily usage budget. Please come back in ${minutesText(day.resetsInMs)}.`,
            };
        }
        if ((clientUsed ?? 0) >= USAGE_LIMITS.clientTokensPerWindow) {
            return {
                allowed: false,
                retryAfterSeconds: Math.ceil(win.resetsInMs / 1000),
                message: `You've reached the usage limit for now. Please take a break and come back in ${minutesText(win.resetsInMs)}.`,
            };
        }
    } catch (e) {
        console.error("[UsageLimit] Check failed, allowing the request:", e);
    }
    return { allowed: true };
}

/** 超限时的响应（429 + Retry-After），聊天接口返回纯文本，前端直接显示 */
export function usageLimitResponse(check: Extract<UsageCheck, { allowed: false }>): Response {
    return new Response(check.message, {
        status: 429,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": String(check.retryAfterSeconds) },
    });
}

async function recordUsage(clientId: string, tokens: number): Promise<void> {
    if (!(tokens > 0)) return;
    const win = windowInfo();
    const day = dayInfo();
    const tx = redis.multi();
    tx.incrby(clientKey(clientId, win.index), tokens);
    tx.expire(clientKey(clientId, win.index), win.ttlSeconds);
    tx.incrby(dayKey(day.day), tokens);
    tx.expire(dayKey(day.day), 2 * 24 * 3600);
    await tx.exec();
}

/** 挂在所有 ChatOpenAI 上的回调：按调用开始时的客户端记账 */
class UsageTracker extends BaseCallbackHandler {
    name = "usage-tracker";
    /** 同步执行回调，保证 handleLLMStart 在发起调用的请求上下文里运行 */
    awaitHandlers = true;
    private owners = new Map<string, string>();

    private remember(runId: string) {
        const clientId = usageContext.getStore()?.clientId;
        if (clientId) this.owners.set(runId, clientId);
    }

    async handleLLMStart(_llm: unknown, _prompts: string[], runId: string) {
        this.remember(runId);
    }

    async handleChatModelStart(_llm: unknown, _messages: unknown, runId: string) {
        this.remember(runId);
    }

    async handleLLMEnd(output: LLMResult, runId: string) {
        // 不在请求上下文里的调用（评测脚本等）不计入，避免占用线上额度
        const clientId = this.owners.get(runId);
        this.owners.delete(runId);
        if (!clientId) return;
        const message = (output.generations?.[0]?.[0] as { message?: { usage_metadata?: { total_tokens?: number } } } | undefined)?.message;
        const tokens = message?.usage_metadata?.total_tokens ?? output.llmOutput?.tokenUsage?.totalTokens ?? 0;
        await recordUsage(clientId, tokens).catch(e => console.error("[UsageLimit] Failed to record usage:", e));
    }

    async handleLLMError(_err: unknown, runId: string) {
        this.owners.delete(runId);
    }
}

export const usageTracker = new UsageTracker();
