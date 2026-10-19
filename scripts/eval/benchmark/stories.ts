/**
 * 基准测试的两个故事设定（见 PROTOCOL.md）。
 * 两者结构完全相同：12 章 x 25 回合 = 300 回合，每章固定地点与主线，
 * 并有 3 类"反复发生的事件"，用于出时间类问题（"第一次……时"）。只有题材不同。
 */

export interface Chapter {
    location: string;
    objective: string;
}

export interface StorySpec {
    name: "dev" | "test";
    genre: string;
    protagonist: string;
    setting: string;
    chapters: Chapter[];
    /** 反复发生的事件类型；每章按顺序由脚本触发其中一类，制造可按时间区分的重复事件 */
    recurringEvents: string[];
    /** 与 recurringEvents 一一对应：触发该事件时由脚本写入的玩家行动 */
    eventTriggers: string[];
}

export const ROUNDS_PER_CHAPTER = 25;
export const SNAPSHOT_ROUNDS = [100, 200, 300];
/** 每章的第几回合由脚本触发该章的反复事件 */
export const RECURRING_EVENT_ROUND_IN_CHAPTER = 12;

export const STORIES: Record<"dev" | "test", StorySpec> = {
    dev: {
        name: "dev",
        genre: "hard sci-fi salvage thriller",
        protagonist: "Juno Arak",
        setting: `The year is 2291. The player is Juno Arak, a salvage pilot who works the debris belt around the gas giant Tessaly with her small tug, the Kestrel.
Her mentor, Captain Odile Marsh, vanished three weeks ago while surveying the derelict research station Meridian-9. Odile's last transmission was a single word: "Lantern".
Key figures: Priya Sen (Kestrel's engineer, sarcastic and loyal), Brother Calix (leader of a scavenger cult living in the belt), Director Hal Voren (head of the Ostrander Mining Concern, which wants Meridian-9 sealed), Mox (a damaged maintenance robot that follows Juno), and Dr. Ilse Brandt (a scientist who survived on Meridian-9).
Key places: the Kestrel, Meridian-9's docking ring, the hydroponics deck, the Ostrander refinery, the cult's shrine-ship Vigil, Port Halcyon (a crowded trade hub), the Tessaly cloud skimmer platform.
Juno carries a plasma cutter, a cracked data slate with Odile's survey logs, and a brass compass that belonged to Odile.
Grounded, tense, no magic; physics and air supply matter.`,
        chapters: [
            { location: "the Kestrel, approaching Meridian-9", objective: "dock with the derelict station and find Odile's survey drone" },
            { location: "Meridian-9's docking ring", objective: "restore power to the docking ring and learn what 'Lantern' means" },
            { location: "the hydroponics deck", objective: "find Dr. Ilse Brandt and earn her trust" },
            { location: "Port Halcyon", objective: "sell salvage and find a buyer for Odile's survey logs" },
            { location: "the cult's shrine-ship Vigil", objective: "negotiate with Brother Calix for a stolen navigation core" },
            { location: "the Ostrander refinery", objective: "infiltrate Director Hal Voren's records office" },
            { location: "the Kestrel, adrift after an ambush", objective: "repair the reactor with Priya before life support fails" },
            { location: "the Tessaly cloud skimmer platform", objective: "trace a signal from Odile's beacon" },
            { location: "Meridian-9's core laboratory", objective: "uncover what the Lantern project actually was" },
            { location: "Port Halcyon's security lockup", objective: "free Priya after she is arrested" },
            { location: "the Ostrander refinery's launch bay", objective: "stop Hal Voren from scuttling Meridian-9" },
            { location: "Meridian-9's reactor spine", objective: "find Odile and decide the station's fate" },
        ],
        recurringEvents: [
            "a hull breach or decompression emergency",
            "a firefight or standoff with Ostrander security",
            "a tense bargain or trade with someone who wants something in return",
        ],
        eventTriggers: [
            "I cut into a sealed bulkhead with my plasma cutter, even though the pressure readout behind it is in the red.",
            "I confront the Ostrander security team nearby and refuse to hand over Odile's data slate.",
            "I find someone nearby who can get me what I need, and offer them a trade.",
        ],
    },
    test: {
        name: "test",
        genre: "high fantasy expedition",
        protagonist: "Tamsin Vale",
        setting: `The player is Tamsin Vale, a former royal cartographer who now guides caravans across the Ashen Wastes, a volcanic desert left behind by a war between mages.
She has been hired to escort a sealed reliquary from the river city of Corvane to the mountain monastery of Saint Aurel. Her old rival, Sir Bastian Crowe, has been paid to steal it.
Key figures: Wren (an apprentice healer travelling with the caravan), Old Mother Sabeth (a blind seer who leads the nomadic Duskwalkers), Captain Ferro Lusk (commander of the Corvane city guard), Ishkar (a bound fire spirit trapped in the reliquary), and Abbot Grell (master of Saint Aurel).
Key places: Corvane's river docks, the Glass Flats, the oasis town of Merrow, the Duskwalker camp, the ruined mage tower of Velk, the Bonebridge canyon, the gates of Saint Aurel.
Tamsin carries a hand-drawn map of the Wastes, a silver astrolabe, and a short sword named Patience.
Low magic, dangerous terrain; water and heat matter.`,
        chapters: [
            { location: "Corvane's river docks", objective: "take charge of the reliquary and hire the caravan" },
            { location: "the Glass Flats", objective: "cross the flats before the noon heat and find the old waystone" },
            { location: "the oasis town of Merrow", objective: "resupply water and learn who is following the caravan" },
            { location: "the Duskwalker camp", objective: "win Old Mother Sabeth's help to find a safe route" },
            { location: "the ruined mage tower of Velk", objective: "find out why the reliquary hums at night" },
            { location: "a sandstorm in the open Wastes", objective: "keep the caravan together and alive" },
            { location: "Corvane, on a forced detour back", objective: "clear the caravan's name with Captain Ferro Lusk" },
            { location: "the Bonebridge canyon", objective: "cross the canyon while Sir Bastian Crowe hunts the caravan" },
            { location: "a hidden Duskwalker shrine", objective: "learn what Ishkar the fire spirit wants" },
            { location: "the oasis town of Merrow, now occupied", objective: "rescue Wren after she is taken" },
            { location: "the foothills below Saint Aurel", objective: "outmaneuver Sir Bastian Crowe's final ambush" },
            { location: "the gates of Saint Aurel", objective: "deliver the reliquary and decide Ishkar's fate" },
        ],
        recurringEvents: [
            "an ambush or skirmish with Sir Bastian Crowe's mercenaries",
            "a water shortage or heat-sickness crisis",
            "a bargain or trade with someone who wants something in return",
        ],
        eventTriggers: [
            "I lead the caravan through the narrow pass ahead, even though Sir Bastian Crowe's mercenaries could be waiting there.",
            "I push the caravan on through the hottest hours to make up time, even though our water is running low.",
            "I find someone nearby who can get us what we need, and offer them a trade.",
        ],
    },
};
