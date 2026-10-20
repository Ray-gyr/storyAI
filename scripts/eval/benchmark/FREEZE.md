# Freeze record

**Frozen code: commit `a8c7510`** ("Retrieval: quota fusion (BM25 top 3 + vector fill) chosen on dev data").

The test story is evaluated once, with the retrieval and writer code exactly as in that commit (PROTOCOL.md, Section 6).

## Frozen configuration

- **v2 retrieval** (`src/lib/hybridRetriever.ts`): quota fusion. BM25 top 3 (Okapi, k1 1.5, b 0.75, rank_bm25 IDF; query = raw input + rewritten query), then fill to 10 from the vector ranking (raw player input embedded with `text-embedding-3-small`, top 20). BM25 positions 4–10 fill in only if the vector list runs short.
- **Query rewriting:** `translateUserIntent` with `gpt-4o-mini`.
- **Writer:** `gpt-6-luna`, the prompt at the commit above (used in the end-to-end check).

## How it was chosen

Tuned on the dev story (300 rounds, 130 chunks, 88 questions × 3 snapshots) and the pilot story, with the Recall@10 objective, using 4-fold cross-validation grouped by source chunk and repeated 25 times:

| Fusion | Cross-validated Recall@10 | Tuned params |
|---|---|---|
| previous RRF (k 60, BM25 weight 4) | 0.944 | 0 |
| BM25 only | 0.941 | 0 |
| vector only | 0.925 | 0 |
| **quota (BM25 top 3)** | **0.954** | 1 |
| RRF grid | 0.958 | 3 |

Quota wins under the protocol's "fewest parameters within 0.01 of the best" rule. Through the production code path, the dev story's round-300 Recall@10 is 0.943, against 0.920 for the previous RRF and 0.852 for v1 tier search.

## State of the test story at freeze

The test story was generated at commit `149bd72` (Amendment 1). The only contact since then was the completion check allowed by Section 6:
- 300 rounds and 601 turns completed, with no errors in the log.
- Snapshots after rounds 100, 200 and 300 hold 43, 93 and 130 chunks.

No questions, labels, retrieval runs or chunk text have been produced or read.

## Known deviation so far

The protocol asks for 10 temporal questions per pool. On the dev story, the early pool had only 4 eligible occurrences (the first or second occurrence of an event type, in a chunk of at least 40 words), so it produced 8 temporal questions, two per occurrence. The same rule will apply to the test story, and the actual counts will be reported.

---

# Freeze record: v3 (second use of the test story, end to end only)

**Frozen code: commit `2730731`** ("v3: give the writer original text for top-3 memories, in story order"). See PROTOCOL.md Section 10 for why the test story is reused and the residual bias this carries.

- Retrieval is unchanged from `a8c7510`.
- The writer receives the top 3 memories by retrieval rank with their original chunk text (the other 7 as summaries), all listed oldest first with turn numbers. Prompt and model are as at `2730731` (`gpt-6-luna`).
- Chosen on the dev story only: summaries only 53/88, top 3 62/88, all 10 64/88 (end to end at round 300).
- Test run: `e2e.ts test --originals 3 --tag v3`, once, reusing the frozen v2 query rewrites.

---

# Freeze record: v4 (fourth use of the test story, end to end only, question set 2)

**Frozen code: commit `425fb54`** ("v4: original text for all 10 retrieved memories"). See PROTOCOL.md Section 12.

- Retrieval is unchanged from `a8c7510`.
- The writer receives all 10 retrieved memories with their original chunk text, listed oldest first with turn numbers.
- Chosen on the dev story only: top 3 76/92, all 10 84/92.
- Test run: `e2e.ts test --originals 10 --tag qset2_o10`, once. Reference run: `--originals 0 --tag qset2_o0`.

---

# Freeze record: v5 (fifth use of the test story, question set 2)

**Frozen code:** see the commit that adds this record. See PROTOCOL.md Section 13.

- The memory extractor writes long, detail-preserving summaries (rule 5 in `prompt.ts`), still with `gpt-4o-mini`. BM25 and the vector index both use them.
- Fusion is unchanged: BM25 quota 3, top 10. The writer is unchanged from v4: all 10 memories with original text.
- Chosen on the dev story only:
  - Recall@10: 0.957 → 0.978 on question set 2, and 0.936 → 1.000 on dev-hard.
  - End to end: 84/92 → 91/92.
- Test runs:
  1. `long_summaries.ts generate test` and `long_summaries.ts retrieve test`, then `label.ts test` and `analyze.py test`.
  2. `e2e.ts test --long --tag qset2_v5`, once.
