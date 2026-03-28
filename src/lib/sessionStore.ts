import { StringOutputParser } from "@langchain/core/output_parsers";
import { MemoryManager } from "./memoryManager";
import { StoryState, StoryStateSchema } from "./currentState";
import { getStoryLLM } from "./Init";
import { storyInitPrompt, storyStartPrompt } from "./prompt";

export interface SessionData {
    memoryManager: MemoryManager;
    currentState: StoryState;
}

// 使用 globalThis 防止 Next.js 开发环境下热更新 (Fast Refresh) 导致模块缓存被清空而丢失数据
const _global = globalThis as any;
if (!_global.sessionsMap) {
    _global.sessionsMap = new Map<string, SessionData>();
}
const sessions: Map<string, SessionData> = _global.sessionsMap;

export function getSession(sessionId: string): SessionData | undefined {
    return sessions.get(sessionId);
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

    const sessionData = { memoryManager, currentState };
    sessions.set(sessionId, sessionData);
    
    return { sessionData, firstPrompt };
}
