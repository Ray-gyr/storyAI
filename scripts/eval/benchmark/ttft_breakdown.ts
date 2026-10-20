/**
 * 首字延迟分解（本地，按线上 generateNextStoryTurnStream 的顺序）
 *
 * 开发故事第 300 回合快照的上下文（130 个记忆片段），对每个输入计时：
 *   intent   意图改写（gpt-4o-mini），与向量检索并行
 *   dense    向量检索（嵌入 + Pinecone），与意图改写并行
 *   rank     BM25 + 配额合并 + 读取原文（Redis）
 *   writer   写作模型（gpt-6-luna）从调用到第一段文本
 * 本地网络与 Vercel 不同，绝对值只作参考，主要看各段占比。
 *
 * 运行：npx tsx --env-file=.env scripts/eval/benchmark/ttft_breakdown.ts [n]
 */
import { getStoryLLM } from "../../../src/lib/Init";
import { retrieveMemories, startDenseSearch } from "../../../src/lib/hybridRetriever";
import { storyWorkerPrompt } from "../../../src/lib/prompt";
import { translateUserIntent } from "../../../src/lib/query";
import { writerPromptInputs } from "../../../src/lib/storyGenerator";
import { loadQuestions, loadStory } from "./common";

const N = Number(process.argv[2] || 10);
const ACTIONS = ["I search the cargo bay for anything useful.", "I ask Priya what she thinks we should do next.", "I head back to the Kestrel.", "I check my oxygen levels.", "I open the locker."];

async function main() {
    const { sessionId, snapshots } = loadStory("dev");
    const snap = snapshots[300];
    const questions = loadQuestions("dev-hard").map(q => q.question);
    const inputs = Array.from({ length: N }, (_, i) => i % 2 === 0 ? ACTIONS[(i / 2) % ACTIONS.length] : questions[i * 3 % questions.length]);
    const rows: { intent: number; dense: number; rank: number; writer: number; total: number }[] = [];
    for (const input of inputs) {
        const t0 = performance.now();
        const intentP = translateUserIntent(snap.currentState, snap.chatHistory.slice(-3), input).then(r => ({ r, t: performance.now() - t0 }));
        const denseP = startDenseSearch(input, sessionId, { createdBefore: snap.taken_at }).then(r => ({ r, t: performance.now() - t0 }));
        const [intent, dense] = await Promise.all([intentP, denseP]);
        const t1 = performance.now();
        const memories = await retrieveMemories({ rawInput: input, intent: intent.r, dense: Promise.resolve(dense.r), sessionId, createdBefore: snap.taken_at });
        const t2 = performance.now();
        const stream = await storyWorkerPrompt.pipe(getStoryLLM()).stream(writerPromptInputs({ state: snap.currentState, memories, unprocessedArchive: snap.unprocessedArchive, chatHistory: snap.chatHistory, input }));
        let first = 0;
        for await (const chunk of stream) {
            if (!first && String(chunk.content ?? "").trim()) { first = performance.now(); break; }
        }
        rows.push({ intent: intent.t, dense: dense.t, rank: t2 - t1, writer: first - t2, total: first - t0 });
        console.log(`intent ${(intent.t / 1000).toFixed(2)}s | dense ${(dense.t / 1000).toFixed(2)}s | rank+texts ${((t2 - t1) / 1000).toFixed(2)}s | writer first token ${((first - t2) / 1000).toFixed(2)}s | TTFT ${((first - t0) / 1000).toFixed(2)}s`);
    }
    const med = (k: keyof (typeof rows)[number]) => { const s = rows.map(r => r[k]).sort((a, b) => a - b); return (s[Math.floor(s.length / 2)] / 1000).toFixed(2); };
    console.log(`median: intent ${med("intent")}s, dense ${med("dense")}s (parallel), rank+texts ${med("rank")}s, writer first token ${med("writer")}s, TTFT ${med("total")}s`);
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
