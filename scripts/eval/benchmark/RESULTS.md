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

---

# Judge v2: rescoring the existing end-to-end answers

**Evaluation-code fix** (PROTOCOL.md Section 6 rule 5). No answer was regenerated and no system configuration changed.

**The bug.** The first judge had three verdicts (correct / contradicts / absent) and no rule for "I cannot recall". It scored honest uncertainty as a contradiction: on the test story, 12 of the 13 "cannot recall" replies of v2, and 12 of 13 of v3.

**Judge v2** (`judge.ts`) has four verdicts:
- correct
- contradicts: any claim incompatible with the reference passage, including "cannot recall, but …" followed by a false claim
- cannot_recall: honest uncertainty with no conflicting claim
- absent

The judge model is `gpt-6-luna`. It only runs at temperature 1, so each reply is judged 3 times and the majority verdict is kept.

## Calibration (manual review by Claude)

Both candidate judges scored the 176 test replies (v2 and v3) under the new rubric:

| | gpt-6-luna | gpt-4o-mini |
|---|---|---|
| Self-agreement across repeated judgements | 91% (3 runs) | 94–99% (2 runs) |
| Agreement with each other | 141/176 (80%) | |
| When they agree: manual check of 8 sampled items | 8/8 acceptable | |
| When they disagree: matches the manual verdict, 20 of 35 items checked | **14/20** | 6/20 |
| Estimated overall accuracy | **~94%** | ~86% |

luna separates honest uncertainty from invention and catches embellishments; it is sometimes too strict about harmless extra detail. It judged its own replies more strictly than gpt-4o-mini did, so no self-preference was visible. Limits: a single reviewer, and 28 items reviewed.

## Rescored results (test story, round 300, luna majority of 3)

| | correct | contradicts | cannot recall | absent |
|---|---|---|---|---|
| v2 | 47 | 34 | 6 | 1 |
| v3 | 48 | 31 | 8 | 1 |
| v2, temporal only | 3 | 10 | 4 | 1 |
| v3, temporal only | 0 | 11 | 7 | 0 |

The conclusion is unchanged: v3 ≈ v2. v3 invents slightly less and says "cannot recall" slightly more, all within noise.

## Question-quality issue found during review

Recurring-event tagging still over-tags common events: "a water shortage or heat-sickness crisis" was tagged in 42 test chunks. As a result, some late temporal questions ask about "the twentieth" or even "number 42" water crisis. No player asks that, and no writer can answer it, so the temporal numbers above understate what is achievable. The questions are frozen for this test set; the next question set should cap ordinals (for example at 5) and require each occurrence to be a distinct episode.

---

# Question set 2: same stories, higher-quality questions

**Why.** The manual review for Judge v2 showed that many failures came from the questions themselves:
- temporal questions about "the 42nd" water crisis;
- "how much water is left?" asked about a quantity that changes over the story;
- facts that recur in several passages;
- questions about sensory trivia.

The project owner chose to keep both stories and replace the questions. This is the **third use of the test story** (PROTOCOL.md Sections 6 and 10); the stories themselves are unchanged. The question set 1 files are archived in `out/<story>/qset1/`.

**How the questions were made** (`make_questions.ts` v2, `screen_questions.ts`, `manual_review.json`, `validate_questions.ts`):
1. **Generation:** `gpt-6.1-sol` sees the whole story outline and must pick a fact unique to the passage that does not change over time.
2. **Recurring events** are counted as episodes, so a continuation is not a new occurrence, and the ordinal is capped at 5.
3. **Screening:** `gpt-6.1-sol` dropped questions that were not story-relevant or not specific, and temporal questions whose passage does not show the event.
4. **Manual review by Claude:** every dropped question was checked, and further trivia, duplicate facts and malformed questions were removed (35 + 4).
5. **Top-up** questions were generated under a stricter "story-relevant only" rule, then screened and reviewed the same way.
6. **Labels** come from `gpt-6-luna` (majority of 3). After labelling, questions whose acceptable passages give different answers were dropped.
7. **The end-to-end judge** now sees all acceptable passages, not just the source passage.

All screening and review happened **before any question set 2 retrieval or answer result was looked at**. Detail and vague questions generated from the same passage in the top-up often ask the same fact; they are kept as phrasing pairs and are not independent samples.

Valid questions: **dev 92/130, test 91/140**.

## Retrieval, Recall@10 at round 300 (code as at `a8c7510`; retrieval unchanged since)

