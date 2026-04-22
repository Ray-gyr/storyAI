import { StringOutputParser } from "@langchain/core/output_parsers";
import { MemoryManager } from "./memoryManager";
import { StoryState, StoryStateSchema } from "./currentState";
import { getStoryLLM } from "./Init";
import { storyInitPrompt, storyStartPrompt } from "./prompt";
import { Redis } from "@upstash/redis";
import { z } from "zod";

const redis = Redis.fromEnv();

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

/**
 * 将最新的会话数据同步到 Redis
 */
export async function updateSession(sessionId: string, sessionData: SessionData): Promise<void> {
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
    await redis.set(sessionId, JSON.stringify(payload));
}

/**
 * 删除服务器上的会话数据 (Redis)
 */
export async function deleteSession(sessionId: string): Promise<void> {
    await redis.del(sessionId);
    console.log(`[SessionStore] Deleted session from Redis: ${sessionId}`);
}

/**
 * 开新局：基于用户的初始故事设定 (storySetting)
 * 分别调用 StoryLLM 生成开场白，调用 WorkerLLM (也是 gpt-5-mini) 生成初始状态
 */
export async function createSession(sessionId: string, storySetting: string): Promise<{ sessionData: SessionData, firstPrompt: string }> {
    const memoryManager = new MemoryManager();

    console.log(`[SessionStore] Concurrently initializing state, first story prompt, and metadata...`);
    
    // Setup chains
    const stateLLM = getStoryLLM().withStructuredOutput(StoryStateSchema);
    const stateChain = storyInitPrompt.pipe(stateLLM);
    
    const storyLLM = getStoryLLM().pipe(new StringOutputParser());
    const storyChain = storyStartPrompt.pipe(storyLLM);
    
    const TitleSchema = z.object({
        title: z.string().describe("A concise and catchy short title for the story in English"),
        style: z.string().describe("The genre/style of the story in 2-4 words in English")
    });
    const titleLLM = getStoryLLM().withStructuredOutput(TitleSchema);

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
