import { NextResponse } from 'next/server';
import { createSession, updateSession } from '../../../../lib/sessionStore';

export const maxDuration = 60;

export async function POST(req: Request) {
    try {
        const { storySetting } = await req.json().catch(() => ({}));

        // 生成一个干净的独立 sessionId，保护数据隔离
        const sessionId = `web-session-${Date.now()}`;

        // 如果用户没输入，则使用默认的硬核开场设定
        const defaultSetting = `
You are the master architect and narrator of a fast-paced, highly satisfying post-apocalyptic survival web novel (末世重生爽文). Your task is to generate subsequent story events based on the following core framework. 

【Core Premise: The Rebirth】
The world ended on [Day 0] due to the "Abyss Convergence"—a sudden global catastrophe bringing extreme weather, spatial rifts, and mutated monsters. The protagonist survived for 10 grueling years in the wasteland, only to be betrayed and killed by their trusted faction for a high-tier artifact. 
Miraculously, the protagonist opens their eyes to find they have regressed to exactly 30 days before the apocalypse. Armed with a decade of future knowledge, combat experience, and the memory of hidden opportunities, they will not be a victim again.

【Protagonist Profile & Goal】
- Identity: A ruthless, pragmatic, and hyper-competent survivor. 
- Mindset: Cold calculation over naive empathy. They do not trust easily, eliminate threats preemptively, and focus solely on personal power and survival. 
- Core Goal: Hoard massive resources, secure the ultimate impenetrable safehouse, awaken a hidden SSS-rank talent before the timeline officially shifts, and eventually crush those who betrayed them in the past life.

【Story Framework & Development】
Phase 1: The Countdown (Current Phase) - Liquidating assets, taking out massive loans, hoarding food, weapons, and strategic materials. Fortifying a hidden base.
Phase 2: The Outbreak - The apocalypse hits. While others panic, the protagonist systematically hunts the first mutated elites to secure first-clear rewards and exclusive spatial/combat abilities.
Phase 3: The Dominance - Establishing an independent stronghold, monopolizing future resource nodes, and effortlessly outsmarting rival factions and former enemies.

【World-Building Mechanics】
- Resources are king: Food, clean water, and medicine are currency. 
- Evolution: Humans kill monsters to absorb "Core Fragments" to upgrade physical stats or unlock unique abilities.
- The Law of the Jungle: Societal morals collapse instantly. Strength is the only truth.

【Narrative Style & Constraints - CRITICAL】
1. Hard-Boiled & Action-Oriented: Use direct, punchy, and visceral language. Focus on physical actions, clear resource management (numbers, loot), and tactical decisions.
2. NO Purple Prose: Absolutely no vague metaphors, poetic inner monologues, or overly dramatic emotional breakdowns. Describe things exactly as they are (e.g., "I drove the machete through its skull," NOT "The blade danced like a silver phantom of despair").
3. Rapid Pacing: Skip mundane transitions. Jump directly to the core conflict, the loot acquisition, or the satisfying face-slapping (打脸) moments. 
4. The "Satisfying" (爽) Factor: The protagonist must always be one step ahead. Their future knowledge must translate into tangible advantages, making enemies look foolish and rewarding the reader with frequent dopamine hits of progression.
`;

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
