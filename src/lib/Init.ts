import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { Pinecone } from "@pinecone-database/pinecone";
import "dotenv/config";

// 这是一个工厂函数，或者配置导出，可以用来集中管理模型实例化
export const getManagerLLM = () => {
    return new ChatOpenAI({
        modelName: "gpt-4o-mini",
        openAIApiKey: process.env.OPENAI_API_KEY,
        temperature: 0, // Manager 需要精确提取，温度设为0
    });
};

// export const getStoryLLM = (customKey?: string) => {
//     const primaryModel = new ChatOpenAI({
//         modelName: "Qwen/Qwen2.5-14B-Instruct", // 使用 14B 作为主模型
//         frequencyPenalty: 0.6,
//         presencePenalty: 0.5,
//         openAIApiKey: customKey || process.env.HUGGINGFACE_API_KEY,
//         configuration: {
//             baseURL: "https://router.huggingface.co/v1", // Hugging Face 的 OpenAI 兼容端点
//             defaultHeaders: {
//                 Authorization: `Bearer ${customKey || process.env.HUGGINGFACE_API_KEY}`,
//             },
//         },
//         temperature: 0.6,
//     });

//     const fallbackModel = new ChatOpenAI({
//         modelName: "Qwen/Qwen2.5-7B-Instruct", // 使用 7B 作为降级备用模型
//         frequencyPenalty: 0.6,
//         presencePenalty: 0.5,
//         openAIApiKey: customKey || process.env.HUGGINGFACE_API_KEY,
//         configuration: {
//             baseURL: "https://router.huggingface.co/v1",
//             defaultHeaders: {
//                 Authorization: `Bearer ${customKey || process.env.HUGGINGFACE_API_KEY}`,
//             },
//         },
//         temperature: 0.6,
//     });

//     // 返回带有回退逻辑的 Runnable，遇到 429/500/容量耗尽等异常自动切换 7B，并且每次执行仍会先尝试 14B
//     return primaryModel.withFallbacks({
//         fallbacks: [fallbackModel]
//     });
// };

export const getStoryLLM = () => {
    return new ChatOpenAI({
        modelName: "gpt-5-mini",
        openAIApiKey: process.env.OPENAI_API_KEY,
        reasoning: {
            effort: "low"
        }
    });
};

export const getEmbeddings = () => {
    return new OpenAIEmbeddings({
        modelName: "text-embedding-3-small",
        openAIApiKey: process.env.OPENAI_API_KEY,
    });
};

export const getPineconeIndex = () => {
    if (!process.env.PINECONE_API_KEY) {
        throw new Error("Missing PINECONE_API_KEY in environment");
    }
    const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
    return pc.index("story-memory");
};

/**
 * 用于测试或重置环境：清空整个 story-memory 数据库的所有记录
 */
export const clearPineconeIndex = async (sessionId?: string) => {
    console.log("[VectorDB] ⚠️ 警告：Pinecone Serverless 免费版/无服务器索引底层受限，原生不支持 API 级的 deleteAll()。");
    console.log("[VectorDB] 📝 建议：在测试或实际新开故事时，直接生成使用全新的 sessionId 作为 Namespace 即可实现纯天然物理隔离。");
};
