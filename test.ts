import { getStoryLLM } from "./src/lib/llm";
import * as dotenv from "dotenv";

// 加载 .env 环境变量
dotenv.config();

async function testStoryLLM() {
    console.log("🚀 启动 Story LLM (Hugging Face via OpenAI SDK) 测试...\n");

    try {
        // 1. 实例化刚刚修好的模型
        const storyLLM = getStoryLLM();

        // 2. 准备一个简短的提示词
        const prompt = "请用中文描述一条刚从沉睡中苏醒的巨龙。";

        console.log(`[发送 Prompt]: ${prompt}`);
        console.log("⏳ 正在请求 Hugging Face 接口，请稍候 (如果遇到冷启动可能需要等待十几秒)...\n");

        // 3. 调用模型
        const response = await storyLLM.invoke(prompt);

        // 4. 打印结果
        console.log("✅ 测试成功！成功借道 OpenAI 接口调通了 Hugging Face 模型：");
        console.log("--------------------------------------------------");
        // ChatOpenAI 返回的是一个 AIMessage 对象，真实的文本在 content 属性里
        console.log(response.content);
        console.log("--------------------------------------------------");

    } catch (error) {
        console.error("❌ 测试失败，请查看报错信息：");
        console.error(error);
    }
}

testStoryLLM();