import { StringOutputParser } from "@langchain/core/output_parsers";
import { MemoryManager, ChatTurn } from "./memoryManager";
import { StoryState, StoryStateSchema } from "./currentState";
import { getSetupLLM, getStoryLLM } from "./Init";
import { storyInitPrompt, storyStartPrompt } from "./prompt";
import { redis } from "./redis";
import { z } from "zod";


export interface SessionData {
    memoryManager: MemoryManager;
    currentState: StoryState;
    metadata?: {
        title: string;
        style: string;
    };
}

interface SerializedSessionData {
    memoryManager: {
        chatHistory: any[];
        unprocessedArchive: any[];
        lastProcessedOverlapTurns: any[];
    };
    currentState: StoryState;
    metadata?: {
        title: string;
        style: string;
    };
}

/**
 * 从 Redis 获取会话数据并反序列化实例化
 */
export async function getSession(sessionId: string): Promise<SessionData | null> {
    const rawData = await redis.get<SerializedSessionData>(sessionId);
    if (!rawData) return null;

    // Rehydrate MemoryManager
    const memoryManager = new MemoryManager();
    if (rawData.memoryManager) {
        memoryManager.chatHistory = rawData.memoryManager.chatHistory || [];
        memoryManager.unprocessedArchive = rawData.memoryManager.unprocessedArchive || [];
        (memoryManager as any).lastProcessedOverlapTurns = rawData.memoryManager.lastProcessedOverlapTurns || [];
    }

    return {
        memoryManager,
        currentState: rawData.currentState,
        metadata: rawData.metadata
    };
}

// 完整对话记录单独存成 Redis List：每回合只 RPUSH 新增的轮次，
// 不随存档主体一起反复重写，存档主体只保留滑动窗口和待归档区
const transcriptKey = (sessionId: string) => `transcript:${sessionId}`;

/**
 * 读取完整对话记录（按 turn 顺序）
 */
export async function getTranscript(sessionId: string): Promise<ChatTurn[]> {
    return redis.lrange<ChatTurn>(transcriptKey(sessionId), 0, -1);
}

/**
 * 完整对话记录当前的轮数（用于判断旧存档是否还没有对话记录）
 */
export async function getTranscriptLength(sessionId: string): Promise<number> {
    return redis.llen(transcriptKey(sessionId));
}

/**
 * 将最新的会话数据同步到 Redis
 * @param newTurns 本次新增的对话轮次，会和存档主体在同一个事务里追加到完整对话记录
 */
export async function updateSession(sessionId: string, sessionData: SessionData, newTurns: ChatTurn[] = []): Promise<void> {
    const payload: SerializedSessionData = {
        memoryManager: {
            chatHistory: sessionData.memoryManager.chatHistory,
            unprocessedArchive: sessionData.memoryManager.unprocessedArchive,
            lastProcessedOverlapTurns: (sessionData.memoryManager as any).lastProcessedOverlapTurns,
        },
        currentState: sessionData.currentState,
        metadata: sessionData.metadata
    };
    // Store in Redis (permanent storage for story)
    if (newTurns.length === 0) {
        await redis.set(sessionId, JSON.stringify(payload));
        return;
    }

    // 存档主体与对话记录要么一起写入，要么都不写，避免两者轮次对不上
    const tx = redis.multi();
    tx.set(sessionId, JSON.stringify(payload));
    tx.rpush(transcriptKey(sessionId), ...newTurns);
    await tx.exec();
}

/**
 * 删除服务器上的会话数据 (Redis)
 */
export async function deleteSession(sessionId: string): Promise<void> {
    await redis.del(sessionId, transcriptKey(sessionId), lockKey(sessionId));
    console.log(`[SessionStore] Deleted session from Redis: ${sessionId}`);
}

// ==========================================
// 会话锁：保证同一个存档同一时间只有一个回合在 读取 → 生成 → 写回
// 否则玩家在上一回合后台保存完成前发出新指令，会读到旧存档并覆盖掉上一回合
// ==========================================

// 锁的 TTL 覆盖一次 Serverless 函数的最长生命周期，函数被强杀时锁也会自动过期
const LOCK_TTL_MS = 65_000;
const LOCK_POLL_INTERVAL_MS = 500;

const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
end
return 0
`;

const lockKey = (sessionId: string) => `lock:${sessionId}`;

/**
 * 尝试获取会话锁，最多等待 waitMs 毫秒
 * @returns 成功时返回锁 token（释放时需要），超时返回 null
 */
export async function acquireSessionLock(sessionId: string, waitMs = 25_000): Promise<string | null> {
    const token = crypto.randomUUID();
    const deadline = Date.now() + waitMs;

    while (true) {
        const result = await redis.set(lockKey(sessionId), token, { nx: true, px: LOCK_TTL_MS });
        if (result === "OK") return token;
        if (Date.now() >= deadline) return null;
        await new Promise(resolve => setTimeout(resolve, LOCK_POLL_INTERVAL_MS));
    }
}

/**
 * 释放会话锁（只释放自己持有的锁，避免误删别人在过期后重新获取的锁）
 */
export async function releaseSessionLock(sessionId: string, token: string): Promise<void> {
    await redis.eval(RELEASE_LOCK_SCRIPT, [lockKey(sessionId)], [token]);
}

/**
 * 开新局：基于用户的初始故事设定 (storySetting)
 * 分别调用 StoryLLM 生成开场白，调用 SetupLLM 生成初始状态与标题
 */
export async function createSession(sessionId: string, storySetting: string): Promise<{ sessionData: SessionData, firstPrompt: string }> {
    const memoryManager = new MemoryManager();

    console.log(`[SessionStore] Concurrently initializing state, first story prompt, and metadata...`);
    
    // Setup chains
    const stateLLM = getSetupLLM().withStructuredOutput(StoryStateSchema);
    const stateChain = storyInitPrompt.pipe(stateLLM);
    
    const storyLLM = getStoryLLM().pipe(new StringOutputParser());
    const storyChain = storyStartPrompt.pipe(storyLLM);
    
    const TitleSchema = z.object({
        title: z.string().describe("A concise and catchy short title for the story in English"),
        style: z.string().describe("The genre/style of the story in 2-4 words in English")
    });
    const titleLLM = getSetupLLM().withStructuredOutput(TitleSchema);

    // Fire all 3 LLM calls concurrently
    const [currentState, firstPrompt, metadata] = await Promise.all([
        stateChain.invoke({ text: storySetting }),
        storyChain.invoke({ storySetting: storySetting }),
        titleLLM.invoke(`Based on the following story setting or background, generate a highly concise and catchy title (2-6 words) and a short genre/style label (2-4 words).\n\nSetting:\n${storySetting}`)
            .catch(e => {
                console.warn("[SessionStore] Failed to generate title concurrently, falling back to defaults", e);
                return { title: sessionId.slice(-6), style: "UNKNOWN" };
            })
    ]);

    const sessionData: SessionData = { memoryManager, currentState, metadata };

    // 立即保存到 Redis
    await updateSession(sessionId, sessionData);

    return { sessionData, firstPrompt };
}
