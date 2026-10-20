/**
 * 基准测试共享工具：读取故事数据、片段原文、快照
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChatTurn } from "../../../src/lib/memoryManager";
import { QueryIntent } from "../../../src/lib/query";
import { StoryState } from "../../../src/lib/currentState";

export const BENCH_DIR = join(process.cwd(), "scripts", "eval", "benchmark");
export const storyDir = (story: string) => join(BENCH_DIR, "out", story);

export interface Chunk {
    id: string;
    start_turn: number;
    end_turn: number;
    created_at: number;
    dense_summary: string;
    original_text: string;
    location: string;
    characters_involved: string[];
    items_involved: string[];
}

export interface Snapshot {
    round: number;
    taken_at: number;
    turn_count: number;
    currentState: StoryState;
    chatHistory: ChatTurn[];
    unprocessedArchive: ChatTurn[];
    chunk_ids: string[];
}

export type QuestionType = "detail" | "vague" | "temporal";

export interface Question {
    qid: string;
    pool: "early" | "late";
    type: QuestionType;
    source_id: string;
    source_turns: [number, number];
    question: string;
    expected_answer: string;
    event?: string;
    ordinal?: number;
}

/** 每道题在每个快照上的检索结果（各方法的排序片段 id） */
export interface RetrievalRow {
    qid: string;
    snapshot: number;
    intent: QueryIntent;
    rankings: Record<string, string[]>;
}

export const SNAPSHOTS = [100, 200, 300] as const;

export function readJson<T>(path: string): T {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
}

export function writeJson(path: string, data: unknown): void {
    writeFileSync(path, JSON.stringify(data, null, 2));
}

export function loadStory(story: string) {
    const dir = storyDir(story);
    const corpus = readJson<{ sessionId: string; chunks: Chunk[] }>(join(dir, "corpus.json"));
    const snapshots = Object.fromEntries(SNAPSHOTS.map(r => [r, readJson<Snapshot>(join(dir, `snapshot_${r}.json`))])) as Record<number, Snapshot>;
    return { dir, sessionId: corpus.sessionId, chunks: corpus.chunks, snapshots };
}

export function loadQuestions(story: string): Question[] {
    return readJson<{ questions: Question[] }>(join(storyDir(story), "questions.json")).questions;
}

export function loadJsonIfExists<T>(path: string, fallback: T): T {
    return existsSync(path) ? readJson<T>(path) : fallback;
}

/** 片段的正文：去掉与上一片段重叠的上下文与轮次标记（与 scripts/eval/common.py 的 doc_text 一致） */
export function chunkContent(chunk: Pick<Chunk, "original_text">): string {
    let text = chunk.original_text || "";
    if (text.includes("[Content to Extract]")) text = text.split("[Content to Extract]")[1];
    return text.replace(/\[Turn \d+\] (USER|ASSISTANT|SYSTEM):/g, " ").replace(/\s+/g, " ").trim();
}

export const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** 快照时刻已经存在的片段 */
export const existsAt = (chunk: Chunk, snapshot: Snapshot) => chunk.created_at <= snapshot.taken_at;

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: limit }, async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    }));
    return results;
}

/** 在有序列表中均匀抽取 n 个 */
export function evenly<T>(items: T[], n: number): T[] {
    if (items.length <= n) return items;
    const step = items.length / n;
    return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)]);
}
