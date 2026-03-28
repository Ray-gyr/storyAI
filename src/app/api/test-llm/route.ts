import { NextRequest } from 'next/server';
import { getStoryLLM } from '../../../lib/Init';
import { HumanMessage } from "@langchain/core/messages";

export async function POST(req: NextRequest) {
    try {
        const { prompt } = await req.json();

        console.log(`[TestLLM] 收到测试请求，使用故事模型...`);
        const llm = getStoryLLM();

        const stream = await llm.stream([
            new HumanMessage(prompt || "你好，请简单回复一条测试消息。")
        ]);

        const readableStream = new ReadableStream({
            async pull(controller) {
                try {
                    const { value, done } = await stream.next();
                    if (done) {
                        controller.close();
                    } else {
                        // LangChain 返回的是 AIMessageChunk, 需要提取 content 文本
                        let content = value.content;
                        if (typeof content !== 'string') {
                            content = JSON.stringify(content);
                        }
                        controller.enqueue(new TextEncoder().encode(content));
                    }
                } catch (err) {
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
        return new Response(`服务器内部错误: ${e.message}`, { status: 500 });
    }
}
