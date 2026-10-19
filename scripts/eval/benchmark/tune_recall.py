"""
基准测试 · 开发阶段调融合方式（PROTOCOL.md 第 7 节）。只使用 dev 故事与试点故事。

目标：Recall@10（写作模型拿到的是前 10 个片段组成的集合，顺序不重要）。
输入两路排序（与线上一致）：BM25（原话 + 改写句）前 30，向量（原话）前 30。
候选融合方式：
  current   线上现行：RRF depth 10, k 60, BM25 权重 4（0 个参数）
  bm25      只用 BM25 前 10；vector：只用向量前 10（0 个参数）
  quota     先取 BM25 前 a 名，再按向量排序补满 10 个（1 个参数 a）
  rrf       加权 RRF，网格搜索 depth / k / 权重（3 个参数）
按来源片段分组做 4 折交叉验证 x25；与最佳交叉验证分数相差不超过 0.01 时选参数最少的方式。

运行：python scripts/eval/benchmark/tune_recall.py
输出：scripts/eval/benchmark/out/dev/tuning_recall.json
"""
import itertools
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from common import OUT_DIR as PILOT_DIR, tokenize  # noqa: E402
from tune_hybrid import BM25  # noqa: E402

DEV = HERE / "out" / "dev"
TOP_K = 10
CV_FOLDS, CV_REPEATS, TOLERANCE = 4, 25, 0.01
RRF_GRID = {"depth": [10, 20, 30], "k": [1, 5, 10, 20, 40, 60, 100], "w": [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0]}


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


# ---- 实例：(两路排序, 正确片段集合, 分组) ----
instances = []

# dev 故事：每道有效题在每个快照上是一个实例
questions = {q["qid"]: q for q in load(DEV / "questions.json")["questions"]}
labels = load(DEV / "labels.json")
created = {c["id"]: c["created_at"] for c in load(DEV / "corpus.json")["chunks"]}
taken = {r: load(DEV / f"snapshot_{r}.json")["taken_at"] for r in (100, 200, 300)}
for row in load(DEV / "retrieval.json")["rows"]:
    q = questions[row["qid"]]
    cands = labels["candidates"][row["qid"]]
    if not cands[q["source_id"]]["acceptable"]:
        continue
    gold = {cid for cid, v in cands.items() if v["acceptable"] and created[cid] <= taken[row["snapshot"]]}
    instances.append({"bm25": row["rankings"]["bm25"], "vector": row["rankings"]["vector"], "gold": gold,
                      "group": f"dev:{q['source_id']}", "source": "dev"})

# 试点故事：88 道题，唯一正确片段为出题片段
pilot_corpus = load(PILOT_DIR / "corpus.json")
pilot_ids = [c["id"] for c in pilot_corpus["chunks"]]
pilot_bm25 = BM25([tokenize(c["dense_summary"]) for c in pilot_corpus["chunks"]], 1.5, 0.75, "okapi")
for name in ("questions.json", "questions_holdout.json"):
    for q in load(PILOT_DIR / name)["questions"]:
        scores = pilot_bm25.scores(tokenize(q["question"]) + tokenize(q["enhanced_query"]))
        order = [i for i in np.argsort(-scores, kind="stable") if scores[i] > 0][:30]
        instances.append({"bm25": [pilot_ids[i] for i in order], "vector": [m["id"] for m in q["rankings"]["dense_raw"][:30]],
                          "gold": {q["gold_id"]}, "group": f"pilot:{q['gold_id']}", "source": "pilot"})


# ---- 融合方式 ----
def rrf(inst, depth, k, w):
    score = {}
    for r, d in enumerate(inst["vector"][:depth], 1):
        score[d] = score.get(d, 0) + 1 / (k + r)
    for r, d in enumerate(inst["bm25"][:depth], 1):
        score[d] = score.get(d, 0) + w / (k + r)
    return sorted(score, key=lambda d: -score[d])[:TOP_K]


