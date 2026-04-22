import { NextResponse } from 'next/server';
import { createSession, updateSession } from '../../../../lib/sessionStore';
import { DEFAULT_STORY_SETTING, PRESET_EXAMPLE_STATE, PRESET_EXAMPLE_CHAT } from '../../../../lib/constants';
import { MemoryManager } from '../../../../lib/memoryManager';
export const maxDuration = 60;

export async function POST(req: Request) {
    try {
        const { storySetting } = await req.json().catch(() => ({}));

        // 生成一个干净的独立 sessionId，保护数据隔离
        const sessionId = `web-session-${Date.now()}`;

        // 如果用户没输入，则使用默认的硬核开场设定
        const defaultSetting = DEFAULT_STORY_SETTING;

        const finalSetting = storySetting || defaultSetting;

        let sessionData;
        let firstPrompt;

        if (finalSetting === defaultSetting) {
            // Bypass LLM generation for the default story
            console.log(`[StoryStart] Bypassing LLM generation for default story, injecting presets...`);
            const memoryManager = new MemoryManager();
            firstPrompt = PRESET_EXAMPLE_CHAT[0].text;
            sessionData = {
                memoryManager,
                currentState: PRESET_EXAMPLE_STATE as any,
                metadata: {
                    title: "Apocalypse Rebirth",
                    style: "Survival Thriller"
                }
            };
        } else {
            // Build via LLM
            const result = await createSession(sessionId, finalSetting);
            sessionData = result.sessionData;
            firstPrompt = result.firstPrompt;
        }

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
