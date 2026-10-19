/**
 * 检索实验 · 向量侧排名：给一组题目补上 Pinecone 的检索结果（深度 DEPTH，供 RRF 调参使用）
 *
 *   dense      增强查询（改写句 + 实体名）的无过滤向量检索
 *   tier       旧版 tier search：带实体过滤的结果优先，不足时用无过滤结果补齐
 *   dense_raw  玩家原始问题的无过滤向量检索（检验检索能否不等意图翻译）
 *
 * 运行：npx tsx --env-file=.env scripts/eval/rank_vectors.ts [questionsFile]
 * 输入/输出：scripts/eval/out/<questionsFile>（原地补上 rankings 字段）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getEmbeddings, getPineconeIndex } from "../../src/lib/Init";
import { QueryIntent } from "../../src/lib/query";

const OUT_DIR = join(process.cwd(), "scripts", "eval", "out");
const FILE = process.argv[2] || "questions.json";
const DEPTH = 50;

type Ranked = { id: string; score: number }[];
type QueryResponse = { matches?: { id: string; score?: number }[] };

/** 与旧版 vectorDBManager.retrieveMemories 相同的 metadata filter */
function entityFilter(intent: QueryIntent) {
    const conditions: object[] = [];
    if (intent.characters_involved.length > 0) conditions.push({ characters_involved: { $in: intent.characters_involved } });
    if (intent.items_involved.length > 0) conditions.push({ items_involved: { $in: intent.items_involved } });
    if (intent.locations_involved.length > 0) conditions.push({ location: { $in: intent.locations_involved } });
    return conditions.length > 0 ? { $or: conditions } : undefined;
}

const toRanked = (r: QueryResponse): Ranked => (r.matches || []).map(m => ({ id: m.id, score: m.score ?? 0 }));

/** tier search 的合并：过滤结果优先，再用无过滤结果去重补齐 */
function mergeTiers(filtered: Ranked | null, unfiltered: Ranked): Ranked {
    const seen = new Set<string>();
    return [...(filtered || []), ...unfiltered].filter(m => !seen.has(m.id) && seen.add(m.id)).slice(0, DEPTH);
}

async function main() {
    const path = join(OUT_DIR, FILE);
    const data = JSON.parse(readFileSync(path, "utf-8"));
    const index = getPineconeIndex().namespace(data.sessionId);
    const embeddings = getEmbeddings();

    for (const [i, q] of data.questions.entries()) {
        const [vector, rawVector] = await embeddings.embedDocuments([q.enhanced_query, q.question]);
        const filter = entityFilter(q.intent);
        const [filteredRes, denseRes, rawRes] = await Promise.all([
            filter ? index.query({ vector, topK: DEPTH, includeMetadata: false, filter }) : Promise.resolve(null),
            index.query({ vector, topK: DEPTH, includeMetadata: false }),
            index.query({ vector: rawVector, topK: DEPTH, includeMetadata: false }),
        ]);
        const dense = toRanked(denseRes);
        q.tier_filtered_count = filteredRes ? (filteredRes.matches || []).length : null;
        q.rankings = {
            tier: mergeTiers(filteredRes ? toRanked(filteredRes) : null, dense),
            dense,
            dense_raw: toRanked(rawRes),
        };
        process.stdout.write(`\r${i + 1}/${data.questions.length}`);
    }

    writeFileSync(path, JSON.stringify(data, null, 2));
    console.log(`\nranked ${data.questions.length} questions in ${FILE} (depth ${DEPTH})`);
}

main().catch(e => { console.error(e); process.exit(1); });
