"""
检索实验 · 第二、三步：BM25 对比 + 结果分布

方法（输入都是同一个经过意图翻译的增强查询，与线上 tier search 完全一致）：
  tier         现有 tier search：带实体过滤的向量检索优先，不足 10 条用无过滤向量检索补齐
  bm25         纯 BM25（rank_bm25.BM25Okapi，本地内存）
  bm25+filter  BM25 套用与 tier search 完全相同的实体过滤与补齐逻辑
附加参考（零成本，已有数据顺带算出）：
  dense        纯向量检索（无实体过滤）—— 用来拆分 tier search 的优势来自过滤还是来自向量
  bm25(raw)    BM25 直接用玩家原始问题（不经过意图翻译）
  bm25(no-ent) BM25 用增强查询，但去掉所有实体词 —— 看实体词对 BM25 是帮忙还是添乱
  rrf(...)     最朴素的混合检索：两路各取前 10，Reciprocal Rank Fusion (k=60) 合并，不调参

运行：<venv>/python scripts/eval/bm25_eval.py
输入：scripts/eval/out/corpus.json, scripts/eval/out/questions.json
输出：控制台表格 + scripts/eval/out/results.json
"""
import json
import statistics

from rank_bm25 import BM25Okapi

from common import OUT_DIR, doc_text, entity_names, load_corpus, tokenize

TOP_K = 10
FIELD = "dense_summary"  # 与向量侧一致：tier search 向量化的就是这个字段


def matches_filter(chunk: dict, intent: dict) -> bool:
    """复刻 Pinecone 的 $or + $in 过滤：角色/物品列表有交集，或地点命中"""
    if set(chunk.get("characters_involved") or []) & set(intent["characters_involved"]):
        return True
    if set(chunk.get("items_involved") or []) & set(intent["items_involved"]):
        return True
    return chunk.get("location") in set(intent["locations_involved"])


def has_filter(intent: dict) -> bool:
    return bool(intent["characters_involved"] or intent["items_involved"] or intent["locations_involved"])


def rank_ids(scores, ids: list[str], allowed: set[str] | None = None) -> list[str]:
    order = sorted(range(len(ids)), key=lambda i: -scores[i])
    return [ids[i] for i in order if allowed is None or ids[i] in allowed][:TOP_K]


def merge_tiers(filtered: list[str] | None, unfiltered: list[str]) -> list[str]:
    merged: list[str] = []
    for doc_id in (filtered or []) + unfiltered:
        if len(merged) >= TOP_K:
            break
        if doc_id not in merged:
            merged.append(doc_id)
    return merged


def rrf(*rankings: list[str], k: int = 60) -> list[str]:
    """Reciprocal Rank Fusion：score(d) = Σ 1 / (k + rank)，未出现在某一路结果中的文档该路记 0"""
    scores: dict[str, float] = {}
    for ranking in rankings:
        for rank, doc_id in enumerate(ranking, start=1):
            scores[doc_id] = scores.get(doc_id, 0.0) + 1 / (k + rank)
    return sorted(scores, key=lambda d: -scores[d])[:TOP_K]


def metrics(rankings: list[list[str]], golds: list[str]) -> dict:
    def rr(r, g):
        return 1 / (r.index(g) + 1) if g in r else 0.0
    n = len(golds)
    return {
        "hit@5": round(sum(g in r[:5] for r, g in zip(rankings, golds)) / n, 3),
        "hit@10": round(sum(g in r[:10] for r, g in zip(rankings, golds)) / n, 3),
        "mrr@10": round(sum(rr(r, g) for r, g in zip(rankings, golds)) / n, 3),
        "n": n,
    }


