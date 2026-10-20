# How Story AI's Memory Got Better: From v5 Back to v1

Story AI is a text adventure game. An AI narrator writes the story, and the game has to remember what happened hundreds of turns ago. Old turns are cut into "memory chunks". Each chunk gets a short summary, and the summaries are searched when the player does something (this is called RAG, retrieval-augmented generation). The 10 best chunks go into the narrator's prompt.

This report walks backwards from the newest version (v5) to the first one (v1). For each version I explain what problem it fixed, how much it improved over the version before it, and why. All the detailed numbers are in `RESULTS.md`, and the rules for the tests are in `PROTOCOL.md`.

---

## The short version

Final numbers for v5 on the **test story**. It is a 300-round fantasy story. I never used it to tune anything; it was only used to check versions after they were frozen.

| | Main question set (91 questions) | Hard question set (47 questions) |
|---|---|---|
| **RAG recall** (a correct memory is in the top 10) | **94.5%** | **89.4%** |
| **Narrator answers correctly** | **83 / 91 (91%)** | **40 / 47 (85%)** |
| Narrator contradicts the story | 6 / 91 | 6 / 47 |

How each version did on the test story:

| Version | What changed | Recall, main set | Recall, hard set | Correct answers, main set | Correct answers, hard set |
|---|---|---|---|---|---|
| v1 | starting point | 82.4% | 70.2% | (not measured, see v1) | (not measured) |
| v2 | better search + prompt fixes | 94.5% | 83.0% | 29 / 91 | 21 / 47 |
| v3 | original text for top 3 memories | 94.5% | 83.0% | 72 / 91 | 30 / 47 |
| v4 | original text for all 10 memories | 94.5% | 83.0% | 82 / 91 | 37 / 47 |
| **v5** | **longer, more detailed summaries** | **94.5%** | **89.4%** | **83 / 91** | **40 / 47** |

The biggest lesson: **finding the right memory is not enough. The narrator also has to be able to read the detail inside it.** v2 fixed the search, but answers only got good once v3 and v4 gave the narrator the original text instead of just the summary.

---

## How I measure things (quick explanation)

- **Two stories.** Both were played for 300 rounds by an AI "auto-player", which gives 130 memory chunks each. The **dev story** (sci-fi) is for trying ideas. The **test story** (fantasy) is only for checking a version after it is frozen. This way I can't accidentally tune the system to the test.
- **Two question sets.** Each question asks about something that happened earlier in the story.
  - The **main set** (question set 2) has fairly long questions with context, for example: *"When I planned our route at the river docks, what hazards made me reject the faster crossing over the glass-covered flats?"*
  - The **hard set** has short questions with almost no context, the way a real player types: *"Why did I avoid the Glass Flats in my original route?"* (The answer to both is "storms and glass splinters could cripple the wagons".)
- **RAG recall** (Recall@10) asks whether at least one correct memory chunk made it into the 10 chunks given to the narrator.
- **Correct answers** (end to end): the narrator answers the question, and an AI judge compares the answer with the original story text. The judge was checked by hand (about 94% accurate).
- **Noise:** if you run the same end-to-end test twice, the score moves by about ±5 out of 90. So a gain of 1–3 questions on the main set is not meaningful by itself.

---

## v5: Longer, more detailed summaries

**Problem.** After v4, almost every remaining wrong answer was a **retrieval miss**: the right memory was never found. Search only looks at the summaries, and the old summaries were short (55 words on average for 413 words of story). If a detail wasn't in the summary, search had nothing to match.

Example: the player asks *"What single word did my incoming transmission contain?"* The answer is "LANTERN", but the old summary never mentions the word.

**Fix.** I changed the summary prompt to keep every story-relevant fact: what people said, items, prices, decisions, outcomes and clues, using the story's own words for things. Summaries are now about 125 words. Both keyword search (BM25) and vector search use them.

**Results (test story):**

