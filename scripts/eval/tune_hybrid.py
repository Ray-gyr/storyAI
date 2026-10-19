"""
混合检索（BM25 + 向量，RRF 融合）调参

第一版做法（A 组网格搜索、B 组留出验证）严重过拟合：A 组选出的配置 MRR@10 0.782，到 B 组只有 0.603，
还不如默认参数。40 道题撑不起 9 个维度的细调。因此改为用交叉验证来决定"该调多少参数"：

  1. 合并 A 组（questions.json）与 B 组（questions_holdout.json），两组的来源片段互不重叠
  2. 对每个配置算出每道题的倒数名次（reciprocal rank，名次 > 10 记 0）
  3. 按来源片段分组做 4 折交叉验证，重复 25 次。比较几种调参策略在测试折上的 MRR@10：
       none         不调参：RRF 默认（k=60, w=1, depth=10）+ BM25 默认参数 + 改写查询 + 纯向量
       bm25-only    只用 BM25（默认参数），不融合
       fusion       只调融合参数 (depth, k, w_bm25)
       fusion+input 调融合参数 + 两路的查询来源 (query, dense)
       raw-only     两路都只用玩家原话（不依赖意图翻译，检索可与之并行或彻底省掉它），只调融合参数
       full         所有维度一起调
  4. 选交叉验证得分最高的策略，在全部题目上用它选出最终参数：
     不直接取最高分，而是在 (depth, k, w_bm25) 的相邻格点上取平均后选最高，避开孤立的尖峰

搜索空间
  BM25:   field    {summary, summary+original}  索引哪些文本
          k1       {0.9, 1.2, 1.5, 2.0}
          b        {0.4, 0.6, 0.75, 0.9}
          idf      {okapi, lucene}   okapi = rank_bm25 的公式（df 过半时负值被替换为 0.25 x 平均 IDF）
          query    {enhanced, raw, both}  改写后的查询 / 玩家原话 / 两者拼接
  向量:   dense    {dense, tier, dense_raw}  见 rank_vectors.ts
  融合:   depth    {10, 20, 50}  每一路参与融合的结果数
          k        {1, 5, 10, 20, 40, 60, 100}  RRF 常数
          w_bm25   {0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 10}  BM25 一路的权重（向量一路固定为 1）
  融合分数 = 1 / (k + rank_dense) + w_bm25 / (k + rank_bm25)，不在某一路前 depth 名内则该路记 0

目标：MRR@10（线上把前 10 条全部放进 prompt，Hit@10 接近天花板，区分度不够；MRR 同时反映排序质量）。

运行：<venv>/python scripts/eval/tune_hybrid.py
输出：控制台报告 + scripts/eval/out/tuning.json（含选定参数，供线上实现使用）
"""
import itertools
import json
import math

import numpy as np
from rank_bm25 import BM25Okapi

from common import OUT_DIR, doc_text, load_corpus, tokenize

TOP_K = 10
FIELDS = {"summary": ["dense_summary"], "summary+original": ["dense_summary", "original_text"]}
K1S = [0.9, 1.2, 1.5, 2.0]
BS = [0.4, 0.6, 0.75, 0.9]
IDFS = ["okapi", "lucene"]
QUERIES = ["enhanced", "raw", "both"]
DENSES = ["dense", "tier", "dense_raw"]
DEPTHS = [10, 20, 50]
RRF_KS = [1, 5, 10, 20, 40, 60, 100]
W_BM25S = [0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0, 10.0]
EPSILON = 0.25

NAMES = ["field", "k1", "b", "idf", "query", "dense", "depth", "k", "w_bm25"]
GRIDS = [list(FIELDS), K1S, BS, IDFS, QUERIES, DENSES, DEPTHS, RRF_KS, W_BM25S]
BM25_DEFAULTS = {"field": "summary", "k1": 1.5, "b": 0.75, "idf": "okapi"}
RRF_DEFAULT = {**BM25_DEFAULTS, "query": "enhanced", "dense": "dense", "depth": 10, "k": 60, "w_bm25": 1.0}

