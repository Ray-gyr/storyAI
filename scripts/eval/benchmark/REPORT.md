# How Story AI's Memory Got Better: Final Report

Story AI is a text adventure game. An AI narrator writes the story, and the game has to remember what happened hundreds of turns ago. Old turns are cut into "memory chunks". Each chunk gets a short summary, and the summaries are searched every turn (this is called RAG, retrieval-augmented generation). The 10 best chunks go into the narrator's prompt.

This report covers three versions of the memory system, plus one change to how I measure it. For each one I explain what problem it fixed, how much it improved, and why. The detailed numbers are in `RESULTS.md`, and the test rules are in `PROTOCOL.md`.

---

## The short version

Final numbers on the **test story**, a 300-round fantasy story. I never used it to tune anything; it was only used to check a version after it was frozen.

| Version | What changed | Recall, main set | Recall, hard set | Correct answers, main set | Correct answers, hard set |
|---|---|---|---|---|---|
| v1 | starting point | 82.4% | 70.2% | not measured (see v1) | not measured |
| v2 | find the memory: hybrid search, no shortcut, prompt fix | 94.5% | 83.0% | 29 / 91 (32%) | 21 / 47 (45%) |
| **v3** | **read the memory: original text for all 10 chunks, plus longer summaries** | **94.5%** | **89.4%** | **83 / 91 (91%)** | **40 / 47 (85%)** |

With v3, the narrator contradicts the story on 6 of 91 main-set questions and 6 of 47 hard-set questions.

The main lesson: **finding the right memory is not enough. The narrator also has to be able to read the detail inside it.** v2 fixed the search, but answers only got good once v3 gave the narrator the original text instead of just a summary.

---

## How I measure things

- **Two stories.** Both were played for 300 rounds by an AI "auto-player", which gives 130 memory chunks each. The **dev story** (sci-fi) is for trying ideas. The **test story** (fantasy) is only for checking a version after it is frozen, so I can't accidentally tune the system to the test.
- **Two question sets.** Each question asks about something that happened earlier in the story.
  - The **main set** has fairly long questions with context, for example: *"When I planned our route at the river docks, what hazards made me reject the faster crossing over the glass-covered flats?"*
  - The **hard set** has short questions with almost no context, the way a real player types: *"Why did I avoid the Glass Flats in my original route?"* (The answer to both: storms and glass splinters could cripple the wagons.)
- **Recall** (Recall@10) asks whether at least one correct memory chunk made it into the 10 chunks given to the narrator.
- **Correct answers** (end to end): the narrator answers the question, and an AI judge compares the answer with the original story text. I checked the judge by hand; it is about 94% accurate.
- **Noise:** running the same end-to-end test twice moves the score by about ±5 out of 90. Small differences don't mean much on their own.

---

## v1: The starting point

v1 had a sensible design: a **dual-track memory**. A "current state" holds facts that change (where you are, what you carry), and long-term memory holds past events. It had three hidden problems:

1. **Tier search.** It used vector search with an entity filter, so only chunks mentioning the same characters or items were searched first. I avoided keyword search (BM25) because I believed frequent names, like the hero's, would make BM25's word weights (IDF) useless.
2. **A shortcut router.** Before each turn, an AI router asked: "Can this be answered without searching memory?" If yes, search was skipped to save time.
3. **A prompt that pushed memories away.** One rule said "only use what is in the current state", which excluded everything retrieved. Memories were pasted in without a label.

I don't have a clean end-to-end score for v1 on these question sets. Its router skipped the search on most questions about the past (see below), so most of those answers would have been made up.

---

## v2: Make the system actually look for memories

I found all three problems by testing my own design choices on a 100-round practice story, and fixed them together.

**Fix 1: hybrid search.** My belief about BM25 turned out to be true only for the main character. It mostly happened because the summarizer replaces every "he" or "she" with the full name. BM25 still worked well. Meanwhile, the entity filter let 77% of chunks through, so it barely filtered anything. v2 uses both methods: BM25 takes the first 3 slots, and vector search fills the other 7.
- Vector search is good when the player uses different words ("coat" vs "jacket").
- BM25 is good when the words match exactly.
- I first tried a common merging formula (RRF), but with my weights it let BM25 decide the whole list. So I chose the simpler "3 + 7" split, using cross-validation and the rule "pick the simplest option within 1 point of the best". An earlier attempt to tune many parameters on few questions had overfit badly.

**Fix 2: remove the shortcut.** For **37 of 40** questions about the past, the router said "no search needed". For 32 of those, the answer was not actually available, so the narrator had to invent the past. It only saved time on 4% of normal turns. Now every turn searches.

**Fix 3: let the narrator use memories.** The memories are now labelled, and a "memory fidelity" rule says the past is fixed: answer from memory, or say you can't recall. On the practice story, answers consistent with the past rose from 48/88 to 78/88.

**Results (test story):**

| Recall | v1 | v2 | Change |
|---|---|---|---|
| Main set | 82.4% | 94.5% | +12.1 points |
| Hard set | 70.2% | 83.0% | +12.8 points |
| Early events as the story grows (round 100 → 300) | 93% → 78% | 100% → 98% | v1 decays, v2 stays flat |

