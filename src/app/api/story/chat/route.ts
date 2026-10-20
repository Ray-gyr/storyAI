import { NextRequest, after } from 'next/server';
import { getSession, acquireSessionLock, releaseSessionLock, SessionData } from '../../../../lib/sessionStore';
import { generateNextStoryTurnStream, finalizeStoryTurn, StoryTurnResult } from '../../../../lib/storyGenerator';
import { describeError } from '../../../../lib/errors';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
    const { sessionId, userInput } = await req.json().catch(() => ({}));

    if (!sessionId || typeof userInput !== "string" || !userInput.trim()) {
        return new Response("Missing sessionId or userInput", { status: 400 });
    }

    // 1. 获取会话锁，确保上一回合的后台保存已经完成，避免读到旧存档并互相覆盖
    let lockToken: string | null = null;
    const releaseLock = async () => {
        if (!lockToken) return;
        const token = lockToken;
        lockToken = null;
        await releaseSessionLock(sessionId, token).catch(e => console.error("[Chat API] Failed to release session lock:", e));
    };

    let session: SessionData | null;
    let stream: AsyncGenerator<string, StoryTurnResult>;
    let firstChunk: IteratorResult<string, StoryTurnResult>;
    try {
        lockToken = await acquireSessionLock(sessionId);
        if (!lockToken) {
            return new Response("The world is still settling from your last action. Please try again in a moment.", { status: 409 });
        }

        session = await getSession(sessionId);
        if (!session) {
            await releaseLock();
            return new Response("Current game session has expired or does not exist. Please refresh the page to start a new game.", { status: 404 });
        }

        // 调用我们的底层 Orchestrator 拿到异步流迭代器
        // 先拉取第一块再返回响应：意图解析或模型连接失败时可以返回真正的错误状态码，而不是一个中途断开的流
        stream = generateNextStoryTurnStream(userInput, session, sessionId);
        firstChunk = await stream.next();
    } catch (e) {
        console.error("[Chat API Error]", e);
        await releaseLock();
        return new Response(`Server internal error: ${describeError(e)}`, { status: 500 });
    }

    const activeSession = session;
    const activeStream = stream;

    // 2. 流结束后（响应发送完毕）在请求生命周期内完成落盘，再释放锁
    let turnSettled = false;
    let settleTurn!: (turn: StoryTurnResult | null) => void;
    const turnDone = new Promise<StoryTurnResult | null>(resolve => { settleTurn = resolve; });
    const resolveTurn = (turn: StoryTurnResult | null) => {
        if (turnSettled) return;
        turnSettled = true;
        settleTurn(turn);
    };

    after(async () => {
        try {
            const turn = await turnDone;
            if (turn) {
                await finalizeStoryTurn(userInput, turn, activeSession, sessionId);
            }
        } catch (e) {
            console.error("[StoryGenerator] 回合收尾处理崩溃:", e);
        } finally {
            await releaseLock();
        }
    });

    // 玩家中途断开：本回合不保存，并直接释放锁
    // 若在流被读取前就断开，框架既不会 pull / cancel 这个流，也不会认为响应已结束，
    // 上面的 after() 回调就不会执行，所以这里只能靠请求的 abort 信号感知并自行释放锁
    const abandonTurn = () => {
        // 回合已正常结束时（收尾可能还在进行）不能提前释放锁
        if (turnSettled) return;
        resolveTurn(null);
        activeStream.return({ fullText: "", retrievedMemories: [] }).catch(() => { });
        void releaseLock();
    };
    if (req.signal.aborted) {
        abandonTurn();
    } else {
        req.signal.addEventListener("abort", abandonTurn, { once: true });
    }

    // 3. 建立 Web ReadableStream 桥接，推向前端打字机
    const encoder = new TextEncoder();
    let pending: IteratorResult<string, StoryTurnResult> | null = firstChunk;
    const readableStream = new ReadableStream({
        async pull(controller) {
            try {
                const { value, done } = pending ?? await activeStream.next();
                pending = null;
                if (done) {
                    resolveTurn(value);
                    controller.close();
                } else {
                    controller.enqueue(encoder.encode(value));
                }
            } catch (err) {
                console.error("[Streaming API Error]", err);
                // 生成中途失败：本回合不保存，前端会提示玩家重试；没有需要落盘的内容，直接释放锁
                resolveTurn(null);
                void releaseLock();
                controller.error(err);
            }
        },
        cancel() {
            abandonTurn();
        }
    });

    return new Response(readableStream, {
        headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "X-Content-Type-Options": "nosniff",
            "Connection": "keep-alive"
        }
    });
}
