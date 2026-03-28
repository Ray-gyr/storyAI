import { z } from "zod";

// ==========================================
// 核心状态的统一类型定义 (Current State)
// ==========================================

export const EntityInfoSchema = z.object({
    name: z.string().describe("Entity name, keep it short and unique."),
    description: z.string().describe("Short introduction and core setting for this character/location/item."),
});

export const AttributeSchema = z.object({
    name: z.string().describe("Attribute name, e.g., 'HP', 'Sanity', 'PROTAGONIST_HALO', 'Credits'."),
    value: z.union([z.number(), z.string()]).describe("Current state of the attribute. Use a number if it's numeric (e.g., 100) or text if it's a state description (e.g., 'Extremely Exhausted')."),
    type: z.enum(["numeric", "text"]).describe("Strictly mark the type: 'numeric' for values, 'text' for descriptions.")
});

export const StoryStateSchema = z.object({
    // -------------------------
    // 0. World Bible (Immutable Foundation)
    // -------------------------
    world_bible: z.object({
        story_framework: z.string().describe("The overall framework, core conflicts, and main narrative threads of the story."),
        world_mechanics: z.string().describe("The underlying operational logic of the world, such as power systems, resource rules, and physical laws."),
        narrative_style: z.string().describe("Writing style and narrative constraints, e.g., 'Cold and realistic, crisp and clean', 'Unfathomable cosmic horror', etc.")
    }).describe("The cornerstone of the game's worldview, extracted from initial settings and remaining as the permanent highest directive."),

    // -------------------------
    // 1. 全局已知实体 (Entities) - 充当全局注册表
    // -------------------------
    known_characters: z.array(EntityInfoSchema).describe("List of known characters and their settings (must include the protagonist)."),
    known_locations: z.array(EntityInfoSchema).describe("List of known locations and their settings."),
    known_items: z.array(EntityInfoSchema).describe("List of important items and their settings (must include all items in inventory)."),

    // -------------------------
    // 2. Current Environment and Task
    // -------------------------
    current_location: z.string().describe("Current specific location of the protagonist (Must match an entity in known_locations)."),
    current_task: z.string().describe("Current core objective or ongoing task."),

    // -------------------------
    // 3. 玩家自身状态
    // -------------------------
    inventory: z.array(z.string()).describe("List of specific items currently owned by the player (Must match names in known_items for alignment)."),

    // -------------------------
    // 4. Exclusive Adapter Settings
    // -------------------------
    custom_attributes: z.array(AttributeSchema)
        .describe("Exclusive numeric or status settings based on the story genre (Sci-Fi/Fantasy/etc.). Design 3-5 attributes that reflect the genre's flavor. Hardcore genres prioritize numeric; plot/adventure genres prioritize text.")
});

export type EntityInfo = z.infer<typeof EntityInfoSchema>;
export type StoryState = z.infer<typeof StoryStateSchema>;

// ==========================================
// 5. 状态增量更新 (State Mutator Diff)
// ==========================================

export const StateChangeSchema = z.object({
    added_characters: z.array(EntityInfoSchema).describe("Extract characters only when [NEW] ones appear. Nameless entities/groups must also be recorded. Return [] if none."),
    added_locations: z.array(EntityInfoSchema).describe("Extract locations only when [NEW] ones appear. Return [] if none."),
    added_items: z.array(EntityInfoSchema).describe("Extract items only when [NEW] ones appear. Return [] if none."),

    updated_characters: z.array(EntityInfoSchema).describe("For existing characters, if their state or identity changes significantly, put name here and update description. Return [] if no change."),
    updated_locations: z.array(EntityInfoSchema).describe("For existing locations, if environment changes significantly, update name and description. Return [] if no change."),
    updated_items: z.array(EntityInfoSchema).describe("For existing items, if nature changes significantly, update name and description. Return [] if no change."),

    new_current_location: z.string().describe("If protagonist moves to a new location, enter the name (must match a registered entity); otherwise, return empty string ''."),
    new_current_task: z.string().describe("If the task changes, enter the new task; otherwise, return empty string ''."),

    inventory_added: z.array(z.string()).describe("Names of newly acquired items (must match known_items or added_items). Leave empty [] if none."),
    inventory_removed: z.array(z.string()).describe("Names of items lost, consumed, or discarded. Return empty [] if none."),

    custom_attributes_changes: z.array(z.object({
        name: z.string().describe("Name of the changing attribute (must match existing names exactly)."),
        new_value: z.union([z.number(), z.string()]).describe("The latest value after change (actual value, not the increment/decrement).")
    })).describe("Patch for numeric or status changes caused by story progress. Leave empty [] if none."),

    state_summary: z.string().describe("Brief summary of what happened that caused this state update.")
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