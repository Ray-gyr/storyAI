# Retrieval experiment: tier search vs BM25

A small directional check of the claim "frequent entity names flatten BM25's IDF, so vector tier search is the better choice".
One machine-generated story, 44 memory chunks, 40 questions. Treat the results as directional evidence, not a rigorous benchmark.

## Reproduce

```bash
# 0. Local server (the generator drives the real story pipeline)
npx next build && npx next start -p 3123

# 1. Generate a ~100-round story with an auto-player LLM -> out/session.json
npx tsx --env-file=.env scripts/eval/generate_story.ts 100

# 2. Export the session's Pinecone chunks + final world state -> out/corpus.json
npx tsx --env-file=.env scripts/eval/export_corpus.ts

# 3. Step 1: entity vs event-word IDF -> out/idf_report.json
python -m venv .venv && .venv/Scripts/pip install -r scripts/eval/requirements.txt
.venv/Scripts/python scripts/eval/idf_analysis.py

# 4. Step 2: 20 chunks x 2 questions (verbatim / paraphrase) + vector-side rankings -> out/questions.json
npx tsx --env-file=.env scripts/eval/make_questions.ts 20

# 5. Steps 2-3: BM25 (rank_bm25, in memory) + comparison tables -> out/results.json
.venv/Scripts/python scripts/eval/bm25_eval.py
```

## Hybrid retrieval tuning (deployed in `src/lib/hybridRetriever.ts`)

```bash
# Held-out set B: 2 questions for each chunk not used by set A -> out/questions_holdout.json
npx tsx --env-file=.env scripts/eval/make_questions.ts 24 questions_holdout.json questions.json
# Vector-side rankings, depth 50, for both sets (dense / tier / dense_raw)
npx tsx --env-file=.env scripts/eval/rank_vectors.ts questions.json
npx tsx --env-file=.env scripts/eval/rank_vectors.ts questions_holdout.json
# Grid search + grouped cross-validation over tuning strategies -> out/tuning.json
.venv/Scripts/python scripts/eval/tune_hybrid.py
# The production BM25 (TS) matches rank_bm25 score for score
npx tsx scripts/eval/check_bm25_parity.ts && .venv/Scripts/python scripts/eval/check_bm25_parity.py
# The production retriever reproduces the offline numbers
npx tsx --env-file=.env scripts/eval/eval_production.ts
```

Tuning 9 parameters on set A alone overfit: the best config scored MRR@10 0.782 on A but 0.603 on held-out B, below the untuned defaults. `tune_hybrid.py` therefore pools A and B (88 questions, 44 disjoint source chunks) and runs 4-fold cross-validation grouped by source chunk, repeated 25 times. Each repetition compares tuning strategies by how well the config they pick on the training folds does on the test fold. The simplest strategy within 0.005 of the best CV score wins (fusion weights + each retriever's input; BM25 k1/b/IDF stay at defaults). Its final config is picked on all 88 questions after smoothing over neighbouring (depth, k, weight) grid points.

| MRR@10 | All 88 | CV estimate |
|---|---|---|
| Tier search (old) | 0.489 | — |
| BM25 only (defaults) | 0.661 | 0.661 |
| RRF defaults (k=60, w=1) | 0.625 | 0.625 |
| **Deployed hybrid** | **0.702** | **0.670** |

`eval_production.ts` reproduces 0.702 exactly through the production code path.

## Methods

All methods use the same input: the player question passed through the production intent rewriter (`search_query` + extracted entities). The gold answer is the chunk the question was generated from.

| Method | Description |
|---|---|
| `tier` | Production tier search: entity-filtered vector query first, topped up with the unfiltered vector query (mirrors `retrieveMemories`, without the final re-sort by turn) |
| `bm25` | `rank_bm25.BM25Okapi` over `dense_summary` (the same field the vectors embed) |
| `bm25+filter` | BM25 with exactly the same entity filter and top-up logic as `tier` |
| `dense` | Unfiltered vector query only (separates the filter's contribution from the vectors') |
| `bm25(raw)` | BM25 on the raw player question, skipping the rewriter |
| `bm25(no-ent)` | BM25 on the rewritten query with all entity tokens removed |
| `rrf(tier+bm25)`, `rrf(dense+bm25)` | Plain hybrid: top 10 from each side merged with Reciprocal Rank Fusion (k=60), no tuning |

When this experiment ran, the intent router still had a short-circuit (`is_resolved_by_cache`). It skipped retrieval on 37 of 40 recall questions, and left the rewrite empty when it did. The results in `out/` were produced with the short-circuit rule replaced by "retrieval is required"; the `short_circuited` field in `out/questions.json` records what production would have done.

`diagnose_router.ts` asks an LLM judge whether each short-circuited question was actually answerable from the router's context (state + last 3 turns). Only 5 of 37 were, so the short-circuit was removed. `e2e_recall.ts shortcircuit` compares the writer's answers to recall questions with the old routing (no memories for short-circuited questions) against always retrieving. `e2e_recall.ts prompt` (the default) keeps hybrid retrieval fixed and compares the old writer prompt (`legacy_prompts.ts`) with the current one on all 88 questions: 48 → 78 answers consistent with the recorded fact, 37 → 10 contradictions.

`make_questions.ts` now uses the production `translateUserIntent` directly, since every turn retrieves.

## Known limitations

- One story with 44 chunks; 20 questions per group, so a single question moves Hit@5 by 5 points.
- Questions are generated from `dense_summary`, the field BM25 indexes. `verbatim` questions favour BM25 by construction; `paraphrase` is the fairer condition.
- The auto-played story spends its second half in one long fight, so many chunks are lexically similar.
- With 44 chunks, Hit@10 covers almost a quarter of the corpus and is close to ceiling.
