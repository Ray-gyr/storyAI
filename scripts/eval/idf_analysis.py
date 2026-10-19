"""
检索实验 · 第一步：验证前提
"主要实体名出现在大多数片段里，导致它们的 IDF 被压平"是否成立？

统计每个实体出现在多少比例的片段中，计算 IDF，并与普通事件词对比。
语料 = Pinecone 里的记忆片段；默认用 dense_summary（tier search 做向量化的正是这个字段），
同时给出 original_text 作为对照。

运行：<venv>/python scripts/eval/idf_analysis.py
输出：控制台表格 + scripts/eval/out/idf_report.json
"""
import json
import re
import statistics

from rank_bm25 import BM25Okapi

from common import OUT_DIR, PROTAGONIST, TITLE_WORDS, doc_text, entity_names, load_corpus, lucene_idf, okapi_raw_idf, tokenize


def analyze(chunks: list[dict], entities: dict[str, list[str]], field: str) -> dict:
    docs = [tokenize(doc_text(c, field)) for c in chunks]
    n_docs = len(docs)
    bm25 = BM25Okapi(docs)  # bm25.idf 是 rank_bm25 实际用于打分的 IDF（负值已被替换为 epsilon * 平均 IDF）
    doc_sets = [set(d) for d in docs]
    df = {}
    for s in doc_sets:
        for t in s:
            df[t] = df.get(t, 0) + 1

    lowered_docs = [doc_text(c, field).lower() for c in chunks]
    entity_tokens: set[str] = set()
    entity_rows = []

    def add_row(etype: str, name: str, patterns: list[str], key_tokens: list[str]) -> None:
        # 实体层面：片段里只要出现任一指称就算"提及"
        regexes = [re.compile(rf"\b{re.escape(p)}\b") for p in patterns]
        mention_df = sum(1 for d in lowered_docs if any(r.search(d) for r in regexes))
        # 词层面：BM25 只看词，取该实体最有区分度（df 最小）的词——这是对 BM25 最有利的情况
        tokens = [t for t in key_tokens if t in df]
        best = min(tokens, key=lambda t: df[t]) if tokens else None
        entity_rows.append({
            "type": etype,
            "name": name,
            "mention_df_pct": round(100 * mention_df / n_docs, 1),
            "mention_idf_lucene": round(lucene_idf(n_docs, mention_df), 3),
            "best_token": best,
            "token_df_pct": round(100 * df[best] / n_docs, 1) if best else 0.0,
            "idf_rank_bm25": round(bm25.idf[best], 3) if best else None,
            "idf_okapi_raw": round(okapi_raw_idf(n_docs, df[best]), 3) if best else None,
            "idf_lucene": round(lucene_idf(n_docs, df[best]), 3) if best else None,
        })

    character_tokens = {t for n in entities["character"] for t in tokenize(n)}
    for etype, names in entities.items():
        for name in names:
            entity_tokens.update(tokenize(name))
            key_tokens = [t for t in tokenize(name) if t not in TITLE_WORDS]
            if etype != "character":
                # "Ilya's black wax seal" 的代表词应是 seal / wax，而不是角色名 ilya
                key_tokens = [t for t in key_tokens if t not in character_tokens] or key_tokens
            if not key_tokens:
                continue
            phrase = re.sub(r"^the\s+", "", name.lower())
            if etype == "character":
                # 角色：全名，或去掉头衔后的名 / 姓单独出现
                patterns = [phrase, *key_tokens]
            else:
                # 地点 / 物品：完整短语，或末尾两个词组成的核心短语（如 "wax seal"、"counting house"）
                words = phrase.split()
                patterns = [phrase] + ([" ".join(words[-2:])] if len(words) > 2 else [])
            add_row(etype, name, patterns, key_tokens)

    # 摘要常用 "the protagonist" 指代主角，单独统计主角的全部指称
    protagonist_tokens = [t for t in tokenize(PROTAGONIST) if t not in TITLE_WORDS]
    add_row("player", f"{PROTAGONIST} + 'protagonist'", [*protagonist_tokens, "protagonist"], protagonist_tokens)
    entity_tokens.add("protagonist")

    entity_rows.sort(key=lambda r: -r["mention_df_pct"])

    # 事件词 = 非停用词且不属于任何实体名的词
    event_vocab = [t for t in df if t not in entity_tokens]
    # 按出现次数加权：衡量"文本里随手遇到的一个事件词"的典型 IDF
    occurrences = [t for d in docs for t in d if t not in entity_tokens]

    def idf_stats(tokens: list[str], idf_fn) -> dict:
        values = [idf_fn(t) for t in tokens]
        q = statistics.quantiles(values, n=4)
        return {"p25": round(q[0], 3), "median": round(q[1], 3), "p75": round(q[2], 3)}

    lucene = lambda t: lucene_idf(n_docs, df[t])  # noqa: E731
    used = lambda t: bm25.idf[t]  # noqa: E731

    frequent_event_words = sorted(event_vocab, key=lambda t: -df[t])[:15]

    return {
        "field": field,
        "n_docs": n_docs,
        "avg_doc_len": round(sum(map(len, docs)) / n_docs, 1),
        "entities": entity_rows,
        "event_words": {
            "vocab_size": len(event_vocab),
            "by_vocab": {"lucene": idf_stats(event_vocab, lucene), "rank_bm25": idf_stats(event_vocab, used)},
            "by_occurrence": {"lucene": idf_stats(occurrences, lucene), "rank_bm25": idf_stats(occurrences, used)},
            "most_frequent": [
                {"token": t, "df_pct": round(100 * df[t] / n_docs, 1), "idf_lucene": round(lucene(t), 3)}
                for t in frequent_event_words
            ],
        },
    }


def print_report(r: dict) -> None:
    print(f"\n=== field = {r['field']}   N = {r['n_docs']} chunks, avg {r['avg_doc_len']} tokens ===")
    print(f"{'type':<10}{'entity':<34}{'mention%':>9}{'idf':>7} |{'best token':>12}{'df%':>7}{'idf(rank_bm25)':>16}{'idf(lucene)':>13}")
    for e in r["entities"]:
        print(f"{e['type']:<10}{e['name'][:33]:<34}{e['mention_df_pct']:>9}{e['mention_idf_lucene']:>7} |"
              f"{str(e['best_token']):>12}{e['token_df_pct']:>7}{str(e['idf_rank_bm25']):>16}{str(e['idf_lucene']):>13}")
    ev = r["event_words"]
    print(f"\nevent words: vocab = {ev['vocab_size']}")
    for k in ("by_vocab", "by_occurrence"):
        print(f"  {k:<14} lucene {ev[k]['lucene']}   rank_bm25 {ev[k]['rank_bm25']}")
    print("  most frequent event words:", ", ".join(f"{w['token']}({w['df_pct']}%, {w['idf_lucene']})" for w in ev["most_frequent"]))


def main() -> None:
    corpus = load_corpus()
    entities = entity_names(corpus["finalState"])
    reports = [analyze(corpus["chunks"], entities, f) for f in ("dense_summary", "original_text")]
    for r in reports:
        print_report(r)
    (OUT_DIR / "idf_report.json").write_text(json.dumps(reports, indent=2, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
