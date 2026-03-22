import { MemoryManager, ChatTurn } from "./src/lib/memoryManager";
import { StoryState } from "./src/lib/currentState";
import { translateUserIntent } from "./src/lib/query";
import { retrieveMemories } from "./src/lib/vectorDBManager";
import * as dotenv from "dotenv";

dotenv.config();

async function testLongContextMemory() {
    console.log("🚀 启动 长上下文抗遗忘能力 测试 (50+轮)...\n");

    const sessionId = "test-session-" + Date.now();
    console.log(`[VectorDB] 本次长测试分配的新隔离区 namespace: ${sessionId}\n`);

    const manager = new MemoryManager();

    // 初始状态，故意完全**不包含**“守灵人艾尔”、“遗迹”和“六字密码”的信息
    const mockState: StoryState = {
        known_characters: [
            { name: "主角", description: "一个普通的冒险者，正在森林里探险" }
        ],
        known_locations: [
            { name: "微光森林", description: "一座布满迷雾的巨大森林" }
        ],
        known_items: [
            { name: "铁剑", description: "普通的防身武器" }
        ],
        current_location: "微光森林",
        current_task: "探索深处",
        inventory: ["铁剑"],
        custom_attributes: []
    };

    const dialogue: string[] = [
        "你踏入了薄雾缭绕的微光森林，空气中弥漫着潮湿的泥土气味。", 
        "我警惕地握紧手中的铁剑，慢慢向前探索。", 
        "在前面的一棵巨大橡树下，你看到一个穿着灰袍的白胡子老头。", 
        "我走上前向他打招呼：'老爷爷，这片森林有什么危险吗？'", 
        "老头咳嗽了两声：'年轻人，我是守灵人艾尔。你要小心林子深处的那座远古遗迹。'", 
        "遗迹？里面有什么？", 
        "艾尔压低声音：'那里有宝藏，但大门被魔法封印了。记住，开启大门必须念出古老的密码：【星光指引前路】，强行推门会被烧成灰烬。千万别忘了这六个字！'", 
        "我认真点点头：'星光指引前路。我记住了，谢谢艾尔爷爷！'", 
        "艾尔挥了挥手，转身走入迷雾中消失了。", 
        "我继续沿着小路深入森林。"
    ];

    // 添加无意义的打怪赶路凑够长度 (模拟游戏经过了很久，中间经历了无数回合)
    for (let i = 1; i <= 20; i++) {
        dialogue.push(`你在森林里走了很久，突然发现了一只变异史莱姆（第${i}波战斗）。`);
        dialogue.push(`我一跃而起挥舞铁剑，将这只史莱姆轻松斩杀，拿走掉落物，然后继续赶路。`);
    }

    dialogue.push("天色渐渐暗了下来，你在一条小溪边生火做饭。");
    dialogue.push("我吃了一块硬邦邦的干粮，在这森林的深处稍微休息了一下。");
    dialogue.push("经过漫长的跋涉，你终于来到了森林的最中心，眼前出现了一座极其宏伟的古代遗迹石门。");
    dialogue.push("这就是最开始碰到的那个艾尔爷爷说的远古遗迹大门吧！");
    dialogue.push("大门上雕刻着繁复发光的远古魔法阵，似乎在等待来访者的某种响应。你感觉到如果没有触发正确的开关，擅自推门会极其危险。");

    console.log(`⏳ 正在模拟 ${dialogue.length} 轮对话的持续输入（当积攒满10轮时会自动在后台触发语义切分和入库）...`);
    
    for (let i = 0; i < dialogue.length; i++) {
        const role = i % 2 === 0 ? "assistant" : "user";
        const turn: ChatTurn = { turn_id: i + 1, role, text: dialogue[i] };
        
        // 逐条加入。这里内部会在 unprocessedArchive 超长时自动阻塞调用 processArchive
        await manager.addTurn(turn, mockState, sessionId);
        process.stdout.write(`\r✅ 已处理轮次: ${i + 1}/${dialogue.length}`);
    }
    
    // 强制把最后一点还差几轮没凑够10条缓存的零碎回合也压进入库
    await manager.processArchive(mockState, sessionId);
    console.log("\n\n✅ 剧情前传模拟完毕！底层记忆库已悄悄记录了沿途所有的关键记忆切片。");

    console.log("\n=======================================================");
    console.log("【动态路由测试-命中Cache 短路测试】：玩家询问直接可见的东西");
    
    const shortCircuitInput = "我现在手里拿着什么武器来着？";
    console.log(`玩家输入: "${shortCircuitInput}"`);
    const shortCircuitIntent = await translateUserIntent(mockState, manager.chatHistory.slice(-3), shortCircuitInput);
    console.log("解析出的路由意图:", shortCircuitIntent);
    
    await retrieveMemories(shortCircuitIntent, sessionId);

    console.log("\n=======================================================");
    console.log("【动态路由测试-未命中Cache 需要深挖长记忆】：玩家在经历几十轮缠斗后，试图回忆那个已“溢出”的密码！");
    
    const userInput = "糟糕，经过刚才那几十场恶战，我都忘了...之前在森林入口遇到的那个老头艾尔，他当时告诉我的密码是什么来着？";
    console.log(`玩家输入: "${userInput}"`);

    const recentHistory = manager.chatHistory.slice(-3); // 工作记忆只有最后3轮
    
    console.log(`\n⏳ 正在翻译玩家意图并进行意图扩展检索...`);
    const queryIntent = await translateUserIntent(mockState, recentHistory, userInput);
    console.log("解析出的检索意图:", queryIntent);

    const results = await retrieveMemories(queryIntent, sessionId);

    console.log(`\n🎉 [语义检索结果] 共找回 ${results.length} 条回忆。所有的回忆详情如下：`);
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        console.log(`--------------------------------------------------`);
        console.log(`【名次 ${i+1}】(被访问记录: ${r.access_count}次) [ID: ${r.id}]`);
        console.log(`【包含角色】: ${r.characters_involved?.length ? r.characters_involved.join(', ') : '无'} | 【包含物品】: ${r.items_involved?.length ? r.items_involved.join(', ') : '无'} | 【包含地点】: ${r.location || '无'}`);
        console.log(`【语义标签】: 新实体=${r.has_new_entity}, 不可逆=${r.is_irreversible}, 推进主线=${r.advances_plot}`);
        console.log(`【模型的硬核摘要】: ${r.dense_summary}`);
        console.log(`【当时的对话原貌】:\n${r.original_text.trim()}`);
        console.log(`--------------------------------------------------`);
    }
}

testLongContextMemory();