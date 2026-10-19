import { z } from "zod";
import { getManagerLLM } from "./Init";
import { StoryState } from "./currentState";
import { ChatTurn } from "./memoryManager";
import { queryIntentPrompt } from "./prompt";

// ==========================================
// Query Intent Schema & Prompts
// ==========================================

export const QueryIntentSchema = z.object({
    search_query: z.string().describe("将玩家的操作或意图翻译为具体客观陈述句，用于检索。"),
    characters_involved: z.array(z.string()).describe("玩家意图中明确指代的已知角色名称。没有则填空数组[]。"),
    items_involved: z.array(z.string()).describe("玩家意图中使用到的或指向的已知物品名称。没有则填空数组[]。"),
    locations_involved: z.array(z.string()).describe("玩家意图中指向的相关地点名称。没有则填空数组[]。")
});

export type QueryIntent = z.infer<typeof QueryIntentSchema>;

/**
 * 翻译并展开玩家的意图，用于记忆检索
 * @param currentState 当前完整故事状态
 * @param recentHistory 最近 3 轮的聊天历史
 * @param userInput 玩家的最新句子
 * @returns 扁平化且意图明确的检索内容，包含实体标签
 */
export async function translateUserIntent(
    currentState: StoryState,
    recentHistory: ChatTurn[],
    userInput: string
): Promise<QueryIntent> {
    const managerLLM = getManagerLLM();
    const structuredLLM = managerLLM.withStructuredOutput(QueryIntentSchema);

    // 格式化最近的上下文，最多取最后3轮
    const slicedHistory = recentHistory.slice(-3);
    const historyStr = slicedHistory.map(t => `[Turn ${t.turn_id}] ${t.role.toUpperCase()}: ${t.text}`).join("\n");

    const promptValue = await queryIntentPrompt.invoke({
        currentState: JSON.stringify(currentState),
        recentHistory: historyStr || "暂无上下文",
        userInput: userInput
    });

    try {
        const result = await structuredLLM.invoke(promptValue);
        return result;
    } catch (error) {
        console.error("❌ 意图翻译失败:", error);
        throw error;
    }
}
