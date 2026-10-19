import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { getManagerLLM, getStoryLLM } from "./Init";
import { StoryState, StateChangeSchema, applyStateChanges } from "./currentState";
import { translateUserIntent, QueryIntent } from "./query";
import { bumpAccessCounts } from "./vectorDBManager";
import { retrieveMemories, startDenseSearch } from "./hybridRetriever";
import { IndexedMemory } from "./memoryStore";
import { storyWorkerPrompt, storyUpdatePrompt } from "./prompt";
import { updateSession, getTranscriptLength, SessionData } from "./sessionStore";
import { ChatTurn } from "./memoryManager";

/** 一回合生成完毕后的产物，交给 finalizeStoryTurn 落盘 */
export interface StoryTurnResult {
    fullText: string;
    retrievedMemories: IndexedMemory[];
}

// 意图翻译失败时的兜底：BM25 一路直接用玩家原话
const fallbackIntent = (userInput: string): QueryIntent => ({
    search_query: userInput,
    characters_involved: [],
    items_involved: [],
    locations_involved: []
});

/**
 * 推进故事的一回合 (Orchestrator)
 * 接收玩家输入，进行意图翻译、长短记忆检索，并调用核心大模型写出下一段剧情。
 * 生成结束后由调用方调用 finalizeStoryTurn 把本回合写回记忆与存档。
 *
 * @param userInput 玩家的行动指令或对话
 * @param session 包含状态和记忆的全套会话数据
 * @param sessionId 当前正在运行的存档 ID（用于 Pinecone 隔离）
 * @returns 逐块 yield 剧情文本，结束时 return 完整文本与本回合召回的记忆
 */
export async function* generateNextStoryTurnStream(
    userInput: string,
    session: SessionData,
    sessionId: string
): AsyncGenerator<string, StoryTurnResult, unknown> {
    const { currentState, memoryManager } = session;
    console.log(`\n======================================================`);

    // ⏱️ [计时节点 T0] - 接收玩家输入 (开始点)
    const T0 = Date.now();
    console.log(`[⏱️ T0] [StoryGenerator] Received player input: "${userInput}"`);

    // 1. 获取近期上下文 (同步)
    const recentHistory = memoryManager.chatHistory.slice(-3);

    // 2. 向量检索直接用玩家原话，与意图翻译并行发起（混合检索的向量一路不依赖改写结果）
    const dense = startDenseSearch(userInput, sessionId);

    // 3. Translate player intent into a retrieval query (Async)，供 BM25 一路使用
    // 不再做"缓存可答"短路：实测路由会把绝大多数回忆型问题误判为可答而跳过检索（37/40，其中 32 题答案并不在上下文中），
    // 而行动指令本来就有 96% 会检索，短路只能在约 4% 的回合省下约 0.6s
    console.log(`[StoryGenerator] Parsing intent...`);
    const queryIntent = await translateUserIntent(currentState, recentHistory, userInput)
        .catch(e => {
            console.error("[StoryGenerator] Intent parsing failed, falling back to raw input for retrieval:", e);
            return fallbackIntent(userInput);
        });

    // ⏱️ [计时节点 T1]
    const T1 = Date.now();
    console.log(`[⏱️ T1] [Async] Intent parsing complete (GPT API time): ${T1 - T0} ms`);

    // 4. 混合检索长记忆：BM25 + 向量，RRF 合并 (异步)
    // 长记忆只是增强项，检索失败时不阻断剧情生成
    const results = await retrieveMemories({ rawInput: userInput, intent: queryIntent, dense, sessionId })
        .catch(e => {
            console.error("[StoryGenerator] Memory retrieval failed, continuing without long-term memories:", e);
            return [] as IndexedMemory[];
        });

    // ⏱️ [计时节点 T2]
    const T2 = Date.now();
    console.log(`[⏱️ T2] [Async] Hybrid retrieval complete (after intent parsing): ${T2 - T1} ms`);

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
        worldBible: JSON.stringify(currentState.world_bible),
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

    return { fullText, retrievedMemories: results };
}

/**
 * 回合收尾：把新的问答对推入记忆管道、计算状态 Diff，并持久化到 Redis。
 * 必须在请求生命周期内被 await（路由里通过 after() 调用），
 * 否则 Serverless 函数在响应结束后被冻结，本回合会丢失。
 */
export async function finalizeStoryTurn(
    userInput: string,
    turn: StoryTurnResult,
    session: SessionData,
    sessionId: string
): Promise<void> {
    const { currentState, memoryManager, metadata } = session;
    const { fullText, retrievedMemories } = turn;

    const baseTurnId = memoryManager.chatHistory.length > 0
        ? memoryManager.chatHistory[memoryManager.chatHistory.length - 1].turn_id
        : 0;
    const newTurns: ChatTurn[] = [
        { turn_id: baseTurnId + 1, role: "user", text: userInput },
        { turn_id: baseTurnId + 2, role: "assistant", text: fullText }
    ];

    // 加入完整对话记录之前创建的旧存档还没有记录：用记忆管道里仍保留的轮次补齐开头
    // （必须在 addTurn 修改滑动窗口和归档区之前取快照）
    const backfillTurns = [...memoryManager.unprocessedArchive, ...memoryManager.chatHistory]
        .sort((a, b) => a.turn_id - b.turn_id);

    // 6. 将新的对话数据推入系统记忆管道（归档时使用的是本回合开始前的状态）
    const recordTurns = async () => {
        for (const turn of newTurns) {
            await memoryManager.addTurn(turn, currentState, sessionId);
        }
    };

    // 7. Background State Machine to update Core Panel
    const computeStateDiff = async () => {
        console.log(`[StoryGenerator] Background state machine calculating latest state Diff patch...`);
        const updateLLM = getManagerLLM().withStructuredOutput(StateChangeSchema);
        const updatePromptVal = await storyUpdatePrompt.invoke({
            currentState: JSON.stringify(currentState),
            text: `【玩家输入】: ${userInput}\n【剧情发展】: ${fullText}`
        });
        return updateLLM.invoke(updatePromptVal);
    };

    // 三件事互不依赖，并发执行；状态 Diff 或 access_count 失败都不应导致本回合对话丢失
    const [turnsResult, diffResult, bumpResult, transcriptLengthResult] = await Promise.allSettled([
        recordTurns(),
        computeStateDiff(),
        bumpAccessCounts(retrievedMemories, sessionId),
        getTranscriptLength(sessionId)
    ]);

    if (turnsResult.status === "rejected") {
        throw turnsResult.reason;
    }

    if (diffResult.status === "fulfilled") {
        const stateDiff = diffResult.value;
        Object.assign(currentState, applyStateChanges(currentState, stateDiff));
        if (stateDiff.state_summary) {
            console.log(`[StoryGenerator] 🔄 God's Eye state updated! Summary: ${stateDiff.state_summary}`);
        }
    } else {
        console.error("[StoryGenerator] State diff failed, keeping previous state:", diffResult.reason);
    }

    if (bumpResult.status === "rejected") {
        console.error(`[VectorDB] 更新使用频率失败:`, bumpResult.reason);
    }

    if (transcriptLengthResult.status === "rejected") {
        throw transcriptLengthResult.reason;
    }
    const transcriptTurns = transcriptLengthResult.value === 0
        ? [...backfillTurns, ...newTurns]
        : newTurns;

    // [Redis] 把包含新聊天和新状态的 session 持久化，并追加完整对话记录
    await updateSession(sessionId, { currentState, memoryManager, metadata }, transcriptTurns);
    console.log(`[StoryGenerator] Session changes saved to Redis successfully.`);
}