**Why it works.** Recall went up about 12 points, and more importantly **it no longer decays as the story gets longer**. When the number of chunks tripled, v1 lost a big part of its recall on early events, while v2 barely moved. The two search methods cover each other's blind spots.

But v2 still answered only 29 of 91 main-set questions correctly. Search was finding the right memory, so the problem had moved somewhere else.

---

## Fixing the measuring stick

This is not a system version, but it changed what the numbers mean, and it was one of the most important steps.

1. **A fairer judge.** The first judge had no category for "I can't remember". It counted an honest "I'm not sure" as a **contradiction**, which made the narrator look like a liar more often than it really was. The new judge has four verdicts: correct, contradicts, can't recall, and absent. I checked it by hand against a second judge model.
2. **Better questions.** When I read the wrong answers by hand, many came from bad questions, not a bad system. Examples:
   - "the 42nd water crisis" (no player would ask this, and nobody could answer it);
   - amounts that change over the story;
   - facts that happen several times, so there is more than one right answer.

   I rebuilt the question set with stricter rules, an AI screening step, a manual review, and a check that every question has exactly one correct answer.

**Result:** with the same stories and the same system, the test score went from **55% to 79%**. Both scores are from the new judge, and both were measured with an intermediate build that attached original text to the top 3 chunks (see v3). A large part of the earlier "low score" was the test's fault, not the system's. If I had trusted the first numbers, I would have spent time fixing problems that didn't exist.

One confusing detail: v2's score is lower on the new questions (32%) than on the old ones (53%, both with the new judge). The new questions focus on concrete details, and those details are usually not in the short summaries, which is exactly the problem v3 fixes.

---

## v3: Let the narrator read the details

**Problem.** In v2 the narrator only saw summaries. A summary is a lossy copy: about 55 words for 413 words of story. Only 10–19% of main-set answers were still in the summary. So even when search found the right chunk, the narrator often had to guess.

**Main fix: attach the original text to all 10 retrieved chunks.** The memories are also listed in story order with turn numbers.

On the way there, I first tried attaching original text only to the top 3 chunks. That step showed something useful. When the right chunk sat at positions 4–10 (summary only), the narrator almost never answered correctly (**2 of 16**). With original text attached to all 10, it got **all 16** right. The detail was in the chunk all along; the narrator just couldn't see it.

**Small extra fix: longer summaries.** After the main fix, almost every remaining wrong answer was a search miss. Search only looks at summaries, so a detail missing from the summary can't be found. I changed the summary prompt to keep every story-relevant fact (what people said, items, prices, decisions, outcomes, clues), using the story's own words. Summaries went from about 55 to 125 words.

**Results (test story), with each change measured separately:**

| | Correct, main set | Correct, hard set | Recall, hard set |
|---|---|---|---|
| v2 (summaries only) | 29 / 91 | 21 / 47 | 83.0% |
| + original text for all 10 chunks | 82 / 91 (**+53**) | 37 / 47 (**+16**) | 83.0% |
| + longer summaries (= v3) | 83 / 91 (+1, noise) | 40 / 47 (**+3**) | 89.4% |

**Where the gain comes from.** Almost all of it comes from attaching the original text. It took the main set from 29 to 82 correct. The longer summaries add very little:
- On the main set, +1, which is within noise. The long questions already share many words with the right chunk, so search was already finding it.
- On the hard set, +3. Here short questions name one specific detail, and a summary that contains that detail is easier to find. These +3 answers match the +3 extra chunks found exactly (39 → 42).
- The hard-set gain is **not statistically significant** with 47 questions, although it points the same way on the dev story (recall 93.6% → 100%).

A side effect: longer summaries made vector search *on its own* a bit worse on the main set (95.6% → 91.2%). One vector for a 130-word summary is less focused. BM25 got better at the same time, so the combined search came out even.

**Cost.** Original text adds about 2,500 prompt tokens per turn (about $0.00025), with no change in speed. Longer summaries cost about 100 extra output tokens per chunk with a small model.

---

## What I learned

1. **Measure before believing.** Two of my v1 ideas, "BM25 will fail on names" and "the shortcut saves time", turned out wrong once I tested them.
2. **Check the test, not just the system.** A big part of the early bad scores came from bad questions and a judge that counted honesty as lying.
3. **Finding and reading are different problems.** v2 fixed finding (recall +12 points), but correct answers stayed at 32% until v3 let the narrator read the original text (91%).
4. **Each fix moves the bottleneck.** After the original text, the remaining errors were search misses, which the longer summaries partly fix. The biggest problem left is timeline questions ("the third time I…"). Neither better search nor longer summaries fix those, so they need their own solution.

## Limits

- There are only two stories, both played by an AI. The questions and labels are AI-generated, with manual review.
- The test story was reused to check several steps. Each step was frozen before its test run, but reusing a test set makes the results a bit optimistic.
- The hard-set scores for v2 and for the "original text only" step were measured later, by turning the newer changes off with today's prompt. They show the effect of each change, not an exact replay of old code.
- The end-to-end noise is about ±5 out of 90.

*Note on version names: in `RESULTS.md` and `FREEZE.md`, this report's v3 was built and tested in three steps, named v3 (original text for the top 3), v4 (all 10) and v5 (longer summaries).*
