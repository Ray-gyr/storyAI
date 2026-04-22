import { NextRequest, NextResponse } from "next/server";
import { getSession } from "../../../lib/sessionStore";
import { getPineconeIndex } from "../../../lib/Init";



export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const sessionId = searchParams.get("sessionId");

    if (!sessionId) {
        return NextResponse.json({ error: "Missing sessionId parameter" }, { status: 400 });
    }

    const session = await getSession(sessionId);
    if (!session) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    try {
        const pineconeRecords: any[] = [];
        const index = getPineconeIndex().namespace(sessionId);

        // 我们尝试拉取最新的几个 Pinecone ID 来做展示
        const listResponse = await index.listPaginated({ limit: 20 });
        if (listResponse.vectors) {
            // 安全提取 id 并且过滤掉可能的 undefined 或空字符串
            const ids = listResponse.vectors.map((v: any) => v?.id).filter(Boolean);

            if (ids.length > 0) {
                const fetchResponse = await index.fetch({ ids });
                if (fetchResponse.records) {
                    Object.values(fetchResponse.records).forEach((r: any) => {
                        pineconeRecords.push(r.metadata);
                    });
                }
            }
        }

        pineconeRecords.sort((a, b) => (a.start_turn || 0) - (b.start_turn || 0));

        return NextResponse.json({
            sessionId,
            currentState: session.currentState,
            chatHistory: session.memoryManager.chatHistory,
            unprocessedArchive: session.memoryManager.unprocessedArchive,
            pineconeRecords
        });

    } catch (e: any) {
        // 如果 Pinecone API 有限制或未准备好，不要阻塞基础 JSON 的回退
        return NextResponse.json({
            sessionId,
            currentState: session.currentState,
            chatHistory: session.memoryManager.chatHistory,
            unprocessedArchive: session.memoryManager.unprocessedArchive,
            pineconeError: e.message
        });
    }
}
