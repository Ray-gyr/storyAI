"""
基准测试 · 结果分析（PROTOCOL.md 第 8 节）

  - 主指标：v2 在第 300 回合快照上的 Recall@10（全部有效题目）
  - 各方法在第 300 回合快照上的 Recall@10 / Recall@5，95% bootstrap 区间，v2 相对 v1 的配对差值
  - 长度曲线：early 题在第 100 / 200 / 300 回合快照上的 Recall@10
  - 按题型；v2 未命中的题按"摘要里有没有答案"拆分

一道题在快照 T 的正确片段 = 被判为可接受、且在 T 时已存在的片段；Recall@k = 前 k 名里至少有一个正确片段。

运行：python scripts/eval/benchmark/analyze.py <dev|test>
输出：out/<story>/results.json
"""
import json
import sys
from pathlib import Path

import numpy as np

STORY = sys.argv[1]
DIR = Path(__file__).resolve().parent / "out" / STORY
SNAPSHOTS = [100, 200, 300]
METHODS = ["tier", "bm25", "vector", "v2"]
LABELS = {"tier": "v1 tier search", "bm25": "BM25 only", "vector": "vector only", "v2": "v2 hybrid", "union": "union ceiling (BM25 ∪ vector)"}
BOOTSTRAP = 10_000
rng = np.random.default_rng(0)


def load(name):
    return json.loads((DIR / name).read_text(encoding="utf-8"))


questions = {q["qid"]: q for q in load("questions.json")["questions"]}
rows = load("retrieval.json")["rows"]
labels = load("labels.json")
created = {c["id"]: c["created_at"] for c in load("corpus.json")["chunks"]}
taken = {r: load(f"snapshot_{r}.json")["taken_at"] for r in SNAPSHOTS}
corpus_size = {r: sum(1 for t in created.values() if t <= taken[r]) for r in SNAPSHOTS}

# 有效题：有 validation.json（question set 2）时以它为准，否则只要求来源片段能回答
if (DIR / "validation.json").exists():
    validation = load("validation.json")
    valid = {qid for qid in questions if validation[qid]["valid"]}
else:
    valid = {qid for qid, q in questions.items() if labels["candidates"][qid][q["source_id"]]["acceptable"]}


def gold(qid, snapshot):
    return {cid for cid, v in labels["candidates"][qid].items() if v["acceptable"] and created[cid] <= taken[snapshot]}


def hit(row, method, k):
    g = gold(row["qid"], row["snapshot"])
    if method == "union":
        ranked = row["rankings"]["bm25"][:10] + row["rankings"]["vector"][:10]
    else:
        ranked = row["rankings"][method][:k]
    return bool(g & set(ranked))


def ci(values):
    values = np.asarray(values, dtype=float)
    boots = rng.choice(values, size=(BOOTSTRAP, len(values)), replace=True).mean(axis=1)
    return [round(float(np.percentile(boots, 2.5)), 3), round(float(np.percentile(boots, 97.5)), 3)]


def summarize(rows_, method, k=10):
    hits = [hit(r, method, k) for r in rows_]
    return {"recall": round(float(np.mean(hits)), 3), "ci95": ci(hits), "n": len(hits)} if hits else None


at300 = [r for r in rows if r["snapshot"] == 300 and r["qid"] in valid]
report = {
    "story": STORY,
    "questions": {"generated": len(questions), "valid": len(valid), "dropped": sorted(set(questions) - valid)},
    "corpus_size": corpus_size,
    "primary_v2_recall@10_at_300": summarize(at300, "v2"),
    "at_300": {m: {"recall@10": summarize(at300, m), "recall@5": summarize(at300, m, 5) if m != "union" else None} for m in [*METHODS, "union"]},
}

# v2 相对 v1 的配对差值
diff = [int(hit(r, "v2", 10)) - int(hit(r, "tier", 10)) for r in at300]
report["paired_v2_minus_tier_at_300"] = {"mean": round(float(np.mean(diff)), 3), "ci95": ci(diff)}

