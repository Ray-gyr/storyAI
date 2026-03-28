import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { getManagerLLM, getStoryLLM } from "./Init";
import { StoryState, StateChangeSchema, applyStateChanges } from "./currentState";
import { MemoryManager } from "./memoryManager";
import { translateUserIntent } from "./query";
import { retrieveMemories } from "./vectorDBManager";
import { storyWorkerPrompt, storyUpdatePrompt } from "./prompt";

/**
 * 推进故事的一回合 (Orchestrator)
 * 接收玩家输入，进行意图翻译、长短记忆检索，并调用核心大模型写出下一段剧情。
 * 随后自动将新的问答对存入 MemoryManager 进行长线生命周期管理。
 * 
 * @param userInput 玩家的行动指令或对话
 * @param currentState 当前的“上帝视角”设定表（短路缓存与核心指导）
 * @param memoryManager 管理所有聊天轮次、滑窗入库的管家实例
 * @param sessionId 当前正在运行的存档 ID（用于 Pinecone 隔离）
 * @returns 大模型新生成的剧情文本
 */
export async function* generateNextStoryTurnStream(
    userInput: string,
    currentState: StoryState,
    memoryManager: MemoryManager,
    sessionId: string
): AsyncGenerator<string, void, unknown> {
    console.log(`\n======================================================`);

    // ⏱️ [计时节点 T0] - 接收玩家输入 (开始点)
    const T0 = Date.now();
    console.log(`[⏱️ T0] [StoryGenerator] Received player input: "${userInput}"`);

    // 1. 获取近期上下文 (同步)
    const recentHistory = memoryManager.chatHistory.slice(-3);

    // 2. Translate player intent (with short-circuit routing) (Async)
    console.log(`[StoryGenerator] Parsing intent and checking for short-circuit routing...`);
    const queryIntent = await translateUserIntent(currentState, recentHistory, userInput);

    // ⏱️ [计时节点 T1]
    const T1 = Date.now();
    console.log(`[⏱️ T1] [Async] Intent parsing complete (GPT API time): ${T1 - T0} ms`);

    // 3. 检索云端长记忆 RAG (如果短路开关触发，底层会自动拦截并返回 []) (异步)
    const results = await retrieveMemories(queryIntent, sessionId);

    // ⏱️ [计时节点 T2]
    const T2 = Date.now();
    console.log(`[⏱️ T2] [Async] Pinecone RAG retrieval complete (Vector search time): ${T2 - T1} ms`);

    // Assemble RAG context (Sync)
    let retrievedContext = "No relevant long-term memories.";
    if (results.length > 0) {
        retrievedContext = results.map((r, i) => `[Memory Fragment ${i + 1}]: ${r.dense_summary}`).join("\n");
        console.log(`[StoryGenerator] Successfully assembled ${results.length} long-term memories for the model.`);
    } else {
        console.log(`[StoryGenerator] No long-term memories found or needed, proceeding with current state only.`);
    }

    // 4. Format unprocessed archive (unprocessedArchive) (Sync)
    const unprocessedArchiveStr = memoryManager.unprocessedArchive.length > 0
        ? memoryManager.unprocessedArchive.map(t => `[Turn ${t.turn_id}] ${t.role.toUpperCase()}: ${t.text}`).join("\n")
        : "No unprocessed archive memories.";

    // 5. 将系统内的纯文本 ChatTurn 数组转换为 LangChain 标准 Message 数组 (同步)
    const langchainHistory = memoryManager.chatHistory.map(turn => {
        if (turn.role === "user") return new HumanMessage(turn.text);
        return new AIMessage(turn.text);
    });

    // 6. 组装并调用核心剧情模型 (WorkerLLM) (同步)
    const storyLLM = getStoryLLM();
    const chain = storyWorkerPrompt.pipe(storyLLM).pipe(new StringOutputParser());

    // ⏱️ [计时节点 T3]
    const T3 = Date.now();
    console.log(`[⏱️ T3] [Sync] Context and Prompt assembly complete: ${T3 - T2} ms`);

    console.log(`[StoryGenerator] Calling main model to continue the story... (streaming)`);
    // 创建流对象 (异步)
    const stream = await chain.stream({
        worldBible: JSON.stringify(currentState.world_bible, null, 2),
        currentState: JSON.stringify(currentState),
        unprocessedArchive: unprocessedArchiveStr,
        retrievedContext: retrievedContext,
        chatHistory: langchainHistory,
        input: userInput
    });

    // ⏱️ [计时节点 T4]
    const T4 = Date.now();
    console.log(`[⏱️ T4] [Async] Established connection with LangChain to get Stream object: ${T4 - T3} ms`);

    let fullText = "";
    let isFirstChunk = true;
    for await (const chunk of stream) {
        if (isFirstChunk) {
            // ⏱️ [Timing Node T5] - First byte response time (TTFT - Time To First Token)
            const T5 = Date.now();
            console.log(`[⏱️ T5] [Async] Received first byte response (TTFT latency): ${T5 - T4} ms`);
            console.log(`➡️  [Total Latency] From player input to first character, user waited: ${T5 - T0} ms!`);
            isFirstChunk = false;
        }
        fullText += chunk;
        yield chunk;
    }

    const T6 = Date.now();
    console.log(`[⏱️ T6] [Async] Text stream transmission ended. Total generation time: ${T6 - T0} ms.`);

    // --- 剥离后台静默收尾任务，不阻塞流的关闭 ---
    (async () => {
        try {
            // 6. 将新的对话数据推入系统记忆管道
            const baseTurnId = memoryManager.chatHistory.length > 0
                ? memoryManager.chatHistory[memoryManager.chatHistory.length - 1].turn_id
                : 0;

            await memoryManager.addTurn({
                turn_id: baseTurnId + 1,
                role: "user",
                text: userInput
            }, currentState, sessionId);

            await memoryManager.addTurn({
                turn_id: baseTurnId + 2,
                role: "assistant",
                text: fullText
            }, currentState, sessionId);

            // 7. Background State Machine to update Core Panel
            console.log(`[StoryGenerator] Background state machine calculating latest state Diff patch...`);
            const updateLLM = getManagerLLM().withStructuredOutput(StateChangeSchema);
            const updatePromptVal = await storyUpdatePrompt.invoke({
                currentState: JSON.stringify(currentState),
                text: `【玩家输入】: ${userInput}\n【剧情发展】: ${fullText}`
            });

            const stateDiff = await updateLLM.invoke(updatePromptVal);
            const updatedState = applyStateChanges(currentState, stateDiff);

            Object.assign(currentState, updatedState);
            if (stateDiff.state_summary) {
                console.log(`[StoryGenerator] 🔄 God's Eye state updated! Summary: ${stateDiff.state_summary}`);
            }
        } catch (e) {
            console.error("[StoryGenerator] 异步状态机处理崩溃:", e);
        }
    })();
}
