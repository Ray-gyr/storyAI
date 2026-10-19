"""
线上 BM25（src/lib/bm25.ts）与离线调参用的 Python 实现逐分对齐检查（下）：
比对分词结果与得分。tune_hybrid.BM25 本身已与 rank_bm25 对齐，这里同时用两者比对。

运行：npx tsx scripts/eval/check_bm25_parity.ts && <venv>/python scripts/eval/check_bm25_parity.py
"""
import json

import numpy as np
from rank_bm25 import BM25Okapi

from common import OUT_DIR, load_corpus, tokenize
from tune_hybrid import BM25

ts = json.loads((OUT_DIR / "bm25_parity_ts.json").read_text(encoding="utf-8"))
corpus = load_corpus()
questions = {
    q["qid"] + f"@{name}": q
    for name in ("questions.json", "questions_holdout.json")
    for q in json.loads((OUT_DIR / name).read_text(encoding="utf-8"))["questions"]
}

py_docs = [tokenize(c["dense_summary"]) for c in corpus["chunks"]]
assert py_docs == ts["docs"], "document tokenization differs between TS and Python"

ours = BM25(py_docs, 1.5, 0.75, "okapi")
ref = BM25Okapi(py_docs, k1=1.5, b=0.75, epsilon=0.25)
all_questions = list(questions.values())
assert len(all_questions) == len(ts["rows"])

max_diff = 0.0
for q, row in zip(all_questions, ts["rows"]):
    query = tokenize(q["question"]) + tokenize(q["enhanced_query"])
    assert query == row["query"], f"query tokenization differs for {row['qid']}"
    ts_scores = np.array(row["scores"])
    for py_scores in (ours.scores(query), ref.get_scores(query)):
        max_diff = max(max_diff, float(np.abs(ts_scores - py_scores).max()))
        assert np.allclose(ts_scores, py_scores, atol=1e-9), f"scores differ for {row['qid']}"

print(f"OK: tokenization identical, scores match rank_bm25 on {len(ts['rows'])} queries x {len(py_docs)} docs "
      f"(max abs diff {max_diff:.2e})")
