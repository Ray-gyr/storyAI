import { z } from "zod";
import { storyChunkingPrompt, StoryChunkingSchema } from "./prompt";
import { getManagerLLM } from "./Init";
import { extractAndStoreMemory, MemoryRecord } from "./memoryChunkGenerator";
import { StoryState } from "./currentState";
import { storeMemoryRecord } from "./vectorDBManager";

export const WINDOW_SIZE = 10;
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
        if (this.unprocessedArchive.length >= WINDOW_SIZE) {
            extractedRecords = await this.processArchive(currentState, sessionId);
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
        let startIds = output.chunk_start_turn_ids || [];

        // 确保至少有一个起点，防止大模型抽风返回空数组
        if (startIds.length === 0 && this.unprocessedArchive.length > 0) {
            startIds.push(this.unprocessedArchive[0].turn_id);
        }

        // 规避降序
        startIds.sort((a, b) => a - b);

        const records: MemoryRecord[] = [];

        for (let i = 0; i < startIds.length; i++) {
            const currentStartId = startIds[i];
            const nextStartId = i + 1 < startIds.length ? startIds[i + 1] : Infinity;

            const chunkTurns = this.unprocessedArchive.filter(
                t => t.turn_id >= currentStartId && t.turn_id < nextStartId
            );

            if (chunkTurns.length === 0) continue;

            const actualStartTurn = chunkTurns[0].turn_id;
            const actualEndTurn = chunkTurns[chunkTurns.length - 1].turn_id;

            // ======= 补充 Context Overlap (重叠机制) =======
            let prefixContext = "";
            if (i === 0) {
                // 如果这是本次长文本的第一块，它需要和历史上的上一批遗留轮次做重叠
                if (this.lastProcessedOverlapTurns.length > 0) {
                    prefixContext = "[前情提要重叠部分]\n" + this.formatTurns(this.lastProcessedOverlapTurns) + "\n\n";
                }
            } else {
                // 如果它在后头，它就直接去它自己前面的那块要数据重叠
                const previousTurns = this.unprocessedArchive.filter(t => t.turn_id < currentStartId);
                const overlapTurns = previousTurns.slice(-CHUNK_OVERLAP);
                if (overlapTurns.length > 0) {
                    prefixContext = "[前情提要重叠部分]\n" + this.formatTurns(overlapTurns) + "\n\n";
                }
            }

            const chunkText = prefixContext + "[待提取正文]\n" + this.formatTurns(chunkTurns);

            // 正式调用 memoryChunkGenerator 生成结构化事实记忆
            const record = await extractAndStoreMemory(
                currentState,
                chunkText,
                actualStartTurn,
                actualEndTurn
            );

            // 自动存入 Pinecone 向量数据库的指定 sessionId Namespace 中
            await storeMemoryRecord(record, sessionId);

            records.push(record);

            // 更新这轮作为接下来的历史锚点储备
            this.lastProcessedOverlapTurns = chunkTurns.slice(-CHUNK_OVERLAP);
        }

        // 处理完毕，清空当前代处理区
        this.unprocessedArchive = [];

        return records;
    }

    private formatTurns(turns: ChatTurn[]): string {
        return turns.map(t => `[Turn ${t.turn_id}] ${t.role.toUpperCase()}: ${t.text}`).join("\n");
    }
}
