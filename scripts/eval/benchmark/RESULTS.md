# Long-Story Retrieval Benchmark: Test Results

The one-time run on the test story (PROTOCOL.md, Section 8), with the code frozen at `a8c7510` (FREEZE.md). Every number below is reported as obtained; nothing was tuned after this run. Raw data is in `out/test/`: `questions.json`, `retrieval.json`, `labels.json`, `results.json` and `e2e.json`.

The test story is a high-fantasy expedition: 300 rounds, 601 turns. The snapshots after rounds 100, 200 and 300 hold 43, 93 and 130 memory chunks.

## Questions

- 88 generated, 88 valid (each source passage answers its own question).
- early pool: 20 detail, 15 vague, 8 temporal. late pool: 20 detail, 15 vague, 10 temporal.
- **Deviation:** the protocol asks for 10 early temporal questions. Only 4 occurrences qualified (the first or second occurrence of an event type, in a chunk of at least 40 words), so there are 2 questions per occurrence, 8 in total. The same thing happened on the dev story.

## Primary result

**v2 hybrid Recall@10 at round 300: 0.932** (95% CI 0.88–0.98, n = 88).

## All methods at the round-300 snapshot

| Method | Recall@10 | Recall@5 |
|---|---|---|
| v1 tier search | 0.773 [0.68, 0.85] | 0.693 [0.59, 0.78] |
| BM25 only | 0.818 [0.73, 0.90] | 0.705 [0.60, 0.80] |
| vector only | 0.909 [0.84, 0.97] | 0.852 [0.77, 0.92] |
| **v2 hybrid (frozen)** | **0.932 [0.88, 0.98]** | **0.898 [0.83, 0.95]** |
| union ceiling (BM25 ∪ vector, up to 20 chunks) | 0.955 [0.91, 0.99] | — |

Paired difference, v2 minus v1: **+0.159** (95% CI +0.08 to +0.24).

## Length curve: the same 43 early questions as the story grows

Recall@10 after rounds 100, 200 and 300, with 43, 93 and 130 chunks:

| Method | Round 100 | Round 200 | Round 300 |
|---|---|---|---|
| v1 tier search | 0.907 | 0.721 | **0.581** |
| BM25 only | 0.907 | 0.837 | 0.721 |
| vector only | 0.977 | 0.884 | 0.884 |
| **v2 hybrid** | **0.977** | **0.884** | **0.884** |
| union ceiling | 0.977 | 0.907 | 0.907 |

v1 loses a third of its recall on early events as the chunk count triples. v2 loses 9 points and is flat between rounds 200 and 300. On these early questions, v2 equals vector only: BM25's top 3 never rescued a question the vector list missed.

## By question type (round 300, Recall@10)

| Type | n | v1 tier | BM25 | vector | v2 |
|---|---|---|---|---|---|
| detail | 40 | 0.750 | 0.850 | 0.850 | 0.900 |
| vague | 30 | 0.833 | 0.933 | 0.967 | 0.933 |
| temporal | 18 | 0.722 | 0.556 | 0.944 | 1.000 |

## Retrieval vs summaries

- The answer is still present in the source chunk's summary for only 44% of questions.
- v2 Recall@10 is 0.949 when the answer is in the summary and 0.918 when it is only in the original text.
- 6 v2 misses; 2 of them had the answer in the summary.

## End to end (round 300, frozen writer `gpt-6-luna`)

| | n | Consistent with the past | Contradicts it |
|---|---|---|---|
| All questions | 88 | **49 (56%)** | 39 |
| Right chunk retrieved | 83 | 49 (59%) | 34 |
| Right chunk not retrieved | 5 | 0 | 5 |
| Right chunk retrieved, answer in summary | 38 | **31 (82%)** | 7 |
| Right chunk retrieved, answer only in original text | 45 | **18 (40%)** | 27 |
| temporal questions | 18 | 5 | 13 |

