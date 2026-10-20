# 📖 Story AI — Long-Horizon Narrative Engine with Hybrid Memory Retrieval

> An open-world text adventure built to stay coherent over long play sessions. It uses a dual-track memory architecture: a state machine for the current world state, and hybrid BM25 + vector retrieval over detailed summaries of past chunks, with each retrieved chunk's original text passed to the writer. Evaluated on two machine-played 300-round stories.

**[Live Demo](https://story-ai-ray.vercel.app/)** · Next.js · LangChain.js · Pinecone · Upstash Redis · GPT-6-luna & GPT-4o-mini

## Screenshot

<div align="center">
  <img src="public/chat.png" width="100%" alt="Story AI Main Chat Interface" />
</div>

<br />

<details>
  <summary><b>🔍 Check more screenshots (Home, New Universe, Detail)</b></summary>
  <p align="center">
    <img src="public/home.png" width="100%" alt="Home" />
    <br /><i>Universe Hub</i><br /><br />
    <img src="public/new_universe.png" width="100%" alt="New Universe" />
    <br /><i>World Creation</i><br /><br />
    <img src="public/detail.png" width="100%" alt="Detail" />
    <br /><i>Global State Monitor</i>
  </p>
</details>

---

## Version History

**v3 — Oct 2026 (let the writer read the details).** The writer now gets the original text of all 10 retrieved chunks, listed in story order with turn numbers, instead of summaries only. Chunk summaries were also made longer and more detailed, so details are easier to find. On a held-out 300-round story, correct answers to questions about the past went from 29/91 to 83/91.

**v2 — Oct 2026 (evaluation-driven redesign).** I benchmarked my own design decisions and reversed three of them:
- Replaced vector-only tier search with BM25 + vector hybrid retrieval.
- Removed the intent short-circuit router.
- Rewrote the writer prompt for memory fidelity.

Recall on the held-out story went from 82% to 95%, and it no longer decays as the story grows.

**v1 — Mar 2026 (initial release).** Dual-track memory with entity-filtered vector "tier search", and an LLM router that skipped retrieval when it judged the state sufficient.

The full write-up is in [REPORT.md](scripts/eval/benchmark/REPORT.md). Details and numbers are in [Key Engineering Decisions](#key-engineering-decisions), and the benchmark is in [scripts/eval/benchmark](scripts/eval/benchmark).

---

## The Core Problem

LLM-powered story games break down at scale. After ~20 turns, models forget earlier plot points. After ~100 turns, context windows overflow. Over hundreds of turns, the world loses coherence entirely.

Naive RAG pipelines solve the context overflow problem but fail at exact object recall. Standard semantic similarity is often too "fuzzy" to reliably retrieve specific entities, leading to "entity drift" where critical plot objects vanish or transform.

This project is my attempt to engineer around all three failure modes simultaneously.

---

## Architecture: Dual-Track Parallel Memory

Rather than a single memory strategy, the system runs two independent tracks in parallel after every turn:

### Track 1 — Global State Machine

After the story generator LLM (gpt-6-luna) finishes generating a response, a background Worker LLM (gpt-4o-mini) runs independently of the main story generation. It reads the latest dialogue and extracts **only what changed** — a structured `StateDiff` validated against a Zod schema:

```typescript
// Example diff extracted after "I pick up the ancient sword"
{
  updated_characters:[{name:"player",description:"A young man from the Shire holds the ancient sword"}],
  added_items:[{name:"Ancient Sword of Angels",description:"A magical sword made by angels that glows in the dark."}],
  inventory_added: ["Ancient Sword of Angels"],
  state_summary:"The player picked up the Ancient Sword of Angels."
}
```

This diff is merged into `currentState` in Redis. The state table stays bounded regardless of play length, and every future generation gets the full world state as a constraint without any growing overhead.

**Why this matters:** Separating state extraction from story generation means the main LLM never has to "remember" facts — they're always injected as structured ground truth.

### Track 2 — Memory Lifecycle

Chat history is maintained as a FIFO queue in Redis. 

1. **Sliding Window** — recent turns are kept in memory for immediate context.
2. **Unprocessed Archive** — turns that overflow the sliding window are stored here.
3. **Semantic Chunking** — when the buffer hits threshold, text is split with **context overlap between chunks** to prevent semantic fragmentation at boundaries. An LLM writes a detailed summary of each chunk (every story-relevant fact, in the story's own words) and lists the entities involved.
4. **Vectorization → Pinecone** — summary embeddings are stored with metadata (turn range, location, characters and items involved, importance flags). Summaries and original text are also kept in Redis.
5. **Retrieval** — every turn, the system retrieves the 10 most relevant chunks with hybrid BM25 + vector search, and gives the story generator LLM each chunk's summary and original text, in story order.

**Why this matters:** Separating memory into sliding window and long-term memory allows the system to maintain both immediate context and long-term coherence without overflowing the context window.

System Architecture Diagram:

<div align="center">
  <img src="public/pipeline.png" width="60%" alt="System Architecture Diagram" />
</div>
---

## Key Engineering Decisions

### Benchmark: two 300-round stories

Every decision below was tested, not assumed. The benchmark ([scripts/eval/benchmark](scripts/eval/benchmark)) uses two stories played for 300 rounds by an AI auto-player, with 130 memory chunks each. The **dev story** (sci-fi) is used for trying ideas. The **test story** (fantasy) is only used to check a version after its code is frozen.

There are two question sets about past events:
- **Main set:** fairly long questions with context.
- **Hard set:** short, low-context questions, the way a real player types ("Why did I avoid the Glass Flats in my original route?").

I measure two things:
- **Recall@10:** whether a correct chunk is among the 10 given to the writer.
- **End to end:** whether the writer's answer agrees with the story, judged by an LLM that I checked by hand (about 94% accurate).

Results on the test story:

| Version | Recall@10, main | Recall@10, hard | Correct, main | Correct, hard |
|---|---|---|---|---|
| v1 | 82.4% | 70.2% | — | — |
| v2 | 94.5% | 83.0% | 29 / 91 | 21 / 47 |
| **v3 (deployed)** | **94.5%** | **89.4%** | **83 / 91** | **40 / 47** |

### Hybrid Retrieval (BM25 + vector, quota fusion) — v2, Oct 2026

Every turn runs two retrievers over the session's memory chunks and merges them:

- **Vector:** the player's raw input is embedded and searched in Pinecone. It starts in parallel with the LLM query rewriter, so it adds no latency after rewriting.
- **BM25:** the raw input plus the rewriter's output (pronouns replaced with entity names, entities appended) is scored with Okapi BM25 over the chunk summaries. The summaries are kept in Redis and scored in memory per request; a session has tens to hundreds of chunks.
- **Fusion:** BM25's top 3 take the first slots, and the vector ranking fills the rest up to 10.

**How I got here.** The first version used vector-only "tier search": an entity-filtered vector query topped up with an unfiltered one. I assumed BM25 would fail because frequent entity names flatten IDF. Then I tested that on a machine-played 100-round pilot story (44 chunks, 88 recall questions; see [scripts/eval](scripts/eval)):

- The premise held only for core characters: the protagonist appears in 95% of chunk summaries (IDF 0.06 vs 2.3 for a typical event word). It is largely an artifact of the summarizer replacing pronouns with names.
- BM25 still matched or beat tier search. Removing entity terms from the BM25 query *hurt* it, so the entities were still useful.
- The entity filter barely filtered: on average 77% of chunks passed it, so tier search behaved like plain vector search.
- Vector search won exactly where wording diverged (e.g. "jacket" vs "coat"); BM25 won where it matched. The two were complementary.

| Pilot story | MRR@10 | Hit@5 | Hit@5 (paraphrased) |
|---|---|---|---|
| Tier search (v1) | 0.49 | 0.66 | 0.61 |
| BM25 only | 0.66 | 0.81 | 0.64 |
| **Hybrid (RRF, out-of-sample)** | **0.67** | **0.88** | **0.77** |

**Tuning.** Tuning 9 parameters on 40 questions overfit badly (0.78 → 0.60 MRR on held-out questions). I switched to grouped cross-validation to decide *how much* to tune. The pilot picked weighted RRF. On the 300-round dev story, though, RRF with BM25 weight 4 let BM25 decide the whole candidate set, and vector results only reordered it. I replaced it with the simpler quota rule, using the rule "fewest parameters within 0.01 of the best" (quotas 3–5 all score within 0.004).

**Result on the held-out test story:** Recall@10 rose from 82.4% to 94.5% on the main set, and from 70.2% to 83.0% on the hard set. More important for long play: on early events, v1 fell from 93% to 78% as the story tripled in length (round 100 → 300), while v2 stayed at 100% → 98%.

### Removed: Intent Short-Circuit — v2, Oct 2026

The first version asked an LLM router before every retrieval: *"Can the current state + recent history answer this without going to the DB?"* If yes, retrieval was skipped to save latency.

I measured it on a machine-played 100-round story ([scripts/eval](scripts/eval)) and removed it:
- It skipped retrieval on **37 of 40 recall questions**. For **32** of those, an LLM judge found the answer was *not* in the state or recent history, so the writer model had to make up the past.
- For ordinary action commands, it short-circuited only **4 of 100** turns. That saved ~0.6s on 4% of turns, not the ~30% I had assumed.

The router was inverted: questions about the past looked "answerable" because their entities appear in the state, while actions almost always went to retrieval. Every turn now retrieves.

### Memory Fidelity in the Writer Prompt — v2, Oct 2026

Retrieval was not the only failure point. In an end-to-end check (88 recall questions; the story model answers, an LLM judge compares the answer with the recorded fact), most wrong answers happened even though the right memory *was* in the prompt. The writer prompt was working against it:

- "Only use elements explicitly present in the current state" excluded everything retrieved from long-term memory.
- Retrieved memories were dumped into an unlabeled "Context" line with no instruction on how to use them.
- "No inner thoughts / describe only visible actions" ruled out recalling anything.

The prompt now labels the memory inputs and adds a Memory Fidelity rule. The past is fixed. When the player asks about an earlier event, the writer answers from memory exactly as recorded, or says the protagonist can't recall it. For ordinary actions, memories are used silently as background. That last clause matters: a first version let every action turn insert "Memory: ..." lines.

| Writer prompt (pilot story) | Consistent with the past | Contradicts it |
|---|---|---|
| Before | 48 / 88 | 37 / 88 |
| **After** | **78 / 88** | **10 / 88** |

### Fixing the Benchmark Itself

Two problems were in the measurement, not the system:
- **The judge.** The first judge had no "can't recall" verdict, so it scored honest uncertainty as a contradiction. The new judge separates the two. It runs 3 times per answer and keeps the majority, and I checked it by hand against a second judge model.
- **The questions.** Many wrong answers came from bad questions: "the 42nd water crisis", amounts that change over time, facts that happen several times. I rebuilt the set with stricter generation, LLM screening, manual review, and a check that every question has one answer across the whole story. With the same stories and the same system, the test score went from 55% to 79%.

### Original Text for Every Retrieved Memory — v3, Oct 2026

With v2, retrieval found a correct chunk for 94.5% of test questions, but the writer answered only 29 of 91 correctly. The writer only saw summaries (about 55 words for 413 words of story), and only 10–19% of answers were still in the summary.

v3 gives the writer the original text of all 10 retrieved chunks, listed in story order with turn numbers. An intermediate build attached original text to the top 3 only. It showed that when the right chunk sat at rank 4–10 (summary only), the writer answered just 2 of 16 correctly; with original text for all 10, it answered 16 of 16.

**Result on the test story:** correct answers went from 29/91 to 82/91 on the main set, and from 21/47 to 37/47 on the hard set. The cost is about 2,500 extra input tokens per turn (about $0.00025), with no change in latency.

### Detailed Chunk Summaries — v3, Oct 2026

After that, almost every remaining error was a retrieval miss: search only sees summaries, so a detail the summary dropped can't be found. The summary prompt now keeps every story-relevant fact (what was said, items, prices, decisions, outcomes, clues) in the story's own words. Summaries average about 125 words, up from 55. Both BM25 and the vector index use them.

**Result on the test story:** this is a small extra gain, not the main one.
- **Hard set:** Recall@10 went from 83.0% to 89.4%, and correct answers from 37/47 to 40/47. The 3 extra correct answers are exactly the 3 extra chunks found.
- **Main set:** no change (82 → 83 correct, within the ±5 run-to-run noise). Long questions already share enough words with the right chunk.
- **Caveat:** the hard-set gain is not statistically significant at n=47. It points the same way on the dev story (93.6% → 100%).

### LLM Selection Rationale

| Role | Model | Reason |
|------|-------|--------|
| Story Writer | gpt-6-luna | A newer model at about 1/3 the cost of gpt-5-mini per turn; memory fidelity held steady after the switch (75/88 vs 73/88) |
| World Setup | gpt-5-mini | The original writer model; still used for the initial state and title, which run once per story |
| State Worker, Summaries, Query Rewriter | gpt-4o-mini | Used since v1 and kept unchanged; cheap, with reliable structured JSON output |

---

## Known Limitations & What I'd Build Next

I documented these honestly because I think identifying architectural ceilings is as important as building the system.

**Current issue 1:** Timeline questions ("the third time I faced a water shortage…") remain the weakest category. The retrieved set usually holds only some occurrences of a recurring event, so the writer can't tell which one is "the third".

**Next: Ordinal-aware retrieval.** The rewriter detects "Nth time" in the question, retrieves many chunks matching the event, sorts them by turn, and picks the Nth episode.

**Current issue 2:** Current state table is a global table, which can lead to a large state table as the number of turns increases. 

**Next: State Hydration on Demand**
Spatial state decoupling — only hydrate sub-states relevant to the player's current scene or active event, not the full world state on every call.

> ⚠️ **Risk:** It's hard to distinguish whether a state is relevant to the scene. Some items may have a hidden-trigger linked to a world state in a far-off region. Moreover, to know what sub-states are relevant, the system must first understand the player intent. However, to fully comprehend the intent, the LLM often requires the context provided by those sub-states. This creates a chicken-and-egg problem.

**Current issue 3:** The benchmark has only two stories, both played by an AI, and the test story has been reused for several versions. Each version was frozen before its test run, but the results are likely somewhat optimistic. A fresh test story would give a cleaner number.

**Other ideas, not yet tested**
1. **Document expansion at write time.** The summary call also emits synonyms and likely player questions for BM25, targeting synonym gaps.
2. **Deeper candidates + re-ranking.** Take the top 30 from each retriever and let a small model pick the final 10.
3. **Diversity (MMR).** Recurring scenes produce near-duplicate chunks that can fill the top 10.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js (App Router), React, Tailwind CSS |
| Backend | Serverless Node.js with streaming |
| AI Orchestration | LangChain.js |
| State & Cache | Upstash Redis |
| Long-term Memory | Pinecone Vector DB |
| Validation | Zod schema |

---

## Running Locally

```bash
git clone https://github.com/Ray-gyr/storyAI
cd storyAI
npm install

# Set up environment variables
cp .env.example .env
# Fill in: OPENAI_API_KEY, PINECONE_API_KEY, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN

npm run dev
```

The Pinecone index must exist before the first run: name `story-memory`, dimension 1536 (`text-embedding-3-small`), metric cosine.

---

## What I Learned

Building this forced me to think carefully about **token budget as a first-class engineering constraint** — every architectural decision (state diffs instead of full state, sliding window instead of full history) was made to reduce tokens per request without sacrificing coherence.

The biggest insight: **finding the right memory and reading it are two different problems.** v2 made retrieval find the right chunk 95% of the time, but correct answers stayed at 32% until v3 let the writer read the original text (91%). The second insight: **check the test, not just the system.** A large part of my early "bad scores" came from bad questions and a judge that counted honesty as lying.
