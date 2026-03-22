import { MemoryManager } from "./memoryManager";
import { StoryState } from "./currentState";

export interface SessionData {
    memoryManager: MemoryManager;
    currentState: StoryState;
}

// 使用 globalThis 防止 Next.js 开发环境下热更新 (Fast Refresh) 导致模块缓存被清空而丢失数据
const _global = globalThis as any;
if (!_global.sessionsMap) {
    _global.sessionsMap = new Map<string, SessionData>();
}
const sessions: Map<string, SessionData> = _global.sessionsMap;

export function getSession(sessionId: string): SessionData | undefined {
    return sessions.get(sessionId);
}

/**
 * 开新局：构建一把全新的主角光环和世界设定
 */
export function createSession(sessionId: string): SessionData {
    const memoryManager = new MemoryManager();
    const currentState: StoryState = {
        known_characters: [
            { name: "亚力克", description: "一名游侠，主角，正试图解开无冬森林的诅咒" },
            { name: "守灵长老", description: "指引主角前来此地解除诅咒的神秘老人" }
        ],
        known_locations: [
            { name: "无冬森林", description: "雾气弥漫的远古森林入口，散发着潮湿和腐烂的气味。左边是长满荆棘的泥泞小径，右边是断裂的精灵石阶。" }
        ],
        known_items: [
            { name: "铁锈宽刃剑", description: "一把满是铁锈的宽刃剑，主角随身携带的唯一防身武器" }
        ],
        current_location: "无冬森林",
        current_task: "寻找森林腹地的古代石碑",
        inventory: ["铁锈宽刃剑"],
        custom_attributes: [
            { name: "精神侵蚀度", value: 10, type: "numeric" },
            { name: "身体状态", value: "轻微疲惫", type: "text" }
        ]
    };

    const sessionData = { memoryManager, currentState };
    sessions.set(sessionId, sessionData);
    return sessionData;
}
