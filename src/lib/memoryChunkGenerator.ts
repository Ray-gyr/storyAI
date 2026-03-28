import { z } from "zod";
import { memoryExtractorPrompt } from "./prompt";
import { getManagerLLM } from "./Init";
import { StoryState } from "./currentState";
import { randomUUID } from "crypto";


// ==========================================
// 记忆提取模块 (Memory Extraction)
// ==========================================

export const LLMExtractedMemorySchema = z.object({
    location: z.string().describe("Occurrence location (Must be mapped from known entity library)"),
    characters_involved: z.array(z.string()).describe("List of involved known characters"),
    items_involved: z.array(z.string()).describe("List of involved known items"),

    // Objectively judge semantic importance signals
    semantic_signals: z.object({
        has_new_entity: z.boolean().describe("Whether this plot describes the protagonist meeting someone for the [FIRST TIME], arriving at a new location, or [JUST ACQUIRING/DISCOVERING] an item? (Note: Even if the entity is already in the dictionary, if the text shows it is its 'origin' moment, mark as true)"),
        is_irreversible: z.boolean().describe("Whether a major irreversible event has occurred (e.g., character death, item destruction, core faction break)?"),
        advances_plot: z.boolean().describe("Whether it substantially advances the protagonist's current_task?")
    }).describe("Objective judgment of the semantic importance of this plot segment"),

    dense_summary: z.string()
        .describe("Hardcore summary of this plot. Eliminate all pronouns and replace them with specific names of known entities for accurate vector matching. Emphasize cause and effect.")
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

    // 扁平化的 LLM 提取字段，适配 Pinecone Metadata 结构
    location: z.string(),
    characters_involved: z.array(z.string()),
    items_involved: z.array(z.string()),
    has_new_entity: z.boolean(),
    is_irreversible: z.boolean(),
    advances_plot: z.boolean(),
    dense_summary: z.string(),

    created_at: z.number(), // 提取时间戳
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

            location: memoryData.location,
            characters_involved: memoryData.characters_involved,
            items_involved: memoryData.items_involved,
            has_new_entity: memoryData.semantic_signals.has_new_entity,
            is_irreversible: memoryData.semantic_signals.is_irreversible,
            advances_plot: memoryData.semantic_signals.advances_plot,
            dense_summary: memoryData.dense_summary,

            created_at: Date.now(),
            access_count: 0
        };
    } catch (error) {
        console.error("❌ 记忆提取失败:", error);
        // 在生产环境中，这里可以选择返回一个带有 null memory 的兜底记录，
        // 或者直接抛出异常让上层 API 处理
        throw error;
    }
}
