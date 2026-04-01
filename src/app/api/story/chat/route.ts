import { NextRequest } from 'next/server';
import { getSession } from '../../../../lib/sessionStore';
import { generateNextStoryTurnStream } from '../../../../lib/storyGenerator';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
    try {
        const { sessionId, userInput } = await req.json();

        if (!sessionId || !userInput) {
            return new Response("Missing sessionId or userInput", { status: 400 });
        }

        const session = await getSession(sessionId);
        if (!session) {
            return new Response("Current game session has expired or does not exist. Please refresh the page to start a new game.", { status: 404 });
        }

        // 调用我们的底层 Orchestrator 拿到异步流迭代器
        const stream = generateNextStoryTurnStream(
            userInput,
            session,
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
                "Cache-Control": "no-cache, no-transform",
                "X-Content-Type-Options": "nosniff",
                "Connection": "keep-alive"
            }
        });

    } catch (e: any) {
        return new Response(`Server internal error: ${e.message}`, { status: 500 });
    }
}
