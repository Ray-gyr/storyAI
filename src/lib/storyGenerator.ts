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
    console.log(`[StoryGenerator] 收到玩家输入: "${userInput}"`);

    // 1. 获取近期上下文 (给意图翻译器使用，防脱节)
    const recentHistory = memoryManager.chatHistory.slice(-3);

    // 2. 翻译玩家意图 (带短路路由识别)
    console.log(`[StoryGenerator] 正在解析意图并判断是否短路路由...`);
    const queryIntent = await translateUserIntent(currentState, recentHistory, userInput);

    // 3. 检索云端长记忆 RAG (如果短路开关触发，底层会自动拦截并返回 [])
    const results = await retrieveMemories(queryIntent, sessionId);

    // 组装 RAG 上下文
    let retrievedContext = "无相关久远记忆。";
    if (results.length > 0) {
        retrievedContext = results.map((r, i) => `[回忆片段 ${i + 1}]: ${r.dense_summary}`).join("\n");
        console.log(`[StoryGenerator] 成功组装了 ${results.length} 条长线记忆提供给主创大模型。`);
    } else {
        console.log(`[StoryGenerator] 没有或无需提取长线记忆，仅靠当前状态继续运算。`);
    }

    // 4. 将系统内的纯文本 ChatTurn 数组转换为 LangChain 标准 Message 数组
    const langchainHistory = memoryManager.chatHistory.map(turn => {
        if (turn.role === "user") return new HumanMessage(turn.text);
        return new AIMessage(turn.text);
    });

    // 5. 组装并调用核心剧情模型 (WorkerLLM)
    const storyLLM = getStoryLLM();
    const chain = storyWorkerPrompt.pipe(storyLLM).pipe(new StringOutputParser());

    console.log(`[StoryGenerator] 正在呼叫主要大模型续写下一段情节... (流式生成)`);
    const stream = await chain.stream({
        currentState: JSON.stringify(currentState, null, 2),
        retrievedContext: retrievedContext,
        chatHistory: langchainHistory,
        input: userInput
    });

    let fullText = "";
    for await (const chunk of stream) {
        fullText += chunk;
        yield chunk;
    }

    console.log(`[StoryGenerator] ✨ AI 剧情生成完毕！文本流传输结束。`);

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

            // 7. 后台启动 Diff 状态机，更新核心面板
            console.log(`[StoryGenerator] 正在由后台状态机计算最新状态 Diff 补丁...`);
            const updateLLM = getManagerLLM().withStructuredOutput(StateChangeSchema);
            const updatePromptVal = await storyUpdatePrompt.invoke({
                currentState: JSON.stringify(currentState),
                text: `【玩家输入】: ${userInput}\n【剧情发展】: ${fullText}`
            });
            
            const stateDiff = await updateLLM.invoke(updatePromptVal);
            const updatedState = applyStateChanges(currentState, stateDiff);
            
            Object.assign(currentState, updatedState);
            if (stateDiff.state_summary) {
                console.log(`[StoryGenerator] 🔄 上帝视角状态更新完毕！摘要: ${stateDiff.state_summary}`);
            }
        } catch (e) {
            console.error("[StoryGenerator] 异步状态机处理崩溃:", e);
        }
    })();
}
