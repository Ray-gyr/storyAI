/**
 * 用线上检索代码（hybridRetriever.rankMemories）在全部题目上重算指标，
 * 确认上线实现与离线调参（tune_hybrid.py 的 "rrf chosen" 一行）一致。
 *
 * 运行：npx tsx --env-file=.env scripts/eval/eval_production.ts
 * 输入：scripts/eval/out/questions.json, scripts/eval/out/questions_holdout.json
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rankMemories, startDenseSearch } from "../../src/lib/hybridRetriever";
import { QueryIntent } from "../../src/lib/query";

const OUT_DIR = join(process.cwd(), "scripts", "eval", "out");

type Q = { qid: string; type: string; question: string; gold_id: string; intent: QueryIntent };

async function main() {
    const sets: Record<string, { sessionId: string; questions: Q[] }> = {
        A: JSON.parse(readFileSync(join(OUT_DIR, "questions.json"), "utf-8")),
        B: JSON.parse(readFileSync(join(OUT_DIR, "questions_holdout.json"), "utf-8")),
    };

    const rows: { set: string; type: string; rank: number }[] = [];
    for (const [set, { sessionId, questions }] of Object.entries(sets)) {
        for (const q of questions) {
            const ranked = await rankMemories({
                rawInput: q.question,
                intent: q.intent,
                dense: startDenseSearch(q.question, sessionId),
                sessionId,
            });
            const pos = ranked.findIndex(m => m.id === q.gold_id);
            rows.push({ set, type: q.type, rank: pos >= 0 ? pos + 1 : Infinity });
        }
    }

    const report = (label: string, subset: typeof rows) => {
        const mrr = subset.reduce((s, r) => s + (r.rank <= 10 ? 1 / r.rank : 0), 0) / subset.length;
        const hit5 = subset.filter(r => r.rank <= 5).length / subset.length;
        const hit10 = subset.filter(r => r.rank <= 10).length / subset.length;
        console.log(`${label.padEnd(12)} n=${String(subset.length).padEnd(4)} MRR@10 ${mrr.toFixed(3)}  Hit@5 ${hit5.toFixed(2)}  Hit@10 ${hit10.toFixed(2)}`);
    };
    report("all", rows);
    report("A", rows.filter(r => r.set === "A"));
    report("B", rows.filter(r => r.set === "B"));
    report("verbatim", rows.filter(r => r.type === "verbatim"));
    report("paraphrase", rows.filter(r => r.type === "paraphrase"));
}

main().catch(e => { console.error(e); process.exit(1); });
