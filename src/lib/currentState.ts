import { z } from "zod";

// ==========================================
// 核心状态的统一类型定义 (Current State)
// ==========================================

export const EntityInfoSchema = z.object({
    name: z.string().describe("实体名称，保持简短且唯一。"),
    description: z.string().describe("关于这个人物/地点/物品的简短介绍与核心设定。"),
});

export const AttributeSchema = z.object({
    name: z.string().describe("属性名称，如 'HP', '理智值', '主角光环', '信用点'。"),
    value: z.union([z.number(), z.string()]).describe("属性的当前状态。如果是数值就用数字(如 100)，如果是状态描述就用文本(如 '极度疲惫')。"),
    type: z.enum(["numeric", "text"]).describe("严格标记该属性的类型：'numeric' 代表数值类，'text' 代表文本描述类。")
});

export const StoryStateSchema = z.object({
    // -------------------------
    // 1. 全局已知实体 (Entities) - 充当全局注册表
    // -------------------------
    known_characters: z.array(EntityInfoSchema).describe("故事目前已知的角色名单及设定（必须包含主角自身）。"),
    known_locations: z.array(EntityInfoSchema).describe("故事目前已知的地点名单及设定。"),
    known_items: z.array(EntityInfoSchema).describe("故事设定或剧情中出现的重要物品名单及设定（必须包含背包里的所有物品）。"),

    // -------------------------
    // 2. 当前环境与任务
    // -------------------------
    current_location: z.string().describe("主角当前所处的具体地点名称（注意：名称必须与 known_locations 中的某个实体完全一致）。"),
    current_task: z.string().describe("主角当前的核心目标或正在进行的任务。"),

    // -------------------------
    // 3. 玩家自身状态
    // -------------------------
    inventory: z.array(z.string()).describe("玩家（主角）当前拥有的具体物品/道具清单。（注意：这里的名称必须与 known_items 中的实体名称完全一致，实现实体对齐！）"),

    // -------------------------
    // 4. 专属可选扩展设定 (Adapter)
    // -------------------------
    custom_attributes: z.array(AttributeSchema)
        .describe("根据故事不同体裁（科幻/奇幻/同人/修仙等）生成的专属数值或状态设定。设计 3-5 个体现该类小说特色的属性。硬核类优先用 numeric，剧情/探险类优先用 text。")
});

export type EntityInfo = z.infer<typeof EntityInfoSchema>;
export type StoryState = z.infer<typeof StoryStateSchema>;

// ==========================================
// 5. 状态增量更新 (State Mutator Diff)
// ==========================================

export const StateChangeSchema = z.object({
    added_characters: z.array(EntityInfoSchema).describe("仅当剧情中出现了【全新的】、不在原 known_characters 中的角色时才提取到这里。注意：无名实体/实体集合也要记录，必须提取。若无新角色，必须返回 []。"),
    added_locations: z.array(EntityInfoSchema).describe("仅当剧情中出现了【全新的】、不在原 known_locations 中的地点时才提取到这里。若无，返回 []。"),
    added_items: z.array(EntityInfoSchema).describe("仅当出现了【全新的】、且主角获取或必需记录的物品时才提取到这里。若无，返回 []。"),

    updated_characters: z.array(EntityInfoSchema).default([]).describe("对于已存在于 known_characters 中的角色，如果其状态、身份发生了重大改变，将其名称放入并更新 description。若无改变，返回 []。"),
    updated_locations: z.array(EntityInfoSchema).default([]).describe("对于已存在于 known_locations 中的地点，如果其环境发生了重大改变（如被破坏），将其名称放入并更新 description。若无改变，返回 []。"),
    updated_items: z.array(EntityInfoSchema).default([]).describe("对于已存在于 known_items 中的物品，如果其状态、性质发生了重大改变，将其名称放入并更新 description。若无改变，返回 []。"),

    new_current_location: z.string().describe("如果主角移动到了新的地点，填入对应名称(需绝对匹配已注册实体)；如果未移动，必须返回空字符串 ''。"),
    new_current_task: z.string().describe("如果主角的任务发生了变化，填入新任务；如果任务仍是之前的且未突变，必须返回空字符串 ''。"),

    inventory_added: z.array(z.string()).describe("主角新获得的物品名称（必须绝对匹配 known_items 或 added_items 中的 name）。没有获得留空 []。"),
    inventory_removed: z.array(z.string()).describe("主角失去、消耗、丢弃的物品名称。若无，必须返回空数组 []。"),

    custom_attributes_changes: z.array(z.object({
        name: z.string().describe("发生变化的属性名称，如 'HP', '资金余额'等（必须绝对匹配已有的名称）"),
        new_value: z.union([z.number(), z.string()]).describe("变化后的最新值（注意不是增减数额，而是结算后的绝对于实际值）。")
    })).describe("故事进展导致的数值或状态的变化补丁。如果没有属性发生变化请留空数组 []。"),

    state_summary: z.string().describe("用一句话精简总结发生了什么导致本次状态更新。")
});

export type StateChange = z.infer<typeof StateChangeSchema>;

export function applyStateChanges(currentState: StoryState, changes: StateChange): StoryState {
    // 浅拷贝一层基础对象
    const newState: StoryState = { ...currentState };

    // 合并实体列表：存在则更新，不存在则追加
    const mergeEntities = (existing: EntityInfo[] = [], added: EntityInfo[] = []) => {
        const result = [...existing];
        added.forEach(newItem => {
            const idx = result.findIndex(e => e.name === newItem.name);
            if (idx >= 0) result[idx] = newItem;
            else result.push(newItem);
        });
        return result;
    };

    newState.known_characters = mergeEntities(newState.known_characters, changes.added_characters);
    newState.known_characters = mergeEntities(newState.known_characters, changes.updated_characters);

    newState.known_locations = mergeEntities(newState.known_locations, changes.added_locations);
    newState.known_locations = mergeEntities(newState.known_locations, changes.updated_locations);

    newState.known_items = mergeEntities(newState.known_items, changes.added_items);
    newState.known_items = mergeEntities(newState.known_items, changes.updated_items);

    if (changes.new_current_location !== "") {
        newState.current_location = changes.new_current_location;
    }
    if (changes.new_current_task !== "") {
        newState.current_task = changes.new_current_task;
    }

    // 更新背包
    let newInventory = [...(newState.inventory || [])];
    if (changes.inventory_added?.length > 0) {
        newInventory.push(...changes.inventory_added);
    }
    if (changes.inventory_removed?.length > 0) {
        newInventory = newInventory.filter(item => !changes.inventory_removed.includes(item));
    }
    // 简单一层去重防重复
    newState.inventory = Array.from(new Set(newInventory));

    // 更新自定义属性
    if (changes.custom_attributes_changes?.length > 0) {
        const newAttrs = [...(newState.custom_attributes || [])];
        changes.custom_attributes_changes.forEach(change => {
            const idx = newAttrs.findIndex(a => a.name === change.name);
            if (idx >= 0) {
                newAttrs[idx] = { ...newAttrs[idx], value: change.new_value };
            }
        });
        newState.custom_attributes = newAttrs;
    }

    return newState;
}