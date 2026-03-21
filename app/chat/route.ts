import { NextResponse } from "next/server";
import { getStoryLLM } from "../../src/lib/Init";
import { storyWorkerPrompt } from "../../src/lib/prompt";
import { HumanMessage, AIMessage } from "@langchain/core/messages";

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const userAction = body.input;

        if (!userAction) {
            return NextResponse.json({ error: "前端未提供 action/input 输入" }, { status: 400 });
        }

        console.log("👉 [Server Route] 收到玩家行动:", userAction);

        // ==========================================
        // 1. 模拟数据准备 (Mock Data)
        // ==========================================
        // 这些内容未来会从数据库检索和状态管理器中获取
        const mockCurrentState = "主角正处于赛博朋克风的旧货市场，这里光线昏暗，到处是叫卖机械义体小贩的吆喝声。";
        const mockRetrievedContext = "废品区有一家名为'黑市机修'的隐秘店面，店主是个脾气暴躁的老头，但他手里通常有好货。";
        const mockChatHistory = [
            new HumanMessage("我向四周张望，这里有什么值得探索的商店吗？"),
            new AIMessage("市场深处有一块闪烁着全息投影的招牌，虽然接触不良经常闪烁，但隐隐写着'机修'两个字。")
        ];

        // ==========================================
        // 2. 调用模型生成
        // ==========================================
        const storyLLM = getStoryLLM();
        const storyChain = storyWorkerPrompt.pipe(storyLLM);

        const storyResult = await storyChain.invoke({
            currentState: mockCurrentState,
            retrievedContext: mockRetrievedContext,
            chatHistory: mockChatHistory,
            input: userAction
        });

        // ==========================================
        // 3. 返回给前端
        // ==========================================
        return NextResponse.json({
            success: true,
            reply: storyResult.content
        });

    } catch (error: any) {
        console.error("❌ [Server Route Error]:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