def main() -> None:
    corpus = load_corpus()
    chunks = corpus["chunks"]
    ids = [c["id"] for c in chunks]
    by_id = {c["id"]: c for c in chunks}
    questions = json.loads((OUT_DIR / "questions.json").read_text(encoding="utf-8"))["questions"]

    docs = [tokenize(doc_text(c, FIELD)) for c in chunks]
    bm25 = BM25Okapi(docs)
    df: dict[str, int] = {}
    for d in docs:
        for t in set(d):
            df[t] = df.get(t, 0) + 1

    entity_tokens = {t for names in entity_names(corpus["finalState"]).values() for n in names for t in tokenize(n)}

    rows = []
    for q in questions:
        intent = q["intent"]
        query_tokens = tokenize(q["enhanced_query"])
        scores = bm25.get_scores(query_tokens)
        bm25_rank = rank_ids(scores, ids)

        filtered = None
        if has_filter(intent):
            allowed = {c["id"] for c in chunks if matches_filter(c, intent)}
            filtered = rank_ids(scores, ids, allowed)

        raw_rank = rank_ids(bm25.get_scores(tokenize(q["question"])), ids)
        no_entity_rank = rank_ids(bm25.get_scores([t for t in query_tokens if t not in entity_tokens]), ids)

        # 操纵检验：问题里非实体实词有多少出现在标准答案片段中（verbatim 应明显高于 paraphrase）
        gold_tokens = set(docs[ids.index(q["gold_id"])])

        def overlap(tokens: list[str]) -> float | None:
            content = [t for t in set(tokens) if t not in entity_tokens]
            return round(sum(t in gold_tokens for t in content) / len(content), 3) if content else None

        # 问题里最有区分度（最少见）的实体词的 df：只要有一个罕见实体，BM25 就有可用的实体信号
        q_entity_tokens = [t for t in set(query_tokens) if t in entity_tokens and t in df]
        min_entity_df = min((df[t] / len(chunks) for t in q_entity_tokens), default=None)

        rows.append({
            "qid": q["qid"],
            "type": q["type"],
            "question": q["question"],
            "enhanced_query": q["enhanced_query"],
            "gold_id": q["gold_id"],
            "gold_turns": q["gold_turns"],
            # 只有在移除短路之前生成的 questions.json 里才有这个字段
            "short_circuited": q.get("short_circuited"),
            "overlap_raw": overlap(tokenize(q["question"])),
            "overlap_enhanced": overlap(query_tokens),
            "min_entity_df": round(min_entity_df, 3) if min_entity_df is not None else None,
            "filter_candidates": len([c for c in chunks if matches_filter(c, intent)]) if has_filter(intent) else None,
            "rankings": {
                "tier": [m["id"] for m in q["rankings"]["tier"]],
                "bm25": bm25_rank,
                "bm25+filter": merge_tiers(filtered, bm25_rank),
                "dense": [m["id"] for m in q["rankings"]["dense"]],
                "bm25(raw)": raw_rank,
                "bm25(no-ent)": no_entity_rank,
            },
        })

    for r in rows:
        rk = r["rankings"]
        rk["rrf(tier+bm25)"] = rrf(rk["tier"], rk["bm25"])
        rk["rrf(dense+bm25)"] = rrf(rk["dense"], rk["bm25"])

    methods = ["tier", "bm25", "bm25+filter", "dense", "bm25(raw)", "bm25(no-ent)", "rrf(tier+bm25)", "rrf(dense+bm25)"]

    def table(subset: list[dict]) -> dict:
        return {m: metrics([r["rankings"][m] for r in subset], [r["gold_id"] for r in subset]) for m in methods}

    groups = {
        "all": rows,
        "verbatim": [r for r in rows if r["type"] == "verbatim"],
        "paraphrase": [r for r in rows if r["type"] == "paraphrase"],
    }
    # 按"问题能提供的最佳实体信号"分组：最少见的实体词也出现在一半以上片段里 = 实体信号被压平
    groups["only-common-entities (min df>=0.5)"] = [r for r in rows if r["min_entity_df"] is None or r["min_entity_df"] >= 0.5]
    groups["has-rare-entity (min df<0.5)"] = [r for r in rows if r["min_entity_df"] is not None and r["min_entity_df"] < 0.5]

    results = {name: table(subset) for name, subset in groups.items() if subset}

    def mean(values):
        values = [v for v in values if v is not None]
        return round(sum(values) / len(values), 3) if values else None

    manipulation = {
        t: {
            "overlap_raw": mean(r["overlap_raw"] for r in groups[t]),
            "overlap_enhanced": mean(r["overlap_enhanced"] for r in groups[t]),
        }
        for t in ("verbatim", "paraphrase")
    }

    print(f"corpus: {len(chunks)} chunks | questions: {len(rows)} | field: {FIELD}")
    candidates = [r["filter_candidates"] for r in rows if r["filter_candidates"] is not None]
    print(f"entity filter: applied to {len(candidates)}/{len(rows)} questions, "
          f"avg {statistics.mean(candidates):.1f}/{len(chunks)} chunks pass the filter")
    if any(r["short_circuited"] is not None for r in rows):
        print(f"short-circuited by the (since removed) intent router: "
              f"{sum(bool(r['short_circuited']) for r in rows)}/{len(rows)}")
    print("manipulation check (share of question's non-entity words found in gold chunk):", manipulation)
    for name, table_ in results.items():
        print(f"\n--- {name} (n={table_['tier']['n']}) ---")
        print(f"{'method':<17}{'hit@5':>8}{'hit@10':>8}{'mrr@10':>8}")
        for m in methods:
            s = table_[m]
            print(f"{m:<17}{s['hit@5']:>8}{s['hit@10']:>8}{s['mrr@10']:>8}")

    (OUT_DIR / "results.json").write_text(json.dumps({
        "field": FIELD,
        "n_chunks": len(chunks),
        "manipulation": manipulation,
        "short_circuited": sum(bool(r["short_circuited"]) for r in rows),
        "results": results,
        "per_question": rows,
    }, indent=2, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