CV_FOLDS = 4
CV_REPEATS = 25


class BM25:
    """Okapi BM25；idf="okapi" 时与 rank_bm25.BM25Okapi 完全一致，线上 TS 实现与此逐分对齐"""

    def __init__(self, docs: list[list[str]], k1: float, b: float, idf: str):
        self.k1, self.b = k1, b
        self.docs = docs
        self.doc_len = np.array([len(d) for d in docs], dtype=float)
        self.avgdl = self.doc_len.mean()
        self.tf = [{} for _ in docs]
        df: dict[str, int] = {}
        for i, d in enumerate(docs):
            for t in d:
                self.tf[i][t] = self.tf[i].get(t, 0) + 1
            for t in set(d):
                df[t] = df.get(t, 0) + 1
        n = len(docs)
        if idf == "lucene":
            self.idf = {t: math.log(1 + (n - c + 0.5) / (c + 0.5)) for t, c in df.items()}
        else:
            raw = {t: math.log(n - c + 0.5) - math.log(c + 0.5) for t, c in df.items()}
            floor = EPSILON * (sum(raw.values()) / len(raw))
            self.idf = {t: (v if v >= 0 else floor) for t, v in raw.items()}

    def scores(self, query: list[str]) -> np.ndarray:
        out = np.zeros(len(self.docs))
        norm = self.k1 * (1 - self.b + self.b * self.doc_len / self.avgdl)
        for t in query:
            idf = self.idf.get(t)
            if idf is None:
                continue
            tf = np.array([d.get(t, 0) for d in self.tf], dtype=float)
            out += idf * tf * (self.k1 + 1) / (tf + norm)
        return out


def check_parity_with_rank_bm25(docs: list[list[str]], queries: list[list[str]]) -> None:
    ours = BM25(docs, 1.5, 0.75, "okapi")
    ref = BM25Okapi(docs, k1=1.5, b=0.75, epsilon=EPSILON)
    for q in queries:
        assert np.allclose(ours.scores(q), ref.get_scores(q)), "BM25 implementation diverges from rank_bm25"


def rank_matrix(score_rows: list[np.ndarray], depth: int) -> np.ndarray:
    """每道题对每个片段的 BM25 名次（1 起）；得分为 0 或不在前 depth 名内记为 inf（与线上 bm25Rank 一致）"""
    out = np.full((len(score_rows), len(score_rows[0])), np.inf)
    for qi, s in enumerate(score_rows):
        order = np.argsort(-s, kind="stable")[:depth]
        order = order[s[order] > 0]
        out[qi, order] = np.arange(1, len(order) + 1)
    return out


def list_rank_matrix(rankings: list[list[str]], ids: list[str], depth: int) -> np.ndarray:
    pos = {d: i for i, d in enumerate(ids)}
    out = np.full((len(rankings), len(ids)), np.inf)
    for qi, r in enumerate(rankings):
        for rank, doc_id in enumerate(r[:depth], start=1):
            out[qi, pos[doc_id]] = rank
    return out


def gold_ranks(scores: np.ndarray, gold_idx: np.ndarray) -> np.ndarray:
    """融合分数下标准答案的名次；分数为 0（两路都没召回）视为未命中。并列时取平均名次"""
    g = scores[np.arange(len(gold_idx)), gold_idx][:, None]
    higher = (scores > g).sum(axis=1)
    ties = (scores == g).sum(axis=1) - 1
    ranks = 1 + higher + ties / 2
    ranks[g[:, 0] <= 0] = np.inf
    return ranks


def reciprocal(ranks: np.ndarray) -> np.ndarray:
    return np.where(ranks <= TOP_K, 1 / ranks, 0.0)


def summarize(ranks: np.ndarray) -> dict:
    return {
        "hit@5": round(float((ranks <= 5).mean()), 3),
        "hit@10": round(float((ranks <= 10).mean()), 3),
        "mrr@10": round(float(reciprocal(ranks).mean()), 3),
        "n": int(len(ranks)),
    }


