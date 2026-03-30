import { NextResponse } from 'next/server';
import { createSession, updateSession } from '../../../../lib/sessionStore';
import { DEFAULT_STORY_SETTING } from '../../../../lib/constants';

export const maxDuration = 60;

export async function POST(req: Request) {
    try {
        const { storySetting } = await req.json().catch(() => ({}));

        // 生成一个干净的独立 sessionId，保护数据隔离
        const sessionId = `web-session-${Date.now()}`;

        // 如果用户没输入，则使用默认的硬核开场设定
        const defaultSetting = DEFAULT_STORY_SETTING;

        const finalSetting = storySetting || defaultSetting;

        // 调用新的 createSession，它会同时生成初始状态和第一段剧情
        const { sessionData, firstPrompt } = await createSession(sessionId, finalSetting);

        // 将生成的开场白压入系统记忆，让整个语境拥有起始锚点
        await sessionData.memoryManager.addTurn({
            turn_id: 1,
            role: "assistant",
            text: firstPrompt
        }, sessionData.currentState, sessionId);
        
        // [Redis] 保存！因为 createSession 里执行 updateSession 时第一段 prompt 还没压入。
        await updateSession(sessionId, sessionData);

        return NextResponse.json({
            sessionId,
            firstPrompt,
            currentState: sessionData.currentState,
            metadata: sessionData.metadata
        });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
