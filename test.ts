import { extractAndStoreMemory } from "./src/lib/memory";
import { StoryState } from "./src/lib/currentState";
import * as dotenv from "dotenv";

// 加载 .env 环境变量
dotenv.config();

async function testMemory() {
    console.log("🚀 启动 Memory Extractor 测试...\n");

    try {
        const mockState: StoryState = {
            known_characters: [
                { name: "弧光", description: "曾经是集团高管的黑客拾荒者" },
                { name: "老鼠", description: "情报贩子" }
            ],
            known_locations: [
                { name: "霓虹裂谷", description: "奥尔法-9上的地下黑市" }
            ],
            known_items: [
                { name: "电磁手枪", description: "快没电的防身武器" },
                { name: "黑客终端", description: "旧式便携黑客终端" },
                { name: "船票", description: "回核心星区的通行证" },
                { name: "闪存盘", description: "用于存储数据" }
            ],
            current_location: "霓虹裂谷",
            current_task: "找到黑市里一个叫“老鼠”的情报贩子，买一张回核心星区的船票。",
            inventory: ["电磁手枪", "黑客终端"],
            custom_attributes: [
                { name: "信用点", value: 50, type: "numeric" }
            ]
        };

        const mockStoryText = "弧光在霓虹裂谷的深虚小巷里终于堵到了老鼠。老鼠哆嗦着交出一个闪存盘，并要求500信用点。弧光没有废话，直接把快没电的电磁手枪抵在老鼠的额头，一把抢走了闪存盘。她将闪存盘接入黑客终端快速扫描，发现里面不仅有她需要的船票密钥，甚至还有一份集团总部的绝密资金流向图。老鼠趁她查看时吓得落荒而逃。弧光眼疾手快一发电磁手枪杀了他";

        console.log("==== [测试剧情片段] ====\n", mockStoryText);
        console.log("\n⏳ 正在请求 Manager LLM 提取记忆片段并生成 MemoryRecord...\n");

        const startTurn = 1;
        const endTurn = 1;

        const memoryRecord = await extractAndStoreMemory(
            mockState,
            mockStoryText,
            startTurn,
            endTurn
        );

        console.log("✅ 测试成功！成功生成记忆记录：");
        console.log("--------------------------------------------------");
        console.log(JSON.stringify(memoryRecord, null, 2));
        console.log("--------------------------------------------------");

    } catch (error) {
        console.error("❌ 测试失败，请查看报错信息：");
        console.error(error);
    }
}

testMemory();