/**
 * 基准测试 · 端到端检查的裁判（e2e.ts 与 rescore_e2e.ts 共用）
 *
 * 第一版只有 correct / contradicts / absent 三类，没有定义"记不清"该怎么判：
 * 裁判把如实回答"记不清"的回复几乎都判成了 contradicts（测试故事上 v2、v3 各 12/13 条）。
 * 第二版（judge v2）单独区分：
 *   correct        说出或明确体现了标准答案
 *   contradicts    有与参考段落不符的说法（包括"记不清，但……"后面附带的错误断言）
 *   cannot_recall  只表示记不清 / 不确定，没有做出与参考段落冲突的断言
 *   absent         根本没有回应这个问题
 */
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

export const VERDICTS = ["correct", "contradicts", "cannot_recall", "absent"] as const;
export type Verdict = (typeof VERDICTS)[number];
/** 裁判模型：默认 gpt-6-luna，可用环境变量 JUDGE_MODEL 覆盖（如 gpt-4o-mini，用于对照） */
export const JUDGE_MODEL = process.env.JUDGE_MODEL || "gpt-6-luna";
export const JUDGE_VERSION = `judge-v2/${JUDGE_MODEL}`;
// 校准（RESULTS.md "Judge v2"）：测试故事 v2/v3 回答共 176 条，luna 与 gpt-4o-mini 一致 141 条（抽查 8/8 正确）；
// 分歧 35 条中人工核对 20 条，luna 与人工一致 14 条、gpt-4o-mini 6 条。

const VerdictSchema = z.object({
        reasoning: z.string().describe("One sentence comparing the reply with the reference passage."),
        verdict: z.enum(VERDICTS).describe([
            "correct: the reply states or clearly reflects the expected answer.",
            "contradicts: the reply makes at least one claim that is incompatible with the reference passage. This includes replies that say they cannot recall but also assert something false (e.g. 'there was no such order').",
            "cannot_recall: the reply says the protagonist cannot recall, does not know, or is unsure, and makes no claim that conflicts with the reference passage.",
            "absent: the reply does not address the question at all.",
        ].join(" ")),
});

// gpt-6-luna 只支持默认 temperature（1），设 0 会报 400；因此 luna 裁判的判定有随机性，
// 其一致性需另行测量（rescore_e2e.ts 的重复评分）。gpt-4 系列可固定为 0。
const judge = new ChatOpenAI({
    modelName: JUDGE_MODEL,
    openAIApiKey: process.env.OPENAI_API_KEY,
    ...(JUDGE_MODEL.startsWith("gpt-4") ? { temperature: 0 } : {}),
}).withStructuredOutput(VerdictSchema);

/** luna 只能用 temperature 1，每条判 3 次取多数；gpt-4 系列 temperature 0，判 1 次 */
export const JUDGE_VOTES = JUDGE_MODEL.startsWith("gpt-4") ? 1 : 3;

async function judgeOnce(params: JudgeInput): Promise<{ verdict: Verdict; reasoning: string }> {
    return judge.invoke([
        ["system", "You check whether a story narrator's reply is consistent with what actually happened earlier in the story. Honest uncertainty is not a contradiction; a false claim is."],
        ["human", `PLAYER QUESTION: ${params.question}
EXPECTED ANSWER: ${params.expectedAnswer}

REFERENCE passage (what actually happened):
${params.reference}

NARRATOR'S REPLY:
${params.response}`],
    ]);
}

type JudgeInput = { question: string; expectedAnswer: string; reference: string; response: string };

/** 多数投票：至少两票相同取该判定；三票各不相同时取第一票 */
export function majorityVerdict(votes: Verdict[]): Verdict {
    const counts = new Map<Verdict, number>();
    for (const v of votes) counts.set(v, (counts.get(v) ?? 0) + 1);
    const [best, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return n >= 2 ? best : votes[0];
}

export async function judgeAnswer(params: JudgeInput): Promise<{ verdict: Verdict; reasoning: string; votes: Verdict[] }> {
    const results: { verdict: Verdict; reasoning: string }[] = [];
    for (let i = 0; i < JUDGE_VOTES; i++) results.push(await judgeOnce(params));
    const votes = results.map(r => r.verdict);
    const verdict = majorityVerdict(votes);
    return { verdict, reasoning: results.find(r => r.verdict === verdict)!.reasoning, votes };
}

export function tallyVerdicts<T extends { verdict: string }>(rows: T[]): Record<Verdict, number> {
    return Object.fromEntries(VERDICTS.map(v => [v, rows.filter(r => r.verdict === v).length])) as Record<Verdict, number>;
}
