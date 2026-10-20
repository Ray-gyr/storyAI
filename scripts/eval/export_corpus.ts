/**
 * 检索实验 · 导出语料：把实验存档在 Pinecone 里的全部记忆片段 + 最终世界状态导出到本地。
 *
 * 运行：npx tsx --env-file=.env scripts/eval/export_corpus.ts
 * 输入：scripts/eval/out/session.json
 * 输出：scripts/eval/out/corpus.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPineconeIndex } from "../../src/lib/Init";
import { getSession } from "../../src/lib/sessionStore";

const OUT_DIR = join(process.cwd(), "scripts", "eval", "out");

async function main() {
    const { sessionId } = JSON.parse(readFileSync(join(OUT_DIR, "session.json"), "utf-8"));
    const index = getPineconeIndex().namespace(sessionId);

    // 分页列出全部向量 ID
    const ids: string[] = [];
    let paginationToken: string | undefined;
    do {
        const page = await index.listPaginated({ limit: 100, paginationToken });
        ids.push(...(page.vectors || []).map(v => v.id).filter((id): id is string => Boolean(id)));
        paginationToken = page.pagination?.next;
    } while (paginationToken);

    // 分批取回 metadata
    const chunks: Record<string, unknown>[] = [];
    for (let i = 0; i < ids.length; i += 50) {
        const res = await index.fetch({ ids: ids.slice(i, i + 50) });
        for (const [id, record] of Object.entries(res.records || {})) {
            chunks.push({ id, ...(record.metadata || {}) });
        }
    }
    chunks.sort((a, b) => Number(a.start_turn) - Number(b.start_turn));

    const session = await getSession(sessionId);
    if (!session) throw new Error(`session ${sessionId} not found in Redis`);

    writeFileSync(join(OUT_DIR, "corpus.json"), JSON.stringify({
        sessionId,
        chunks,
        finalState: session.currentState,
    }, null, 2));
    console.log(`exported ${chunks.length} chunks (turns ${chunks[0]?.start_turn}–${chunks[chunks.length - 1]?.end_turn})`);
}

main().catch(e => { console.error(e); process.exit(1); });