| | v4 (short summaries) | v5 (long summaries) | Change |
|---|---|---|---|
| Recall, hard set | 83.0% | 89.4% | +6.4 points (5 questions won, 2 lost) |
| Correct answers, hard set | 37 / 47 | 40 / 47 | **+3** |
| Recall, main set | 94.5% | 94.5% | 0 (1 won, 1 lost) |
| Correct answers, main set | 82 / 91 | 83 / 91 | +1 (noise) |

**Why it helps where it helps.**
- On the hard set, the gain in answers (+3) exactly matches the gain in found memories (39 → 42). When a short question names one specific detail, a summary that contains that detail is much easier to find.
- On the main set there was almost nothing left to fix. The long questions already contain lots of words that match, so short summaries were good enough: only 2 of 86 non-timeline questions were missed.
- One side effect: long summaries make **vector search alone** slightly worse on the main set (95.6% → 91.2%). One vector for a 130-word summary is less focused. Keyword search gets better at the same time, so the combined search comes out even.

**Honest caveat.** The hard-set gain is not statistically significant with 47 questions (the confidence interval includes zero). But it points the same way on both stories (dev hard set: 93.6% → 100%), and I predicted it before running the test.

---

## v4: Original text for all 10 memories

**Problem.** In v3, only the top 3 memories came with their original text, and the other 7 were summary-only. The "top 3" were simply the first 3 slots, which always come from keyword search, so they were not necessarily the most useful ones. When the right memory sat in slots 4–10, the narrator only saw its summary, and the detail was usually missing.

**Fix.** Give the original text for all 10 memories.

**Results (test story, main set):**

| | v3 | v4 | Change |
|---|---|---|---|
| Correct answers | 72 / 91 (79%) | 82 / 91 (90%) | **+10** |
| Right memory in slots 4–10: correct | 2 / 16 | 16 / 16 | +14 |
| Hard set, correct | 30 / 47 | 37 / 47 | **+7** |

**Why.** The gain landed exactly where I expected: questions whose right memory was in slots 4–10 went from 2/16 to 16/16. The cost is about 2,500 extra prompt tokens per turn (about $0.00025), and speed did not change.

---

## v3: Original text for the top 3 memories

**Problem.** In v2 the narrator only saw summaries. Even when search found the right memory, the summary often didn't contain the answer, so the narrator guessed. Only 10–19% of main-set answers were still in the summary.

**Fix.** Attach the original story text to the top 3 memories, and list all memories in story order with turn numbers. Turn order helps with "the first time…" questions.

**Results (test story):**

| | v2 (summaries only) | v3 | Change |
|---|---|---|---|
| Correct answers, main set | 29 / 91 (32%) | 72 / 91 (79%) | **+43** |
| Correct answers, hard set | 21 / 47 | 30 / 47 | **+9** |

**Why.** This was the single biggest jump. The narrator was never really bad at answering. It just couldn't see the details. A summary is a lossy copy, and the original text is not.

---

## Between v2 and v3: fixing the measuring stick

These were not system changes, but they changed what the numbers mean, so they belong in this story.

1. **A fairer judge.** The first judge had no category for "I can't remember". It counted an honest "I'm not sure" as a **contradiction**, which made the narrator look like it was lying more than it really was. The new judge has four verdicts: correct, contradicts, can't recall, and absent. It was checked by hand against another judge model.
2. **Better questions (question set 2).** When I looked at the wrong answers by hand, many came from bad questions, not a bad system. Examples: "the 42nd water crisis", amounts that change over the story, and facts that happen several times. I rebuilt the questions with stricter rules, an AI screening step, a manual review, and a check that every question has only one correct answer. With the same stories and the same v3 narrator, the test score went from 55% to 79%. Most of the "low score" had been the test's fault.

One confusing point: v2's summaries-only score is lower on question set 2 (32%) than on question set 1 (56%). That's because the new questions focus on concrete details, and those details are mostly not in the short summaries.

---

## v2: Better search, and stop blocking the memory