| | dev | test |
|---|---|---|
| v1 tier search | 0.946 | 0.824 |
| BM25 only | 0.935 | 0.912 |
| vector only | 0.957 | 0.956 |
| **v2 hybrid** | **0.957** | **0.945** |
| union ceiling | 0.967 | 0.978 |
| paired v2 − v1 | +0.011 [−0.02, +0.04] | **+0.121 [+0.04, +0.21]** |

Length curve on the test story's 45 early questions (rounds 100, 200, 300; 43, 93, 130 chunks): v1 goes 0.933 → 0.844 → **0.778**; v2 goes 1.000 → 0.978 → **0.978**.

Better questions carry more context (who, where, what was happening), so retrieval is easier for every method. On dev, v1 and v2 are now tied. On test, v2's lead over v1 holds (+12 points) and v1 still decays with story length while v2 does not. On test, vector alone (0.956) is level with v2 (0.945, one question).

## End to end at round 300 (v3 writer: top-3 memories with original text; judge v2)

| | correct | contradicts | cannot recall | absent |
|---|---|---|---|---|
| dev, question set 2 | **76/92 (83%)** | 14 | 2 | 0 |
| test, question set 2 | **72/91 (79%)** | 10 | 8 | 1 |
| *test, question set 1 (same v3 writer, for comparison)* | *48/88 (55%)* | *31* | *8* | *1* |

**Question quality explained most of the earlier low score.** With the same stories and the same writer, the test end-to-end accuracy rises from 55% to 79%, and contradictions fall from 31 to 10. These questions are harder in one sense: only 10–19% of answers are still in the chunk summary. The writer still gets them right, because the top-3 original texts usually contain the answer.

Temporal questions are now few (8 dev, 5 test after screening). Their numbers are too small to interpret.

---

# v4: original text for all 10 retrieved memories

Frozen at `425fb54` (FREEZE.md v4 record); retrieval is unchanged. Question set 2, end to end at round 300, judge v2. This is the fourth use of the test story (PROTOCOL.md Section 12). The choice between 3 and 10 originals was made on the dev story before this run.

| Writer receives | dev | test |
|---|---|---|
| summaries only (reference) | 28/92 (30%) | 29/91 (32%) |
| top 3 with original text (v3) | 76/92 (83%) | 72/91 (79%) |
| **all 10 with original text (v4)** | **84/92 (91%)** | **82/91 (90%)** |

By where the right chunk was retrieved (test story):

| Right chunk | summaries only | v3 | v4 |
|---|---|---|---|
| in the top 3 (n=70) | 27 | 69 | 66 |
| at rank 4–10 (n=16) | 2 | 2 | **16** |
| not retrieved (n=5) | 0 | 1 | 0 |

- **The gain lands where predicted.** Questions whose right chunk sat at rank 4–10 go from 2/16 to 16/16. The top-3 group drops slightly, 69 → 66, within run-to-run noise (about ±5), but it is worth watching: 7 extra original texts could distract the writer.
- **Contradictions fall to 7/91 and "cannot recall" to 1/91.** The writer invents the past for 8% of recall questions, down from 35% with question set 1 and the v2 writer.
- **The remaining errors are mostly retrieval misses** (5 test questions with no right chunk in the top 10), plus a few answers wrong despite the right original text.
- **Cost:** about 2,500 extra input tokens per turn (about +$0.00025 with `gpt-6-luna`). Latency is unchanged in the dev check.

**Overall, v4 on the 300-round test story:** retrieval Recall@10 0.945; end-to-end answers consistent with the past 90%, contradicting it 8%.

---

# Long summaries (dev story only, not yet tested)

Retrieval on question set 2 is near its ceiling, so a hard set was added to measure summary quality. `make_hard_questions.ts` writes 60 short, low-context questions on the dev story (at most 15 words, no scene-setting, e.g. "What did the pawnbroker refuse to do?"). The screener kept all 60. Manual review dropped 12: 4 duplicates and 8 "nothing was found" answers. The consistency check dropped 1 more, leaving **47 valid**. This is `out/dev-hard/`, and it was reviewed before any retrieval result was seen.

`long_summaries.ts` regenerates every chunk summary with the same helper model (`gpt-4o-mini`). The new prompt keeps every story-relevant fact: what was said, items, prices, decisions, outcomes, clues. It also keeps the story's own words for things. Summaries average **154 words**, against 55 for the production summaries and 413 for the original text. BM25 and the vector index both use the long summaries; the vectors sit in a separate Pinecone namespace. Fusion is unchanged (BM25 top 3, then vector). Each question reuses the same intent rewrite, so the comparison is paired. New candidates were labelled with the same judge; `label.ts` now pools the top 10 of every method.

