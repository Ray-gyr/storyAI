/**
 * 意图路由诊断：路由的"缓存可答"(is_resolved_by_cache) 判断是否可信？
 * （历史脚本：短路已根据本诊断的结果移除，只能在移除前生成的 questions.json 上运行）
 *
 * 对 questions.json 里的每道回忆题，让裁判 LLM 判断：只看路由当时能看到的上下文
 * （当前状态 + 最近 3 轮对话），是否真的能答出这道题（已知标准答案）。
 * 再与路由的实际短路结果交叉对比。
 *
 * 运行：npx tsx --env-file=.env scripts/eval/diagnose_router.ts
 * 输入：scripts/eval/out/corpus.json, scripts/eval/out/questions.json
 * 输出：scripts/eval/out/router_diagnosis.json
 */
import { ChatOpenAI } from "@langchain/openai";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { getSession } from "../../src/lib/sessionStore";

const OUT_DIR = join(process.cwd(), "scripts", "eval", "out");

const VerdictSchema = z.object({
    evidence: z.string().describe("Quote the exact sentence from the CONTEXT that answers the question, or empty string if none."),
    answerable: z.boolean().describe("True only if the CONTEXT alone contains enough information to give the correct answer."),
});

const judge = new ChatOpenAI({
    modelName: "gpt-4o-mini",
    openAIApiKey: process.env.OPENAI_API_KEY,
    temperature: 0,
}).withStructuredOutput(VerdictSchema);

async function main() {
    const corpus = JSON.parse(readFileSync(join(OUT_DIR, "corpus.json"), "utf-8"));
    const { questions } = JSON.parse(readFileSync(join(OUT_DIR, "questions.json"), "utf-8"));
    if (!questions.some((q: { short_circuited?: boolean }) => q.short_circuited !== undefined)) {
        throw new Error("questions.json has no short_circuited field: it was generated after the short-circuit was removed");
    }
    const goldById = new Map<string, { dense_summary: string }>(corpus.chunks.map((c: { id: string; dense_summary: string }) => [c.id, c]));

    const session = await getSession(corpus.sessionId);
    const recent = (session?.memoryManager.chatHistory.slice(-3) ?? [])
        .map(t => `[Turn ${t.turn_id}] ${t.role.toUpperCase()}: ${t.text}`).join("\n");
    const context = `[Current State]\n${JSON.stringify(corpus.finalState)}\n\n[Recent Conversation]\n${recent}`;

    const rows: { qid: string; question: string; short_circuited: boolean; evidence: string; answerable: boolean }[] = [];
    for (const q of questions) {
        const verdict = await judge.invoke([
            ["system", `You check whether a question can be answered from a given CONTEXT.
You are told the correct answer (from a past memory). Decide if the CONTEXT alone contains enough information to give that answer.
Be strict: general background or the entity merely being mentioned is NOT enough; the specific fact must be stated.`],
            ["human", `CONTEXT:\n${context}\n\nQUESTION: ${q.question}\n\nCORRECT ANSWER (from memory): ${q.target_fact}\nFull memory passage: ${goldById.get(q.gold_id)?.dense_summary}`],
        ]);
        rows.push({ qid: q.qid, question: q.question, short_circuited: q.short_circuited, ...verdict });
        console.log(`${q.short_circuited ? "SC " : "RET"} ${verdict.answerable ? "answerable  " : "NOT in ctx  "} ${q.question}`);
    }

    const count = (sc: boolean, ans: boolean) => rows.filter(r => r.short_circuited === sc && r.answerable === ans).length;
    const summary = {
        short_circuited_but_not_answerable: count(true, false),
        short_circuited_and_answerable: count(true, true),
        retrieved_and_answerable: count(false, true),
        retrieved_and_not_answerable: count(false, false),
    };
    console.log(summary);
    writeFileSync(join(OUT_DIR, "router_diagnosis.json"), JSON.stringify({ summary, rows }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