v2 fixed three separate problems. I found all of them by testing my own design choices on a 100-round practice story.

**Problem 1: the search ("tier search") got worse as the story grew.** v1 used vector search with an entity filter (only chunks that mention the same characters or items). I avoided keyword search (BM25) because I believed frequent names like the hero's would make BM25's word weights (IDF) useless.
- **What I found:** that belief was only true for the main character. It mostly happened because the summarizer replaces every "he" or "she" with the full name. BM25 still worked well. The entity filter let 77% of chunks through, so it barely filtered anything.
- **Fix:** hybrid search. BM25 picks the first 3 slots, and vector search fills the other 7. Vector search is good when the player uses different words ("coat" vs "jacket"), and BM25 is good when the words match exactly.
- I first tried a common merging formula (RRF). With my weights, it let BM25 decide the whole list, so I replaced it with the simpler "3 + 7" split. I chose it with cross-validation and picked the simplest option that was within 1 point of the best. Tuning many parameters on few questions had overfit badly in an earlier try.

**Problem 2: a "shortcut" skipped memory search on exactly the wrong turns.** v1 asked an AI router before each turn: "Can you answer this without searching memory?" For **37 of 40** questions about the past, it said yes and skipped the search. For 32 of those, the answer was not actually available, so the narrator had to make up the past. It only saved time on 4% of normal turns. **Fix:** removed it, so every turn searches.

**Problem 3: the narrator prompt told it to ignore memories.** One rule said "only use what is in the current state", which excluded everything retrieved. Memories were pasted in without a label. **Fix:** label the memories, and add a "memory fidelity" rule: the past is fixed, so answer from memory or say you can't recall. On the practice story this raised answers consistent with the past from 48/88 to 78/88.

**Results (test story, v1 → v2 recall):**

| | v1 | v2 | Change |
|---|---|---|---|
| Recall, main set | 82.4% | 94.5% | +12.1 points |
| Recall, hard set | 70.2% | 83.0% | +12.8 points |
| Recall, old question set 1 | 77.3% | 93.2% | +15.9 points |
| Recall on early events as the story grows (round 100 → 300) | 93% → 78% | 100% → 98% | v1 decays, v2 stays flat |

**Why.** The long-story problem is the important one. With 3 times more chunks, v1 lost a big part of its recall on early events, while v2 barely moved. Two different search methods cover each other's blind spots.

---

## v1: The starting point

v1 had the right basic idea: a dual-track memory, where a "current state" keeps facts that change and long-term memory keeps past events. It had three hidden problems, all described under v2: vector-only tier search, the shortcut router, and a prompt that pushed memories away.

I don't have a clean end-to-end number for v1 on these question sets. Its router skipped search on most questions about the past, so most of those answers would have been made up. That is the main reason v2 removed the router.

---

## What I learned

1. **Measure before believing.** Two of my v1 design ideas, "BM25 will fail on names" and "the shortcut saves time", were wrong once I tested them.
2. **Check the test, not just the system.** A large part of the early "bad scores" was bad questions and a judge that counted honesty as lying.
3. **Retrieval and reading are two different problems.** v2 fixed finding memories (recall +12 points), but answers stayed low until v3 and v4 let the narrator read the original text (32% → 90%).
4. **Each fix moves the bottleneck.** After v4, the remaining errors were retrieval misses, which is what v5 targets. After v5, the main remaining problem is timeline questions ("the third time I…"), which neither better search nor longer summaries fix. They need their own solution.

## Limits (to be honest)

- There are only two stories, both played by an AI, and the questions and labels are AI-generated with manual review.
- The test story has been reused for several versions. Each version was frozen before its test run, but reusing a test set makes the results a bit optimistic.
- The summaries-only (v2) and top-3 (v3) scores on the hard sets were measured later, with today's prompt, by turning off the original text. They show the effect of that one change, not an exact replay of old versions.
- The end-to-end noise is about ±5 out of 90, so small differences (like v5's +1 on the main set) mean nothing on their own.
