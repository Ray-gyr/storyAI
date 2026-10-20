import { NextRequest, NextResponse } from "next/server";
import { getSession, getTranscript } from "../../../../lib/sessionStore";
import { describeError } from "../../../../lib/errors";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const sessionId = searchParams.get("sessionId");

    if (!sessionId) {
        return NextResponse.json({ error: "Missing sessionId parameter" }, { status: 400 });
    }

    try {
        const [session, transcript] = await Promise.all([
            getSession(sessionId),
            getTranscript(sessionId)
        ]);
        if (!session) {
            return NextResponse.json({ error: "Session not found" }, { status: 404 });
        }

        // 旧存档还没有完整对话记录时，退回到记忆管道里仍保留的轮次
        const { unprocessedArchive, chatHistory } = session.memoryManager;
        const fallback = [...unprocessedArchive, ...chatHistory].sort((a, b) => a.turn_id - b.turn_id);

        return NextResponse.json({
            transcript: transcript.length > 0 ? transcript : fallback,
            metadata: session.metadata
        });
    } catch (e) {
        console.error("[Story Load] Failed to load session:", e);
        return NextResponse.json({ error: describeError(e) }, { status: 500 });
    }
}
