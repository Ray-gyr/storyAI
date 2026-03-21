import { MemoryManager, ChatTurn } from "./src/lib/memoryManager";
import { StoryState } from "./src/lib/currentState";
import * as dotenv from "dotenv";

dotenv.config();

async function testMemoryManager() {
    console.log("🚀 启动 MemoryManager 测试 (滑动窗口 & 语义切分)...\n");

    const manager = new MemoryManager();

    const mockState: StoryState = {
        known_characters: [
            { name: "主角", description: "一个普通的冒险者" }
        ],
        known_locations: [],
        known_items: [],
        current_location: "村庄",
        current_task: "生存下去",
        inventory: [],
        custom_attributes: []
    };

    const dialogue = [
        "村长告诉你，村子北边的森林里有地精出没。",
        "我拿上铁剑，前往北边森林。",
        "你在森林边缘遇到了两只地精，它们向你扑来。",
        "我挥舞铁剑，斩向最前面的一只地精。",
        "你一剑击退了它，但另一只趁机咬住了你的腿。",
        "我忍痛踢开它，并顺势刺入它的心脏。",
        "一只地精倒下了，另一只吓得转身就跑。",
        "我没有追击，而是包扎了伤口，继续深入。",
        "你在森林深处发现了一个古老的石头祭坛。",
        "我走近祭坛仔细观察。",
        "祭坛上放着一本发光的魔法书，突然一个幽灵守卫出现了。",
        "我试图和幽灵守卫沟通。",
        "幽灵守卫听不懂你的话，举起长矛发起了冲锋。",
        "我侧身躲开，并用铁剑格挡。",
        "你的铁剑被长矛的幽灵力量腐蚀，断成了两截。",
        "我扔掉断剑，直接用拳头砸向幽灵。",
        "你的拳头穿过了幽灵的身体，没有任何伤害。",
        "我赶紧拿起发光的魔法书，转身开启护盾！",
        "魔法书释放出一道金光，将幽灵击碎，但书页也燃烧了起来。",
        "我扑灭火焰，把剩下的残章塞进背包。",
        "你成功存活下来，带着魔法书残章离开了森林。",
        "回到村子，村长看到你狼狈的样子，惊呆了。",
        "我把地精的耳朵和魔法书残章扔在桌上。",
        "村长给了你 100 枚金币，并说这是你们村的至宝。",
        "我在客栈租了一间房，倒头就睡。"
    ];

    try {
        console.log("⏳ 正在逐轮推入这 25 组连续对话 (配置 WINDOW_SIZE=10)...\n");
        for (let i = 0; i < dialogue.length; i++) {
            const role = i % 2 === 0 ? "assistant" : "user";
            const turn: ChatTurn = {
                turn_id: i + 1,
                role: role,
                text: dialogue[i]
            };

            const records = await manager.addTurn(turn, mockState);

            if (records.length > 0) {
                console.log(`\n🎉 [断点捕获] 在第 ${i + 1} 轮，unprocessedArchive 满了！由于滑动窗口推进，大模型开始语义切分并提取了 ${records.length} 个记忆记录：`);
                for (const r of records) {
                    console.log(` -> 提取 Chunk (Turn ${r.start_turn} - ${r.end_turn})`);
                    console.log(`      摘要: ${r.dense_summary}`);
                }
            }
        }

        console.log(`\n==== 模拟结束 ====`);
        console.log(`目前 chatHistory 长度: ${manager.chatHistory.length} (预期 10)`);
        console.log(`目前 unprocessedArchive 长度: ${manager.unprocessedArchive.length} (预期 5)`);

        console.log("\n⏳ 强制处理剩余的归档记录 (ProcessArchive)...");
        const remainingRecords = await manager.processArchive(mockState);

        console.log(`\n🎉 强制处理生成了 ${remainingRecords.length} 个记忆块：`);
        for (const record of remainingRecords) {
            console.log(` -> 提取 Chunk (Turn ${record.start_turn} - ${record.end_turn})`);
            console.log(`      摘要: ${record.dense_summary}`);
        }

    } catch (e) {
        console.error("测试出错:", e);
    }
}

testMemoryManager();