The end-to-end bottleneck is the **memory representation, not retrieval**. The writer receives chunk summaries only. When the summary kept the answer, 82% of answers are right; when only the original text has it, 40% are, even though the right chunk was retrieved. Temporal questions are retrieved perfectly (18/18), but the writer answers only 5 correctly. It has to work out which summary is "the first time" from unordered fragments. (Run-to-run noise in this end-to-end measure is about ±5 of 88; see the pilot runs.)

## Dev vs test

| Round 300, Recall@10 | dev (sci-fi) | test (fantasy) |
|---|---|---|
| v1 tier search | 0.852 | 0.773 |
| BM25 only | 0.909 | 0.818 |
| vector only | 0.886 | 0.909 |
| v2 hybrid | 0.943 | 0.932 |

v2 carries over from dev to test, losing 1 point. BM25 alone drops 9 points on the test story, which supports giving it only 3 of the 10 slots.

## What this does and does not show

- It shows that, on two machine-played 300-round stories, the frozen v2 retriever finds a correct chunk for 93–94% of recall questions at round 300, against 77–85% for v1. v2 also degrades far less as the story grows.
- It does not show that players get correct answers that often: end to end, 56% of answers agree with the past, limited by what the summaries keep.
- Limits: two stories, LLM-generated questions and labels, a single judge model, and n = 88 per story (CIs above).
- Next step suggested by the data (to be evaluated on a new test story, per Section 6): give the writer the original text of the top-ranked chunks, or summaries that keep concrete details, plus turn order for temporal questions.

---

# v3: end-to-end rerun on the test story (second use)

Frozen at `2730731` (FREEZE.md v3 record). Retrieval is unchanged from v2. The writer now sees the original text of the top 3 memories by retrieval rank, with all memories listed oldest first and labelled with turns. Under PROTOCOL.md Section 10, this is the **second use** of the test set: the decision to work on the memory representation was partly informed by the v2 test result, so any gain here could be optimistic. (There was essentially no gain.)

## Result

| End to end, round 300 | All | Answer in summary | Answer only in original | Temporal | Detail | Vague |
|---|---|---|---|---|---|---|
| v2 (frozen) | 49/88 (56%) | 31/39 | 18/49 | 5/18 | 23/40 | 21/30 |
| **v3** | **50/88 (57%)** | 29/39 | 21/49 | 1/18 | 25/40 | 24/30 |
| *dev story, v3 config, for reference* | *62/88 (70%)* | *30/36* | *32/52* | *6/18* | *32/40* | *24/30* |

**v3 did not reproduce its dev gain on the test story.** It is +1 overall, within run-to-run noise (about ±5). It gains a few points on detail, vague and original-only questions, and drops on temporal questions (5 → 1 of 18; small n).

## Why (analysis of the existing run, no changes made)

Original text helps when it reaches the right chunk. It often does not, because "top 3 by retrieval rank" under quota fusion means **BM25's top 3**, and BM25 is weak on the test story (Recall@5 0.705):

| Questions whose answer is only in the original text | dev | test |
|---|---|---|
| right chunk among the top 3 (so it got original text) | 36/52 (69%) | 28/49 (57%) |
| correct when the right chunk had original text | 28/36 (78%) | 18/28 (64%) |
| correct when the right chunk was retrieved as summary only (rank 4–10) | 4/11 | 3/17 |

## Takeaways (for the next version, to be evaluated on a fresh test story)

- **Route original text by relevance, not by fusion position.** Options: all 10 memories with originals (+2 answers on dev, within noise, about +3,300 tokens per turn), or originals assigned by vector rank, or a reranker. On this test story, originals for all 10 would have reached the right chunk for 45 of 49 original-only questions, against 28 for top 3. That observation comes from the test set, so it must be confirmed on new data.
- **Temporal questions need a structural fix.** Story order and turn labels alone do not tell the writer which occurrence is "the first", because the retrieved set holds only some occurrences. A per-chunk occurrence index for recurring event types is one option.
- The writer's accuracy given the right original text also varies by story (78% dev vs 64% test).