def quota(inst, a):
    picked = list(inst["bm25"][:a])
    for d in inst["vector"] + inst["bm25"][a:]:
        if len(picked) >= TOP_K:
            break
        if d not in picked:
            picked.append(d)
    return picked


configs = {("current",): lambda i: rrf(i, 10, 60, 4.0),
           ("bm25",): lambda i: i["bm25"][:TOP_K],
           ("vector",): lambda i: i["vector"][:TOP_K]}
configs.update({("quota", a): (lambda i, a=a: quota(i, a)) for a in range(TOP_K + 1)})
configs.update({("rrf", d, k, w): (lambda i, d=d, k=k, w=w: rrf(i, d, k, w))
                for d, k, w in itertools.product(*RRF_GRID.values())})

keys = list(configs)
hits = np.array([[bool(inst["gold"] & set(configs[key](inst))) for inst in instances] for key in keys], dtype=float)
strategies = {
    "current": [keys.index(("current",))],
    "bm25": [keys.index(("bm25",))],
    "vector": [keys.index(("vector",))],
    "quota": [i for i, k in enumerate(keys) if k[0] == "quota"],
    "rrf": [i for i, k in enumerate(keys) if k[0] == "rrf"],
}
complexity = {"current": 0, "bm25": 0, "vector": 0, "quota": 1, "rrf": 3}

# ---- 交叉验证 ----
groups = np.array([inst["group"] for inst in instances])
unique_groups = np.unique(groups)
rng = np.random.default_rng(0)
cv = {s: [] for s in strategies}
for _ in range(CV_REPEATS):
    fold_of = dict(zip(rng.permutation(unique_groups), np.arange(len(unique_groups)) % CV_FOLDS))
    fold = np.array([fold_of[g] for g in groups])
    for f in range(CV_FOLDS):
        train, test = fold != f, fold == f
        for s, idx in strategies.items():
            best = idx[int(np.argmax(hits[idx][:, train].mean(axis=1)))]
            cv[s].append(hits[best, test].mean())

source = np.array([inst["source"] for inst in instances])
print(f"instances: {len(instances)} (dev {np.sum(source == 'dev')}, pilot {np.sum(source == 'pilot')}); groups {len(unique_groups)}")
print(f"union ceiling (BM25 top10 ∪ vector top10): {np.mean([bool(i['gold'] & set(i['bm25'][:10] + i['vector'][:10])) for i in instances]):.3f}")
print("\ncross-validated Recall@10:")
for s, v in cv.items():
    print(f"  {s:<8} {np.mean(v):.3f}  (fold std {np.std(v):.3f}, {complexity[s]} tuned params)")

best_cv = max(np.mean(v) for v in cv.values())
chosen_strategy = min((s for s in strategies if np.mean(cv[s]) >= best_cv - TOLERANCE), key=lambda s: (complexity[s], -np.mean(cv[s])))
idx = strategies[chosen_strategy]
chosen = keys[idx[int(np.argmax(hits[idx].mean(axis=1)))]]
print(f"\nchosen strategy: {chosen_strategy} (fewest params within {TOLERANCE} of best CV {best_cv:.3f}) -> config {chosen}")

if chosen_strategy == "quota":
    print("quota curve (in-sample Recall@10 by a):", "  ".join(f"{a}: {hits[keys.index(('quota', a))].mean():.3f}" for a in range(TOP_K + 1)))
c = keys.index(chosen)
for name in ("dev", "pilot"):
    m = source == name
    print(f"  chosen in-sample on {name}: {hits[c, m].mean():.3f}   current: {hits[keys.index(('current',)), m].mean():.3f}")

(DEV / "tuning_recall.json").write_text(json.dumps({
    "instances": len(instances),
    "cv_recall@10": {s: round(float(np.mean(v)), 3) for s, v in cv.items()},
    "chosen_strategy": chosen_strategy,
    "chosen_config": list(chosen),
}, indent=2), encoding="utf-8")
