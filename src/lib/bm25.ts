/**
 * Okapi BM25（与 Python rank_bm25.BM25Okapi 逐分一致，见 scripts/eval/check_bm25_parity.ts）
 *
 * 每个存档只有几十到几百个记忆片段，直接在请求内存里建索引打分即可，无需外部检索服务。
 */

// 与 scripts/eval/common.py 的 STOPWORDS 保持一致：只去掉功能词，事件词全部保留
const STOPWORDS = new Set(`
a an the and or but if then so than that this these those there here of to in on at by for with from into onto
upon about over under after before during while as is are was were be been being am do does did doing have has had
having it its it's he him his she her hers they them their theirs we us our you your yours i me my mine who whom whose
which what when where why how not no nor all any both each few more most other some such only own same too very can
will just should would could may might must shall also up down out off again further once s t
`.split(/\s+/).filter(Boolean));

const TOKEN_RE = /[a-z0-9]+/g;

/** 小写 + 按非字母数字切分 + 去停用词（所有格 's 被切成单独的 s，随停用词一起去掉） */
export function tokenize(text: string): string[] {
    return (text.toLowerCase().match(TOKEN_RE) ?? []).filter(t => !STOPWORDS.has(t));
}

export interface BM25Params {
    k1: number;
    b: number;
    /** df 超过一半时原始 IDF 为负，按 rank_bm25 的做法替换为 epsilon * 平均 IDF */
    epsilon: number;
}

export const DEFAULT_BM25_PARAMS: BM25Params = { k1: 1.5, b: 0.75, epsilon: 0.25 };

export class BM25 {
    private readonly termFreqs: Map<string, number>[];
    private readonly docLens: number[];
    private readonly avgDocLen: number;
    private readonly idf = new Map<string, number>();

    constructor(docs: string[][], private readonly params: BM25Params = DEFAULT_BM25_PARAMS) {
        this.docLens = docs.map(d => d.length);
        this.avgDocLen = docs.length > 0 ? this.docLens.reduce((a, b) => a + b, 0) / docs.length : 0;
        this.termFreqs = docs.map(doc => {
            const tf = new Map<string, number>();
            for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1);
            return tf;
        });

        const df = new Map<string, number>();
        for (const tf of this.termFreqs) {
            for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
        }

        const n = docs.length;
        let idfSum = 0;
        const negative: string[] = [];
        for (const [t, freq] of df) {
            const idf = Math.log(n - freq + 0.5) - Math.log(freq + 0.5);
            this.idf.set(t, idf);
            idfSum += idf;
            if (idf < 0) negative.push(t);
        }
        const floor = df.size > 0 ? params.epsilon * (idfSum / df.size) : 0;
        for (const t of negative) this.idf.set(t, floor);
    }

    /** 每个文档对查询的得分（查询中重复出现的词会重复计分，与 rank_bm25 一致） */
    scores(query: string[]): number[] {
        const { k1, b } = this.params;
        const out = new Array<number>(this.termFreqs.length).fill(0);
        for (const t of query) {
            const idf = this.idf.get(t);
            if (idf === undefined) continue;
            this.termFreqs.forEach((tf, i) => {
                const f = tf.get(t) ?? 0;
                if (f === 0) return;
                const norm = k1 * (1 - b + b * this.docLens[i] / this.avgDocLen);
                out[i] += idf * f * (k1 + 1) / (f + norm);
            });
        }
        return out;
    }
}
