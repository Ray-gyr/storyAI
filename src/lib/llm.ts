import { ChatOpenAI } from "@langchain/openai";
import "dotenv/config";

// 这是一个工厂函数，或者配置导出，可以用来集中管理模型实例化
export const getManagerLLM = () => {
    return new ChatOpenAI({
        modelName: "gpt-4o-mini",
        openAIApiKey: process.env.OPENAI_API_KEY,
        temperature: 0, // Manager 需要精确提取，温度设为0
    });
};

export const getStoryLLM = (customKey?: string) => {
    return new ChatOpenAI({
        modelName: "Qwen/Qwen2.5-14B-Instruct:featherless-ai", // 必须是没有前缀后缀的干净 Hugging Face 模型 ID
        openAIApiKey: customKey || process.env.HUGGINGFACE_API_KEY,
        configuration: {
            baseURL: "https://router.huggingface.co/v1", // Hugging Face 的 OpenAI 兼容端点
            defaultHeaders: {
                Authorization: `Bearer ${customKey || process.env.HUGGINGFACE_API_KEY}`,
            },
        },
        temperature: 0.8,
    });
};


