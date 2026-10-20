import { z } from "zod";
import { storyChunkingPrompt, StoryChunkingSchema } from "./prompt";
import { getManagerLLM } from "./Init";
import { extractAndStoreMemory, MemoryRecord } from "./memoryChunkGenerator";
import { StoryState } from "./currentState";
import { storeMemoryRecord } from "./vectorDBManager";

export const WINDOW_SIZE = 5;
export const MEMORY_WINDOW_SIZE = 10;
export const CHUNK_OVERLAP = 2;

export interface ChatTurn {
    turn_id: number;
    role: "user" | "assistant" | "system";
    text: string;
}

export class MemoryManager {
    public chatHistory: ChatTurn[] = [];
    public unprocessedArchive: ChatTurn[] = [];

    // 记录上一批最终的一个/几个 turn，用于给下一个 chunk 提供硬性重叠
    private lastProcessedOverlapTurns: ChatTurn[] = [];

    /**
     * 追加对话。如果超出滑动窗口，自动移入归档区。
     * 当归档区积累满了，自动触发大模型切分及记忆提取。
     */
    public async addTurn(turn: ChatTurn, currentState: StoryState, sessionId: string): Promise<MemoryRecord[]> {
        this.chatHistory.push(turn);

        let extractedRecords: MemoryRecord[] = [];

        // 如果超出了滑动窗口，将最旧的一轮挤出到底层归档区
        if (this.chatHistory.length > WINDOW_SIZE) {
            const popped = this.chatHistory.shift();
            if (popped) {
                this.unprocessedArchive.push(popped);
            }
        }

        // 当积攒了一定数量后触发语义切分（这里设定满了一个 WINDOW_SIZE 就切一次）
        if (this.unprocessedArchive.length >= MEMORY_WINDOW_SIZE) {
            try {
                extractedRecords = await this.processArchive(currentState, sessionId);
            } catch (e) {
                // 归档失败不能拖垮本回合的保存，未处理的轮次留在归档区，下次再试
                console.error("[MemoryManager] Archive processing failed, will retry on a later turn:", e);
            }
        }

        return extractedRecords;
    }

    /**
     * 主动强行处理当前所有的待归档数据
     */
    public async processArchive(currentState: StoryState, sessionId: string): Promise<MemoryRecord[]> {
        if (this.unprocessedArchive.length === 0) return [];

        const managerLLM = getManagerLLM();
        const structuredLLM = managerLLM.withStructuredOutput(StoryChunkingSchema);

        const archiveStr = this.formatTurns(this.unprocessedArchive);
        const historyStr = this.formatTurns(this.chatHistory);

        // 调用刚才新写的切分模型
        const promptValue = await storyChunkingPrompt.invoke({
            unprocessedArchive: archiveStr,
            chatHistory: historyStr
        });

        const output = await structuredLLM.invoke(promptValue);
        // 去重 + 规避降序
        const startIds = Array.from(new Set(output.chunk_start_turn_ids || [])).sort((a, b) => a - b);

        // 第一个切分点必须是归档区的第一轮：既防止大模型返回空数组，
        // 也防止第一个切分点之前的轮次不属于任何 chunk 而被静默丢弃
        const firstArchivedTurnId = this.unprocessedArchive[0].turn_id;
        if (startIds.length === 0 || startIds[0] > firstArchivedTurnId) {
            startIds[0] = firstArchivedTurnId;
        }

        // 先同步切好所有 chunk，再并发提取，缩短后台收尾时间
        const chunks: { turns: ChatTurn[]; text: string }[] = [];

        for (let i = 0; i < startIds.length; i++) {
            const currentStartId = startIds[i];
            const nextStartId = i + 1 < startIds.length ? startIds[i + 1] : Infinity;

            const chunkTurns = this.unprocessedArchive.filter(
                t => t.turn_id >= currentStartId && t.turn_id < nextStartId
            );

            if (chunkTurns.length === 0) continue;

            // ======= 补充 Context Overlap (重叠机制) =======
            let prefixContext = "";
            if (i === 0) {
                // 如果这是本次长文本的第一块，它需要和历史上的上一批遗留轮次做重叠
                if (this.lastProcessedOverlapTurns.length > 0) {
                    prefixContext = "[Story Context Overlap]\n" + this.formatTurns(this.lastProcessedOverlapTurns) + "\n\n";
                }
            } else {
                // 如果它在后头，它就直接去它自己前面的那块要数据重叠
                const previousTurns = this.unprocessedArchive.filter(t => t.turn_id < currentStartId);
                const overlapTurns = previousTurns.slice(-CHUNK_OVERLAP);
                if (overlapTurns.length > 0) {
                    prefixContext = "[Story Context Overlap]\n" + this.formatTurns(overlapTurns) + "\n\n";
                }
            }

            chunks.push({
                turns: chunkTurns,
                text: prefixContext + "[Content to Extract]\n" + this.formatTurns(chunkTurns)
            });
        }

        const settled = await Promise.allSettled(chunks.map(async chunk => {
            // 正式调用 memoryChunkGenerator 生成结构化事实记忆
            const record = await extractAndStoreMemory(
                currentState,
                chunk.text,
                chunk.turns[0].turn_id,
                chunk.turns[chunk.turns.length - 1].turn_id
            );

            // 自动存入 Pinecone 向量数据库的指定 sessionId Namespace 中
            await storeMemoryRecord(record, sessionId);
            return record;
        }));

        const records: MemoryRecord[] = [];
        const processedTurnIds = new Set<number>();

        settled.forEach((result, i) => {
            if (result.status === "fulfilled") {
                records.push(result.value);
                chunks[i].turns.forEach(t => processedTurnIds.add(t.turn_id));
                // 更新这轮作为接下来的历史锚点储备
                this.lastProcessedOverlapTurns = chunks[i].turns.slice(-CHUNK_OVERLAP);
            } else {
                console.error(`[MemoryManager] Failed to archive chunk starting at turn ${chunks[i].turns[0].turn_id}:`, result.reason);
            }
        });

        // 只移除成功入库的轮次，失败的留在归档区下次重试，避免记忆丢失或重复入库
        this.unprocessedArchive = this.unprocessedArchive.filter(t => !processedTurnIds.has(t.turn_id));

        return records;
    }

    private formatTurns(turns: ChatTurn[]): string {
        return turns.map(t => `[Turn ${t.turn_id}] ${t.role.toUpperCase()}: ${t.text}`).join("\n");
    }
}
