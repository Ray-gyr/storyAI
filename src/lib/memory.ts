import { z } from "zod";
import { memoryExtractorPrompt } from "./prompt";
import { getManagerLLM } from "./llm";
import { StoryState } from "./currentState";
import { randomUUID } from "crypto";


// ==========================================
// 记忆提取模块 (Memory Extraction)
// ==========================================

export const LLMExtractedMemorySchema = z.object({
    location: z.string().describe("发生地点（必须从已知实体库中映射）"),
    characters_involved: z.array(z.string()).describe("参与的已知角色列表"),
    items_involved: z.array(z.string()).describe("涉及的已知物品列表"),

    // 将主观打分改为客观的“语义重要性信号”
    semantic_signals: z.object({
        has_new_entity: z.boolean().describe("这段剧情是否描述了主角【初次】遇见某人、到达新地点、或【刚刚获得/发现】某件物品？（注意：即使该实体当前已在已知字典中，只要剧情原文体现了这是它的'获取/起源'时刻，就必须标为 true）"),
        is_irreversible: z.boolean().describe("是否发生了不可逆的重大事件（如角色死亡、物品损毁、核心阵营决裂）?"),
        advances_plot: z.boolean().describe("是否实质性地推进了主角的当前任务 (current_task)?")
    }).describe("客观判断这段剧情的语义重要性"),

    dense_summary: z.string()
        .describe("对这段剧情的硬核摘要。必须消除所有代词，全部替换为具体的已知实体名称。用于后续精确向量匹配。")
});

export type LLMExtractedMemory = z.infer<typeof LLMExtractedMemorySchema>;

// ==========================================
// 最终入库的记忆记录 Schema (Database Record)
// ==========================================
export const MemoryRecordSchema = z.object({
    id: z.string().uuid(), // 数据库 ID，使用 randomUUID 生成
    original_text: z.string(), // 提取该记忆的原文段落
    start_turn: z.number(), // 由外部传入：该记忆片段开始的对话轮次
    end_turn: z.number(), // 由外部传入：该记忆片段结束的对话轮次

    // memorySchema 直接作为 final Schema 的一部分
    memory: LLMExtractedMemorySchema,

    created_at: z.date(), // 提取时间
    access_count: z.number().default(0) // 每次被召回时更新
});

export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

//提取并生成可直接入库的记忆记录

export async function extractAndStoreMemory(
    currentState: StoryState,
    storyText: string,
    startTurn: number,
    endTurn: number
): Promise<MemoryRecord> {

    // 2. 为了省 Token，只需要把 currentState 里的 entities 提取出来变成字符串
    const knownEntitiesStr = JSON.stringify({
        locations: currentState.known_locations.map(l => l.name),
        characters: currentState.known_characters.map(c => c.name),
        items: currentState.known_items.map(i => i.name)
    });

    // 仅针对 memorySchema 部分做结构化输出约束，UID、提取时间大模型不可见
    const managerLLM = getManagerLLM();
    const structuredLLM = managerLLM.withStructuredOutput(LLMExtractedMemorySchema);

    // 组装 Prompt
    const promptValue = await memoryExtractorPrompt.invoke({
        knownEntities: knownEntitiesStr,
        storyText: storyText
    });

    // 组装最终完整的 Database Record 并返回
    try {
        const memoryData = await structuredLLM.invoke(promptValue);

        return {
            id: randomUUID(),
            original_text: storyText,
            start_turn: startTurn,
            end_turn: endTurn,
            memory: memoryData,
            created_at: new Date(),
            access_count: 0
        };
    } catch (error) {
        console.error("❌ 记忆提取失败:", error);
        // 在生产环境中，这里可以选择返回一个带有 null memory 的兜底记录，
        // 或者直接抛出异常让上层 API 处理
        throw error;
    }
}