Recall@10 at round 300:

| | dev-hard (n=47) | dev, question set 2 (n=92) |
|---|---|---|
| BM25, short / long | 0.936 / **1.000** | 0.935 / 0.967 |
| vector, short / long | 0.872 / **0.979** | 0.957 / 0.967 |
| v2 hybrid, short / long | 0.936 / **1.000** | 0.957 / **0.978** |
| v2 hybrid R@5, short / long | 0.851 / 0.957 | 0.924 / 0.913 |
| paired questions: hit only with long / only with short | 3 / 0 | 2 / 0 |

- **Long summaries win 5 questions and lose none** across both sets. Two dev-hard wins are facts the short summary left out: the word "Lantern" in the transmission and in the survey logs. The third had the fact in the short summary but not the question's words ("cut transfer hatch").
- **The vector index gains the most** on short questions: 0.872 → 0.979.
- **Caveats.** These results come from the dev story only, and the samples are small (the confidence interval of the paired difference touches 0). The summary prompt was written once and not tuned on these results. The hard set turned out less hard than intended: short-summary v2 already reaches 0.936. Before anything goes to production, the change needs one run on the test story.

## v5 test run (frozen at `b682c8e`, fifth use of the test story)

The test summaries were regenerated with the production extractor. They average 129 words.

| test, round 300 (n=91) | short summaries (v4) | long summaries (v5) |
|---|---|---|
| v2 hybrid Recall@10 | 0.945 | 0.945 (1 won, 1 lost) |
| v2 hybrid Recall@5 | 0.890 | 0.901 |
| BM25 only, Recall@10 | 0.912 | 0.945 |
| vector only, Recall@10 | 0.956 | **0.912** |
| End to end, correct / contradicts | 82 / 7 | 83 / 6 |

- **No gain on the test story.** The dev gain on question set 2 (0.957 → 0.978, end to end 84 → 91) did not replicate. The dev end-to-end jump was probably partly run-to-run noise.
- **Test question set 2 has little room left.** Outside temporal questions, short summaries already miss only 2 of 86. Of the 5 misses, 3 are temporal and are still missed with long summaries.
- **The one win and the one loss follow the same pattern as on dev.**
  - Win: the long summary puts the right chunk at BM25 rank 1, against 17 with the short summary.
  - Loss: the right chunk drops from BM25 rank 3 to 4, just outside the quota of 3, and the vector index ranks it at 18.
- **Long summaries help BM25 but hurt the vector index on the test story** (0.956 → 0.912). One embedding of a 130-word summary is less focused than one of a 55-word summary. Fusion hides this, because BM25 improves at the same time.
- **Open question:** the dev-hard gain (short, low-context questions, 0.936 → 1.000) has no held-out counterpart yet. This test run does not confirm or refute it.

**Overall:** on question set 2, v5 equals v4 on the test story (Recall@10 0.945, end to end 83/91 against 82/91). Whether long summaries help short, low-context questions needs a hard set on the test story.

## Hard set on the test story (test-hard, after the v5 freeze)

`make_hard_questions.ts` was given the story name as a parameter; the prompt is unchanged. It generated 60 questions on the test story. The screener again kept 60/60. Manual review used the dev-hard criteria and dropped 13 (4 duplicates, 9 "nothing was found"), leaving **47 valid**. The drop list was written down before any retrieval result. It first failed to save, because a shell command failed silently, so the run initially counted all 60 as valid. It was then applied unchanged. All numbers below use the 47.

| test-hard, round 300 (n=47) | Recall@10 | Recall@5 |
|---|---|---|
| v1 tier search | 0.702 | 0.596 |
| v2 hybrid, short summaries (v2–v4) | 0.830 | 0.681 |
| **v2 hybrid, long summaries (v5)** | **0.894** | **0.766** |
| paired v5 − v4 | +0.064 [−0.04, +0.17] (5 won, 2 lost) | |

End to end (judge v2), with each writer configuration on the same retrieval:

| Writer receives | dev-hard (n=47) | test-hard (n=47) |
|---|---|---|
| summaries only (v2) | 36 | 21 |
| top 3 with original text (v3) | 45 | 30 |
| all 10 with original text (v4) | 45 | 37 |
| **all 10 with original text, long summaries (v5)** | **45** | **40** |

On test-hard, v5 retrieves a correct chunk for 42 of 47 questions, against 39 for v4. It answers 40 correctly, against 37. The end-to-end gain matches the retrieval gain exactly. Short, low-context questions are where long summaries help. The difference is not significant at n=47, but its direction matches dev-hard and the prediction made before the run.
