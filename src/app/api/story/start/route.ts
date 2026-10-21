import { NextResponse } from 'next/server';
import { createSession, updateSession } from '../../../../lib/sessionStore';
import { DEFAULT_STORY_SETTING, PRESET_EXAMPLE_STATE, PRESET_EXAMPLE_CHAT } from '../../../../lib/constants';
import { MemoryManager, ChatTurn } from '../../../../lib/memoryManager';
import { describeError } from '../../../../lib/errors';
import { checkUsage, clientIdFrom, runWithUsageClient } from '../../../../lib/usageLimit';
export const maxDuration = 60;

export async function POST(req: Request) {
    // Token 用量限制：超限时不开新局；开局的模型调用记到这个客户端名下
    const clientId = clientIdFrom(req);
    const usage = await checkUsage(clientId);
    if (!usage.allowed) {
        return NextResponse.json({ error: usage.message }, { status: 429, headers: { "Retry-After": String(usage.retryAfterSeconds) } });
    }
    return runWithUsageClient(clientId, () => startStory(req));
}

async function startStory(req: Request) {
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
        const firstTurn: ChatTurn = {
            turn_id: 1,
            role: "assistant",
            text: firstPrompt
        };
        await sessionData.memoryManager.addTurn(firstTurn, sessionData.currentState, sessionId);

        // [Redis] 保存！因为 createSession 里执行 updateSession 时第一段 prompt 还没压入。
        await updateSession(sessionId, sessionData, [firstTurn]);

        return NextResponse.json({
            sessionId,
            firstPrompt,
            currentState: sessionData.currentState,
            metadata: sessionData.metadata
        });
    } catch (e) {
        console.error("[StoryStart] Failed to create session:", e);
        return NextResponse.json({ error: describeError(e) }, { status: 500 });
    }
}
