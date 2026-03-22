import { NextRequest } from 'next/server';
import { getSession } from '../../../../lib/sessionStore';
import { generateNextStoryTurnStream } from '../../../../lib/storyGenerator';

export async function POST(req: NextRequest) {
    try {
        const { sessionId, userInput } = await req.json();

        if (!sessionId || !userInput) {
            return new Response("Missing sessionId or userInput", { status: 400 });
        }

        const session = getSession(sessionId);
        if (!session) {
            return new Response("当前游戏会话已过期或不存在，请刷新页面重新开始。", { status: 404 });
        }

        // 调用我们的底层 Orchestrator 拿到异步流迭代器
        const stream = generateNextStoryTurnStream(
            userInput,
            session.currentState,
            session.memoryManager,
            sessionId
        );

        // 建立 Web ReadableStream 桥接，推向前端打字机
        const readableStream = new ReadableStream({
            async pull(controller) {
                try {
                    const { value, done } = await stream.next();
                    if (done) {
                        controller.close();
                    } else {
                        controller.enqueue(new TextEncoder().encode(value));
                    }
                } catch (err) {
                    console.error("[Streaming API Error]", err);
                    controller.error(err);
                }
            }
        });

        return new Response(readableStream, {
            headers: {
                "Content-Type": "text/plain; charset=utf-8",
                "Cache-Control": "no-cache",
                // 为了兼容某些代理网关，有时候设定 SSE 会更好，但纯 ReadableStream fetch 也可以
            }
        });

    } catch (e: any) {
        return new Response(`服务器内部错误: ${e.message}`, { status: 500 });
    }
}
