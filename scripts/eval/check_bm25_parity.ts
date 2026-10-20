/**
 * 线上 BM25（src/lib/bm25.ts）与离线调参用的 Python 实现逐分对齐检查（上）：
 * 用线上代码对全部题目的查询打分，写出分词结果与得分，由 check_bm25_parity.py 比对。
 *
 * 运行：npx tsx scripts/eval/check_bm25_parity.ts && <venv>/python scripts/eval/check_bm25_parity.py
 * 输出：scripts/eval/out/bm25_parity_ts.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BM25, tokenize } from "../../src/lib/bm25";
import { HYBRID_RETRIEVAL_CONFIG } from "../../src/lib/hybridRetriever";

const OUT_DIR = join(process.cwd(), "scripts", "eval", "out");

type Q = { qid: string; question: string; enhanced_query: string };

const corpus = JSON.parse(readFileSync(join(OUT_DIR, "corpus.json"), "utf-8"));
const docs: string[][] = corpus.chunks.map((c: { dense_summary: string }) => tokenize(c.dense_summary));
const bm25 = new BM25(docs, HYBRID_RETRIEVAL_CONFIG.bm25);

const questions: Q[] = ["questions.json", "questions_holdout.json"].flatMap(f =>
    JSON.parse(readFileSync(join(OUT_DIR, f), "utf-8")).questions);

const rows = questions.map(q => {
    // 与线上 rankMemories 相同："原话 + 增强查询"
    const query = [...tokenize(q.question), ...tokenize(q.enhanced_query)];
    return { qid: q.qid, query, scores: bm25.scores(query) };
});

writeFileSync(join(OUT_DIR, "bm25_parity_ts.json"), JSON.stringify({ docs, rows }));
console.log(`scored ${rows.length} queries over ${docs.length} docs`);