# 长度曲线：在三个快照上都有结果的 early 题
early_q = {qid for qid in valid if questions[qid]["pool"] == "early"}
curve_q = {qid for qid in early_q if all(any(r["qid"] == qid and r["snapshot"] == s for r in rows) for s in SNAPSHOTS)}
report["curve_early"] = {
    m: {s: summarize([r for r in rows if r["snapshot"] == s and r["qid"] in curve_q], m) for s in SNAPSHOTS}
    for m in [*METHODS, "union"]
}

# 按题型
report["by_type_at_300"] = {
    t: {m: summarize([r for r in at300 if questions[r["qid"]]["type"] == t], m) for m in METHODS}
    for t in ("detail", "vague", "temporal")
}

# v2 未命中的题：摘要里有没有答案
misses = [r for r in at300 if not hit(r, "v2", 10)]
in_summary = [labels["summary_has_answer"][r["qid"]]["acceptable"] for r in at300]
report["summary_attribution_at_300"] = {
    "share_of_questions_with_answer_in_summary": round(float(np.mean(in_summary)), 3),
    "v2_recall@10_answer_in_summary": summarize([r for r in at300 if labels["summary_has_answer"][r["qid"]]["acceptable"]], "v2"),
    "v2_recall@10_answer_only_in_original": summarize([r for r in at300 if not labels["summary_has_answer"][r["qid"]]["acceptable"]], "v2"),
    "v2_misses": len(misses),
    "v2_misses_answer_in_summary": sum(labels["summary_has_answer"][r["qid"]]["acceptable"] for r in misses),
}

(DIR / "results.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")


def fmt(s):
    return f"{s['recall']:.3f} [{s['ci95'][0]:.2f}, {s['ci95'][1]:.2f}] (n={s['n']})" if s else "-"


print(f"story: {STORY} | questions valid {len(valid)}/{len(questions)} | corpus size {corpus_size}")
print(f"\nPRIMARY  v2 Recall@10 @ round 300: {fmt(report['primary_v2_recall@10_at_300'])}")
print("\nRound-300 snapshot:")
for m in [*METHODS, "union"]:
    r10, r5 = report["at_300"][m]["recall@10"], report["at_300"][m]["recall@5"]
    print(f"  {LABELS[m]:<32} R@10 {fmt(r10)}   R@5 {fmt(r5) if r5 else '-'}")
p = report["paired_v2_minus_tier_at_300"]
print(f"  paired v2 - v1: {p['mean']:+.3f} [{p['ci95'][0]:+.2f}, {p['ci95'][1]:+.2f}]")
print(f"\nLength curve (early questions, n={len(curve_q)}), Recall@10 at rounds {SNAPSHOTS}, corpus {[corpus_size[s] for s in SNAPSHOTS]} chunks:")
for m in [*METHODS, "union"]:
    print(f"  {LABELS[m]:<32}" + "   ".join(f"{report['curve_early'][m][s]['recall']:.3f}" for s in SNAPSHOTS))
print("\nBy type @300 (Recall@10):")
for t, by_m in report["by_type_at_300"].items():
    print(f"  {t:<9}" + "   ".join(f"{m} {by_m[m]['recall']:.3f}" for m in METHODS if by_m[m]) + f"   (n={by_m['v2']['n'] if by_m['v2'] else 0})")
a = report["summary_attribution_at_300"]
print(f"\nAnswer present in the source chunk's summary: {a['share_of_questions_with_answer_in_summary']:.0%} of questions")
print(f"  v2 R@10 when answer in summary: {fmt(a['v2_recall@10_answer_in_summary'])}")
print(f"  v2 R@10 when answer only in original text: {fmt(a['v2_recall@10_answer_only_in_original'])}")
print(f"  v2 misses: {a['v2_misses']} ({a['v2_misses_answer_in_summary']} had the answer in the summary)")
