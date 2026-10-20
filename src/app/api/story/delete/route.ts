import { NextResponse } from 'next/server';
import { deleteSession } from '@/lib/sessionStore';
import { deleteMemoryNamespace } from '@/lib/vectorDBManager';
import { describeError } from '@/lib/errors';

export async function POST(request: Request) {
    try {
        const { sessionId } = await request.json().catch(() => ({}));

        if (!sessionId) {
            return NextResponse.json({ error: "Missing sessionId parameter" }, { status: 400 });
        }

        // Parallel map delete tasks to erase all traces
        await Promise.all([
            deleteSession(sessionId),
            deleteMemoryNamespace(sessionId)
        ]);

        return NextResponse.json({ success: true, message: `Session ${sessionId} completely eradicated from all databases.` });
    } catch (e) {
        console.error("[Story API] Error deleting session:", e);
        return NextResponse.json({ error: describeError(e) }, { status: 500 });
    }
}
