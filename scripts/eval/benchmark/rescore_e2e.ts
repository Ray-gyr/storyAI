/**
 * 基准测试 · 用新评分标准（judge.ts，judge v2）对已有的端到端回答重新打分
 *
 * 不重新生成回答、不改任何配置：只对 e2e*.json 里已有的回复重新判定（PROTOCOL.md 第 6 节第 5 条：评测代码的修正）。
 * --repeat N：独立调用 judgeAnswer N 次（每次内部已按 JUDGE_VOTES 多数投票），用来测量判定的稳定性；
 *            最终判定取第一次的结果。
 * 裁判模型由环境变量 JUDGE_MODEL 决定（默认 gpt-6-luna）。
 *
 * 运行：npx tsx --env-file=.env scripts/eval/benchmark/rescore_e2e.ts <dev|test> <e2e 文件...> [--repeat N]
 * 输出：out/<story>/<e2e 文件名>.rescore.<judge model>.json
 */
import { join } from "node:path";
import { chunkContent, loadQuestions, loadStory, mapLimit, readJson, writeJson } from "./common";
import { JUDGE_MODEL, JUDGE_VERSION, judgeAnswer, tallyVerdicts, Verdict } from "./judge";

const STORY_NAME = process.argv[2];
const repeatIdx = process.argv.indexOf("--repeat");
const REPEAT = repeatIdx >= 0 ? Number(process.argv[repeatIdx + 1]) : 1;
const FILES = process.argv.slice(3).filter((a, i, all) => a !== "--repeat" && all[i - 1] !== "--repeat");

type E2ERow = { qid: string; type: string; verdict: string; response: string; gold_retrieved: boolean };

async function main() {
    const { dir, chunks } = loadStory(STORY_NAME);
    const byId = new Map(chunks.map(c => [c.id, c]));
    const questions = new Map(loadQuestions(STORY_NAME).map(q => [q.qid, q]));

    for (const file of FILES) {
        const { results } = readJson<{ results: E2ERow[] }>(join(dir, file));
        const rows = await mapLimit(results, 8, async r => {
            const q = questions.get(r.qid)!;
            const judgements: { verdict: Verdict; reasoning: string; votes: Verdict[] }[] = [];
            for (let i = 0; i < REPEAT; i++) {
                judgements.push(await judgeAnswer({
                    question: q.question,
                    expectedAnswer: q.expected_answer,
                    reference: chunkContent(byId.get(q.source_id)!),
                    response: r.response,
                }));
            }
            return { qid: r.qid, type: r.type, gold_retrieved: r.gold_retrieved, old_verdict: r.verdict, verdict: judgements[0].verdict, reasoning: judgements[0].reasoning, votes: judgements[0].votes, repeats: judgements.map(j => j.verdict), response: r.response };
        });

        const summary = {
            judge: JUDGE_VERSION,
            source: file,
            n: rows.length,
            new: tallyVerdicts(rows),
            old: Object.fromEntries(["correct", "contradicts", "absent"].map(v => [v, rows.filter(r => r.old_verdict === v).length])),
            // 每条回复的 N 次判定是否完全一致
            self_agreement: REPEAT > 1 ? rows.filter(r => r.repeats.every(v => v === r.repeats[0])).length / rows.length : null,
        };
        console.log(JSON.stringify(summary));
        writeJson(join(dir, file.replace(/\.json$/, `.rescore.${JUDGE_MODEL}.json`)), { summary, rows });
    }
}

main().catch(e => { console.error(e); process.exit(1); });
