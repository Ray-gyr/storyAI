import { NextResponse } from 'next/server';
import { deleteSession } from '@/lib/sessionStore';
import { deleteMemoryNamespace } from '@/lib/vectorDBManager';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { sessionId } = body;

        if (!sessionId) {
            return NextResponse.json({ error: "Missing sessionId parameter" }, { status: 400 });
        }

        // Parallel map delete tasks to erase all traces
        await Promise.all([
            deleteSession(sessionId),
            deleteMemoryNamespace(sessionId)
        ]);

        return NextResponse.json({ success: true, message: `Session ${sessionId} completely eradicated from all databases.` });
    } catch (e: any) {
        console.error("[Story API] Error deleting session:", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
