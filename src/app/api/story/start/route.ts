import { NextResponse } from 'next/server';
import { createSession } from '../../../../lib/sessionStore';

export async function POST(req: Request) {
    try {
        // 生成一个干净的独立 sessionId，保护数据隔离
        const sessionId = `web-session-${Date.now()}`;
        const session = createSession(sessionId);

        // 默认的基础故事开场白
        const basePrompt = "欢迎来到【无冬森林】的入口。你是一个名叫【亚力克】的游侠，身上带着一把满是铁锈的宽刃剑。四周雾气弥漫，空气中传来潮湿腐烂的味道。村庄的守灵长老曾告诉你，只要找到森林腹地的古代石碑，就能解开诅咒。但现在，面前有两条路：左边是一条满是泥泞和巨大脚印的野兽小径；右边则隐隐能看到断裂破败的精灵石阶。你要走哪条路？";

        // 将开场白压入系统记忆，让整个语境拥有起始锚点
        await session.memoryManager.addTurn({
            turn_id: 1,
            role: "assistant",
            text: basePrompt
        }, session.currentState, sessionId);

        return NextResponse.json({
            sessionId,
            basePrompt
        });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
