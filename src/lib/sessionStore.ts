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

    // 1. WorkerLLM (gpt-5-mini) -> 生成初始 CurrentState
    console.log(`[SessionStore] Initializing state with gpt-5-mini (Worker role)...`);
    const stateLLM = getStoryLLM().withStructuredOutput(StoryStateSchema);
    const stateChain = storyInitPrompt.pipe(stateLLM);

    const currentState = await stateChain.invoke({
        text: storySetting
    });

    // 2. StoryLLM (gpt-5-mini) -> 生成第一段剧情导引 (First Prompt)
    console.log(`[SessionStore] Generating first story prompt with gpt-5-mini (Story role)...`);
    const storyLLM = getStoryLLM().pipe(new StringOutputParser());
    const storyChain = storyStartPrompt.pipe(storyLLM);

    const firstPrompt = await storyChain.invoke({
        storySetting: storySetting
    });

    // 3. Generate Title and Style
    console.log(`[SessionStore] Generating story title and style...`);
    const TitleSchema = z.object({
        title: z.string().describe("A concise and catchy short title for the story in English"),
        style: z.string().describe("The genre/style of the story in 2-4 words in English")
    });

    let metadata = { title: sessionId.slice(-6), style: "UNKNOWN" };
    try {
        const titleLLM = getStoryLLM().withStructuredOutput(TitleSchema);
        const titleResult = await titleLLM.invoke(
            `Based on the following story setting or background, generate a highly concise and catchy title (2-6 words) and a short genre/style label (2-4 words).\n\nSetting:\n${storySetting}`
        );
        metadata = titleResult;
    } catch (e) {
        console.warn("[SessionStore] Failed to generate title, falling back to defaults", e);
    }

    const sessionData: SessionData = { memoryManager, currentState, metadata };

    // 立即保存到 Redis
    await updateSession(sessionId, sessionData);

    return { sessionData, firstPrompt };
}
