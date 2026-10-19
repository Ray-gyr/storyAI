/**
 * 基准测试 · 导出故事数据集（dev / test）
 *
 * 把 out/<story>/ 下给程序用的原始数据整理成可读、可分发的数据集：
 *   story.md          完整故事（按章节、回合排版）
 *   transcript.jsonl  每条对话一行
 *   chunks.jsonl      每个记忆片段一行（轮次、创建时间、摘要、原文、实体、反复事件标签）
 *   snapshots.jsonl   第 100 / 200 / 300 回合快照（对话条数、片段数、片段 id）
 *   questions.jsonl   题目与标注（出题、标注完成后才有）
 *   README.md         文件说明、故事设定与生成规则、数据对应的 commit
 *
 * PROTOCOL.md 第 6 节：冻结前不得接触测试故事的内容，因此 test 默认要求 FREEZE.md 已存在，
 * 否则需显式加 --force（导出后在冻结前不要阅读或据此调整）。
 *
 * 运行：npx tsx scripts/eval/benchmark/export_dataset.ts <dev|test> [--force]
 * 输出：scripts/eval/benchmark/export/<story>/
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH_DIR, Chunk, chunkContent, loadJsonIfExists, readJson, Snapshot, SNAPSHOTS, storyDir, Question } from "./common";
import { ROUNDS_PER_CHAPTER, STORIES } from "./stories";

const STORY_NAME = process.argv[2] as "dev" | "test";
const FORCE = process.argv.includes("--force");
const SPEC = STORIES[STORY_NAME];
if (!SPEC) throw new Error("usage: export_dataset.ts <dev|test> [--force]");
if (STORY_NAME === "test" && !existsSync(join(BENCH_DIR, "FREEZE.md")) && !FORCE) {
    throw new Error("The test story may only be exported after the freeze (FREEZE.md missing). See PROTOCOL.md section 6, or pass --force.");
}

type Turn = { turn_id: number; role: string; text: string };
type Labels = {
    candidates: Record<string, Record<string, { acceptable: boolean }>>;
    summary_has_answer: Record<string, { acceptable: boolean }>;
};

const jsonl = (rows: unknown[]) => rows.map(r => JSON.stringify(r)).join("\n") + "\n";

function main() {
    const dir = storyDir(STORY_NAME);
    const outDir = join(BENCH_DIR, "export", STORY_NAME);
    mkdirSync(outDir, { recursive: true });

    const corpus = readJson<{ sessionId: string; chunks: Chunk[] }>(join(dir, "corpus.json"));
    const transcript = readJson<Turn[]>(join(dir, "transcript.json"));
    const snapshots = SNAPSHOTS.map(r => readJson<Snapshot>(join(dir, `snapshot_${r}.json`)));
    const events = loadJsonIfExists<{ events: string[]; occurrences: { id: string }[][] } | null>(join(dir, "events.json"), null);
    const questionsFile = loadJsonIfExists<{ questions: Question[] } | null>(join(dir, "questions.json"), null);
    const labels = loadJsonIfExists<Labels | null>(join(dir, "labels.json"), null);

    // story.md：开场白之后每回合 = 玩家一条 + 叙述一条
    const lines = [`# ${SPEC.genre} — ${SPEC.protagonist}`, "", "## Setting", "", SPEC.setting, "", "## Opening", "", transcript[0]?.text ?? "", ""];
    for (let i = 1; i < transcript.length; i += 2) {
        const round = (i + 1) / 2;
        if ((round - 1) % ROUNDS_PER_CHAPTER === 0) {
            const chapter = SPEC.chapters[(round - 1) / ROUNDS_PER_CHAPTER];
            if (chapter) lines.push(`## Chapter ${(round - 1) / ROUNDS_PER_CHAPTER + 1}: ${chapter.location}`, "", `*Objective: ${chapter.objective}*`, "");
        }
        lines.push(`### Round ${round}`, "", `> **Player:** ${transcript[i]?.text ?? ""}`, "", transcript[i + 1]?.text ?? "", "");
    }
    writeFileSync(join(outDir, "story.md"), lines.join("\n"));
    writeFileSync(join(outDir, "transcript.jsonl"), jsonl(transcript));

    const eventsOf = (id: string) => events ? events.occurrences.flatMap((list, e) => list.some(o => o.id === id) ? [events.events[e]] : []) : undefined;
    writeFileSync(join(outDir, "chunks.jsonl"), jsonl(corpus.chunks.map(c => ({
        id: c.id,
        start_turn: c.start_turn,
        end_turn: c.end_turn,
        created_at: c.created_at,
        summary: c.dense_summary,
        content: chunkContent(c),
        location: c.location,
        characters: c.characters_involved,
        items: c.items_involved,
        ...(events ? { recurring_events: eventsOf(c.id) } : {}),
    }))));

    writeFileSync(join(outDir, "snapshots.jsonl"), jsonl(snapshots.map(s => ({
        round: s.round,
        taken_at: s.taken_at,
        turn_count: s.turn_count,
        chunk_count: s.chunk_ids.length,
        chunk_ids: s.chunk_ids,
    }))));

    if (questionsFile) {
        const createdAt = new Map(corpus.chunks.map(c => [c.id, c.created_at]));
        writeFileSync(join(outDir, "questions.jsonl"), jsonl(questionsFile.questions.map(q => {
            const accepted = labels ? Object.entries(labels.candidates[q.qid] ?? {}).filter(([, v]) => v.acceptable).map(([id]) => id) : undefined;
            return {
                ...q,
                ...(labels ? {
                    valid: Boolean(labels.candidates[q.qid]?.[q.source_id]?.acceptable),
                    answer_in_summary: labels.summary_has_answer[q.qid]?.acceptable,
                    gold_by_snapshot: Object.fromEntries(snapshots.map(s => [s.round, accepted!.filter(id => (createdAt.get(id) ?? Infinity) <= s.taken_at)])),
                } : {}),
            };
        })));
    }

    let commit = "unknown";
    try { commit = execSync("git rev-parse --short HEAD").toString().trim(); } catch { /* 非 git 环境 */ }
    writeFileSync(join(outDir, "README.md"), `# Story dataset: ${STORY_NAME}

A ${SPEC.genre} played for ${transcript.length > 0 ? (transcript.length - 1) / 2 : 0} rounds by an auto-player LLM through the Story AI pipeline. Generated for the long-story retrieval benchmark; see \`scripts/eval/benchmark/PROTOCOL.md\`.

- Protagonist: ${SPEC.protagonist}
- Structure: ${SPEC.chapters.length} chapters x ${ROUNDS_PER_CHAPTER} rounds; every chapter moves to a new location and objective.
- Recurring events (one is deliberately triggered per chapter): ${SPEC.recurringEvents.join("; ")}.
- Turns: ${transcript.length}; memory chunks: ${corpus.chunks.length}; snapshots after rounds ${SNAPSHOTS.join(", ")}.
- Exported at commit \`${commit}\`.

## Files

| File | Content |
|---|---|
| \`story.md\` | The full story, by chapter and round |
| \`transcript.jsonl\` | One turn per line: \`turn_id\`, \`role\` (user = player, assistant = narrator), \`text\` |
| \`chunks.jsonl\` | One memory chunk per line: turn range, creation time, the LLM summary used for retrieval, the original narration (\`content\`), entities, and recurring-event tags |
| \`snapshots.jsonl\` | The chunks that existed after rounds ${SNAPSHOTS.join(", ")} |
${questionsFile ? `| \`questions.jsonl\` | Recall questions (detail / vague / temporal) with the expected answer, source chunk${labels ? ", validity, whether the source summary contains the answer, and the acceptable chunks at each snapshot" : ""} |\n` : ""}
## Setting

${SPEC.setting}

## Chapters

${SPEC.chapters.map((c, i) => `${i + 1}. **${c.location}**: ${c.objective}`).join("\n")}
`);

    console.log(`exported ${STORY_NAME}: ${transcript.length} turns, ${corpus.chunks.length} chunks${questionsFile ? `, ${questionsFile.questions.length} questions` : ""} -> ${outDir}`);
}

main();