class Questions:
    """A、B 两组合并后的题目，set_label 记录每道题来自哪一组"""

    def __init__(self, corpus: dict, files: dict[str, str]):
        self.questions, labels = [], []
        for label, filename in files.items():
            qs = json.loads((OUT_DIR / filename).read_text(encoding="utf-8"))["questions"]
            self.questions += qs
            labels += [label] * len(qs)
        self.set_label = np.array(labels)
        self.ids = [c["id"] for c in corpus["chunks"]]
        self.gold_idx = np.array([self.ids.index(q["gold_id"]) for q in self.questions])
        self.types = np.array([q["type"] for q in self.questions])
        self.query_tokens = {
            "enhanced": [tokenize(q["enhanced_query"]) for q in self.questions],
            "raw": [tokenize(q["question"]) for q in self.questions],
            "both": [tokenize(q["question"]) + tokenize(q["enhanced_query"]) for q in self.questions],
        }
        self.dense_lists = {d: [[m["id"] for m in q["rankings"][d]] for q in self.questions] for d in DENSES}


def main() -> None:
    corpus = load_corpus()
    chunks = corpus["chunks"]
    docs_by_field = {
        name: [tokenize(" ".join(doc_text(c, f) for f in fields)) for c in chunks]
        for name, fields in FIELDS.items()
    }
    qs = Questions(corpus, {"A": "questions.json", "B": "questions_holdout.json"})
    check_parity_with_rank_bm25(docs_by_field["summary"], qs.query_tokens["enhanced"])

    # ---- 每个配置 x 每道题的倒数名次 ----
    keys: list[tuple] = []
    rr_rows: list[np.ndarray] = []
    for field, k1, b, idf in itertools.product(FIELDS, K1S, BS, IDFS):
        model = BM25(docs_by_field[field], k1, b, idf)
        for query in QUERIES:
            bm25_scores = [model.scores(t) for t in qs.query_tokens[query]]
            for depth in DEPTHS:
                rb = rank_matrix(bm25_scores, depth)
                for dense in DENSES:
                    rd = list_rank_matrix(qs.dense_lists[dense], qs.ids, depth)
                    for k, w in itertools.product(RRF_KS, W_BM25S):
                        keys.append((field, k1, b, idf, query, dense, depth, k, w))
                        rr_rows.append(reciprocal(gold_ranks(1 / (k + rd) + w / (k + rb), qs.gold_idx)))
    rr = np.vstack(rr_rows)  # [n_configs, n_questions]
    key_index = {key: i for i, key in enumerate(keys)}
    cfg = lambda key: dict(zip(NAMES, key))  # noqa: E731
    default_i = key_index[tuple(RRF_DEFAULT[n] for n in NAMES)]

    # BM25 单独使用（不融合）的倒数名次，用于 bm25-only 基线
    bm25_default_model = BM25(docs_by_field["summary"], 1.5, 0.75, "okapi")
    bm25_only_rr = reciprocal(gold_ranks(np.array([bm25_default_model.scores(t) for t in qs.query_tokens["enhanced"]]), qs.gold_idx))

    in_a, in_b = qs.set_label == "A", qs.set_label == "B"
    print(f"questions: {len(qs.questions)} (A {in_a.sum()}, B {in_b.sum()}) | corpus: {len(chunks)} chunks | configs: {len(keys)}")

    # ---- 参数效果能否在 A、B 之间复现 ----
    mean_a, mean_b = rr[:, in_a].mean(axis=1), rr[:, in_b].mean(axis=1)
    rank_corr = np.corrcoef(np.argsort(np.argsort(mean_a)), np.argsort(np.argsort(mean_b)))[0, 1]
    print(f"\nSpearman correlation of config scores, A vs B: {rank_corr:.2f}")
    print("marginal mean MRR@10 per parameter value (A | B):")
    for i, (name, grid) in enumerate(zip(NAMES, GRIDS)):
        cells = []
        for v in grid:
            mask = np.array([key[i] == v for key in keys])
            cells.append(f"{v}: {mean_a[mask].mean():.3f}|{mean_b[mask].mean():.3f}")
        print(f"  {name:<8}" + "   ".join(cells))

    # ---- 调参策略的交叉验证 ----
    def subset(fixed: dict) -> np.ndarray:
        return np.array([i for i, key in enumerate(keys) if all(key[NAMES.index(n)] == v for n, v in fixed.items())])

    # 按调参维度由少到多排列；bm25-only 不融合，单独处理
    strategies = {
        "none": np.array([default_i]),
        "fusion": subset({**BM25_DEFAULTS, "query": "enhanced", "dense": "dense"}),
        "raw-only": subset({**BM25_DEFAULTS, "query": "raw", "dense": "dense_raw"}),
        "fusion+input": subset(BM25_DEFAULTS),
        "full": np.arange(len(keys)),
    }
    groups = np.unique(qs.gold_idx)
    rng = np.random.default_rng(0)
    cv_scores: dict[str, list[float]] = {s: [] for s in ["bm25-only", *strategies]}
    # 样本外 Hit@5：在测试折上统计命中数，所有折累加后再除以题数（"换说法"题单独统计）
    is_para = qs.types == "paraphrase"
    cv_hits = {s: {"all": [0, 0], "paraphrase": [0, 0]} for s in cv_scores}

    def count_hits(name: str, recip: np.ndarray, test: np.ndarray) -> None:
        hit = recip >= 1 / 5
        for label, mask in (("all", test), ("paraphrase", test & is_para)):
            cv_hits[name][label][0] += int(hit[mask].sum())
            cv_hits[name][label][1] += int(mask.sum())

    for _ in range(CV_REPEATS):
        fold_of_group = dict(zip(rng.permutation(groups), np.arange(len(groups)) % CV_FOLDS))
        fold = np.array([fold_of_group[g] for g in qs.gold_idx])
        for f in range(CV_FOLDS):
            train, test = fold != f, fold == f
            for name, candidates in strategies.items():
                best = candidates[np.argmax(rr[candidates][:, train].mean(axis=1))]
                cv_scores[name].append(rr[best, test].mean())
                count_hits(name, rr[best], test)
            cv_scores["bm25-only"].append(bm25_only_rr[test].mean())
            count_hits("bm25-only", bm25_only_rr, test)

    print(f"\ncross-validated MRR@10 of each tuning strategy ({CV_FOLDS}-fold grouped by source chunk, x{CV_REPEATS}):")
    print("  (paired vs bm25-only: mean difference on the same test folds, and share of folds where it wins)")
    cv_summary = {}
    base = np.array(cv_scores["bm25-only"])
    for name, values in cv_scores.items():
        diff = np.array(values) - base
        hit5 = {label: round(h / n, 3) for label, (h, n) in cv_hits[name].items()}
        cv_summary[name] = {
            "mean": round(float(np.mean(values)), 3),
            "std_over_folds": round(float(np.std(values)), 3),
            "diff_vs_bm25_only": round(float(diff.mean()), 3),
            "win_rate_vs_bm25_only": round(float((diff > 0).mean()), 2),
            "hit@5": hit5["all"],
            "hit@5_paraphrase": hit5["paraphrase"],
        }
        print(f"  {name:<14}{np.mean(values):.3f}  (fold std {np.std(values):.3f})"
              f"   vs bm25-only {diff.mean():+.3f}, wins {(diff > 0).mean():.0%} of folds"
              f"   | Hit@5 {hit5['all']:.3f}, paraphrase {hit5['paraphrase']:.3f}")

    # 与最佳策略相差不超过 TOLERANCE 时，选调参维度最少的策略，避免多出来的维度只是在拟合噪声
    TOLERANCE = 0.005
    best_cv = max(np.mean(cv_scores[s]) for s in strategies)
    best_strategy = next(s for s in strategies if np.mean(cv_scores[s]) >= best_cv - TOLERANCE)

    # ---- 用选中的策略，在全部题目上选出最终参数（邻域平滑） ----
    overall = rr.mean(axis=1)

    def smoothed(i: int) -> float:
        *head, depth, k, w = keys[i]
        di, ki, wi = DEPTHS.index(depth), RRF_KS.index(k), W_BM25S.index(w)
        return float(np.mean([
            overall[key_index[(*head, DEPTHS[a], RRF_KS[c], W_BM25S[e])]]
            for a in range(max(0, di - 1), min(len(DEPTHS), di + 2))
            for c in range(max(0, ki - 1), min(len(RRF_KS), ki + 2))
            for e in range(max(0, wi - 1), min(len(W_BM25S), wi + 2))
        ]))

    def pick(strategy: str) -> int:
        return max(strategies[strategy], key=smoothed)

    chosen_i = pick(best_strategy)
    chosen = cfg(keys[chosen_i])
    print(f"\nchosen strategy: {best_strategy} (simplest within {TOLERANCE} of the best CV score)")
    print(f"chosen config (neighbourhood-smoothed on all {len(qs.questions)} questions): {chosen}")
    for name in strategies:
        if name == "none":
            continue
        i = pick(name)
        print(f"  {name:<13} pick: all {overall[i]:.3f} / A {rr[i, in_a].mean():.3f} / B {rr[i, in_b].mean():.3f}"
              f" (neighbourhood {smoothed(i):.3f})  {cfg(keys[i])}")

    # BM25 权重的走势：权重很大时融合结果退化为"BM25 排序 + 向量打破平局"
    *head, depth_c, k_c, _ = keys[chosen_i]
    print("MRR@10 vs w_bm25 around the chosen config:",
          "  ".join(f"{w}: {overall[key_index[(*head, depth_c, k_c, w)]]:.3f}" for w in W_BM25S))
    print("MRR@10 vs k around the chosen config:",
          "  ".join(f"{k}: {overall[key_index[(*head, depth_c, k, keys[chosen_i][8])]]:.3f}" for k in RRF_KS))

    # ---- 汇总对比 ----
    def ranks_of(i: int) -> np.ndarray:
        return rr[i]

    def single_list(dense: str) -> np.ndarray:
        rd = list_rank_matrix(qs.dense_lists[dense], qs.ids, TOP_K)
        return reciprocal(gold_ranks(np.where(np.isinf(rd), 0, 1 / rd), qs.gold_idx))

    rows = {
        "tier (old production)": single_list("tier"),
        "dense": single_list("dense"),
        "bm25 (defaults)": bm25_only_rr,
        "rrf default (k=60, w=1, depth 10)": ranks_of(default_i),
        f"rrf chosen ({best_strategy})": ranks_of(chosen_i),
        "rrf raw-only (smoothed pick)": ranks_of(pick("raw-only")),
    }
    print(f"\n{'MRR@10 / Hit@5':<36}{'all':>14}{'A':>14}{'B':>14}{'verbatim':>14}{'paraphrase':>14}")
    table = {}
    for name, recip in rows.items():
        cells, table[name] = [], {}
        for label, mask in (("all", np.ones(len(recip), bool)), ("A", in_a), ("B", in_b),
                            ("verbatim", qs.types == "verbatim"), ("paraphrase", qs.types == "paraphrase")):
            mrr, hit5 = recip[mask].mean(), (recip[mask] >= 1 / 5).mean()
            table[name][label] = {"mrr@10": round(float(mrr), 3), "hit@5": round(float(hit5), 3), "n": int(mask.sum())}
            cells.append(f"{mrr:.3f} / {hit5:.2f}")
        print(f"{name:<36}" + "".join(f"{c:>14}" for c in cells))

    (OUT_DIR / "tuning.json").write_text(json.dumps({
        "chosen": chosen,
        "strategy": best_strategy,
        "raw_only_pick": cfg(keys[pick("raw-only")]),
        "cross_validation": cv_summary,
        "a_vs_b_spearman": round(float(rank_corr), 3),
        "comparison": table,
    }, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
