/**
 * 基准测试 · 题目校验（question set 2），在 label.ts 之后运行
 *
 * 作废规则（任一不满足即作废，原因写入 validation.json）：
 *   1. 来源片段必须能回答这道题（label.ts 的判定）
 *   2. 有多个可接受片段时，它们给出的答案必须一致：答案随时间变化或在不同情节里不同的题有歧义
 *      （gpt-6-luna，3 次多数投票；只能检查标注池里出现过的片段）
 *   3. vague 题不得出现故事中的专有名词（世界状态里登记的实体名）
 *   4. 通过质量筛选（screening.json）且未被人工核对剔除（manual_review.json）
 *
 * 运行：npx tsx --env-file=.env scripts/eval/benchmark/validate_questions.ts <dev|test>
 * 输出：out/<story>/validation.json
 */
import { ChatOpenAI } from "@langchain/openai";
import { join } from "node:path";
import { z } from "zod";
import { BENCH_DIR, chunkContent, loadJsonIfExists, loadQuestions, loadStory, mapLimit, readJson, writeJson } from "./common";

const STORY_NAME = process.argv[2];
const VOTES = 3;

const checker = new ChatOpenAI({ modelName: "gpt-6-luna", openAIApiKey: process.env.OPENAI_API_KEY })
    .withStructuredOutput(z.object({
        reasoning: z.string().describe("One sentence."),
        consistent: z.boolean().describe("True only if every passage supports the expected answer and none implies a different answer to the same question."),
    }));

type Labels = { candidates: Record<string, Record<string, { acceptable: boolean }>> };

async function main() {
    const { dir, chunks, snapshots } = loadStory(STORY_NAME);
    const byId = new Map(chunks.map(c => [c.id, c]));
    const questions = loadQuestions(STORY_NAME);
    const labels = readJson<Labels>(join(dir, "labels.json"));
    const screening = loadJsonIfExists<Record<string, { keep: boolean; reason: string }>>(join(dir, "screening.json"), {});
    const manual = loadJsonIfExists<Record<string, Record<string, string>>>(join(BENCH_DIR, "manual_review.json"), {})[STORY_NAME] ?? {};
    const state = snapshots[300].currentState;
    const properNames = [...state.known_characters, ...state.known_locations, ...state.known_items]
        .flatMap(e => e.name.split(/[\s'’-]+/))
        .filter(w => /^[A-Z][a-z]{2,}/.test(w) && !["The", "Old", "Sister", "Lord", "Captain", "Brother", "Abbot"].includes(w));

    const results = await mapLimit(questions, 6, async q => {
        const reasons: string[] = [];
        const accepted = Object.entries(labels.candidates[q.qid] ?? {}).filter(([, v]) => v.acceptable).map(([id]) => id);

        if (screening[q.qid] && !screening[q.qid].keep) reasons.push(`screening: ${screening[q.qid].reason}`);
        if (q.qid in manual) reasons.push(`manual review: ${manual[q.qid]}`);
        // 质量筛选已经淘汰的题不再做一致性检查，省调用
        if (reasons.length > 0) return [q.qid, { valid: false, reasons, accepted_passages: 0, consistency: null }] as const;
        if (!labels.candidates[q.qid]?.[q.source_id]?.acceptable) reasons.push("source passage does not answer the question");

        if (q.type === "vague") {
            const used = properNames.filter(n => new RegExp(`\\b${n}\\b`).test(q.question));
            if (used.length > 0) reasons.push(`vague question uses proper names: ${[...new Set(used)].join(", ")}`);
        }

        let consistency: { consistent: boolean; reasoning: string } | null = null;
        if (accepted.length > 1) {
            const passages = accepted
                .map(id => byId.get(id)!)
                .sort((a, b) => a.start_turn - b.start_turn)
                .map(c => `PASSAGE (turns ${c.start_turn}-${c.end_turn}):\n${chunkContent(c)}`)
                .join("\n\n");
            const votes = [];
            for (let i = 0; i < VOTES; i++) {
                votes.push(await checker.invoke([
                    ["system", "You check whether a recall question has one unambiguous answer across several story passages that were all judged relevant to it."],
                    ["human", `QUESTION: ${q.question}\nEXPECTED ANSWER: ${q.expected_answer}\n\n${passages}`],
                ]));
            }
            const yes = votes.filter(v => v.consistent).length;
            const consistent = yes * 2 > votes.length;
            consistency = { consistent, reasoning: votes.find(v => v.consistent === consistent)!.reasoning };
            if (!consistent) reasons.push(`ambiguous across ${accepted.length} passages: ${consistency.reasoning}`);
        }

        return [q.qid, { valid: reasons.length === 0, reasons, accepted_passages: accepted.length, consistency }] as const;
    });

    const validation = Object.fromEntries(results);
    writeJson(join(dir, "validation.json"), validation);
    const invalid = results.filter(([, v]) => !v.valid);
    console.log(`valid ${results.length - invalid.length}/${results.length}`);
    for (const [qid, v] of invalid) console.log(`  ${qid}: ${v.reasons.join("; ")}`);
}

main().catch(e => { console.error(e); process.exit(1); });
