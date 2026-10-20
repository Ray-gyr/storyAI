import { Redis } from "@upstash/redis";

// 全局共享的 Upstash Redis 客户端（存档、完整对话记录、会话锁、记忆片段的 BM25 语料）
export const redis = Redis.fromEnv();
