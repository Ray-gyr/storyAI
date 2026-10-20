/**
 * 检索实验 · 出题
 *
 * 1. 从语料中均匀抽取 N 个片段，每个片段用 LLM 出两道"回忆型"玩家问题：
 *    - verbatim：保留片段原文的用词
 *    - paraphrase：同一个事实、同样的实体名，但刻意换掉所有其它实词
 *    标准答案 = 出题的来源片段，因此不需要 LLM 打分或人工标注。
 * 2. 每道题都先经过生产环境的意图翻译 (translateUserIntent)，与线上输入保持一致。
 * 向量侧排名由 rank_vectors.ts 另行计算。
 *
 * 运行：npx tsx --env-file=.env scripts/eval/make_questions.ts [chunkCount] [outFile] [excludeFile...]
 *   outFile     默认 questions.json（调参用的 A 组）
 *   excludeFile 已用过的题目文件，其来源片段不会再被抽中（用来生成留出验证的 B 组）
 * 输入：scripts/eval/out/corpus.json
 * 输出：scripts/eval/out/<outFile>
 */
import { ChatOpenAI } from "@langchain/openai";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { translateUserIntent, QueryIntent } from "../../src/lib/query";
import { getSession } from "../../src/lib/sessionStore";
import { StoryState } from "../../src/lib/currentState";

const OUT_DIR = join(process.cwd(), "scripts", "eval", "out");
const CHUNK_COUNT = Number(process.argv[2] || 20);
const OUT_FILE = process.argv[3] || "questions.json";
const EXCLUDE_FILES = process.argv.slice(4);

type Chunk = { id: string; dense_summary: string; start_turn: number; end_turn: number };

const QuestionPairSchema = z.object({
    target_fact: z.string().describe("The specific fact or event from this passage that both questions ask about."),
    verbatim: z.string().describe("Player-style recall question that REUSES the passage's own key verbs and nouns."),
    paraphrase: z.string().describe("Recall question about the same fact, keeping entity names but replacing every other content word with different wording."),
});

const questionLLM = new ChatOpenAI({
    modelName: "gpt-4o-mini",
    openAIApiKey: process.env.OPENAI_API_KEY,
    temperature: 0.4,
}).withStructuredOutput(QuestionPairSchema);

async function makeQuestionPair(chunk: Chunk, entityNames: string[]) {
    return questionLLM.invoke([
        ["system", `You write test questions for a memory-retrieval benchmark in a text adventure.
The player (Mara Voss) is trying to recall something that happened earlier in the story.

Given ONE memory passage, pick a fact or event that is SPECIFIC to this passage (not something true throughout the story), then write two player questions about it:

1. verbatim: a short first-person recall question (max 20 words) that reuses the passage's own key verbs and nouns.
2. paraphrase: a short first-person recall question (max 20 words) about the SAME fact. Keep the same entity names, but replace EVERY other content word with a synonym or different phrasing. It must not share any verb, noun, or adjective with the passage except entity names.

Known entity names (keep these exact spellings when used): ${entityNames.join(", ")}`],
        ["human", `Memory passage:\n${chunk.dense_summary}`],
    ]);
}

/** 复刻 vectorDBManager.retrieveMemories 的查询增强 */
function enhancedQuery(intent: QueryIntent, rawQuestion: string): string {
    // 改写句为空时退回原始问题，保证每道题都有检索输入
    const parts = [intent.search_query || rawQuestion];
    parts.push(...intent.characters_involved, ...intent.items_involved, ...intent.locations_involved);
    return parts.join(" ");
}

/** 在语料中均匀抽样，避开过短的片段 */
function pickChunks(chunks: Chunk[], count: number): Chunk[] {
    const usable = chunks.filter(c => c.dense_summary && c.dense_summary.split(/\s+/).length >= 25);
    if (usable.length <= count) return usable;
    const step = usable.length / count;
    return Array.from({ length: count }, (_, i) => usable[Math.floor(i * step)]);
}

async function main() {
    const corpus = JSON.parse(readFileSync(join(OUT_DIR, "corpus.json"), "utf-8"));
    const chunks: Chunk[] = corpus.chunks;
    const finalState: StoryState = corpus.finalState;
    const entityNames = [...finalState.known_characters, ...finalState.known_locations, ...finalState.known_items].map(e => e.name);

    // 回忆问题在故事结尾提出：用存档最后的滑动窗口作为意图翻译的近期上下文，与线上一致
    const session = await getSession(corpus.sessionId);
    const recentHistory = session?.memoryManager.chatHistory.slice(-3) ?? [];

    const excluded = new Set<string>(EXCLUDE_FILES.flatMap(f =>
        JSON.parse(readFileSync(join(OUT_DIR, f), "utf-8")).questions.map((q: { gold_id: string }) => q.gold_id)));
    const candidates = chunks.filter(c => !excluded.has(c.id));

    const picked = pickChunks(candidates, CHUNK_COUNT);
    console.log(`corpus: ${chunks.length} chunks, ${excluded.size} excluded, picked ${picked.length} as question sources`);

    const questions = [];
    for (const [i, chunk] of picked.entries()) {
        const pair = await makeQuestionPair(chunk, entityNames);
        for (const type of ["verbatim", "paraphrase"] as const) {
            const question = pair[type];
            const intent = await translateUserIntent(finalState, recentHistory, question);
            questions.push({
                qid: `${i}-${type}`,
                type,
                gold_id: chunk.id,
                gold_turns: [chunk.start_turn, chunk.end_turn],
                target_fact: pair.target_fact,
                question,
                intent,
                enhanced_query: enhancedQuery(intent, question),
            });
        }
        console.log(`[${i + 1}/${picked.length}] turns ${chunk.start_turn}-${chunk.end_turn}: ${pair.verbatim}  |  ${pair.paraphrase}`);
    }

    writeFileSync(join(OUT_DIR, OUT_FILE), JSON.stringify({ sessionId: corpus.sessionId, questions }, null, 2));
    console.log(`saved ${questions.length} questions to ${OUT_FILE}; run rank_vectors.ts ${OUT_FILE} next`);
}

main().catch(e => { console.error(e); process.exit(1); });
