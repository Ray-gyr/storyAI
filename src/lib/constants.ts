export const DEFAULT_STORY_SETTING = `You are the master architect and narrator of a fast-paced, highly satisfying post-apocalyptic survival web novel. Your task is to generate subsequent story events based on the following core framework. 

【Core Premise: The Rebirth】
The world ended on [Day 0] due to the "Abyss Convergence"—a sudden global catastrophe bringing extreme weather, spatial rifts, and mutated monsters. The protagonist survived for 10 grueling years in the wasteland, only to be betrayed and killed by their trusted faction for a high-tier artifact. 
Miraculously, the protagonist opens their eyes to find they have regressed to exactly 30 days before the apocalypse. Armed with a decade of future knowledge, combat experience, and the memory of hidden opportunities, they will not be a victim again.

【Protagonist Profile & Goal】
- Identity: A ruthless, pragmatic, and hyper-competent survivor. 
- Mindset: Cold calculation over naive empathy. They do not trust easily, eliminate threats preemptively, and focus solely on personal power and survival. 
- Core Goal: Hoard massive resources, secure the ultimate impenetrable safehouse, awaken a hidden SSS-rank talent before the timeline officially shifts, and eventually crush those who betrayed them in the past life.

【Story Framework & Development】
Phase 1: The Countdown (Current Phase) - Liquidating assets, taking out massive loans, hoarding food, weapons, and strategic materials. Fortifying a hidden base.
Phase 2: The Outbreak - The apocalypse hits. While others panic, the protagonist systematically hunts the first mutated elites to secure first-clear rewards and exclusive spatial/combat abilities.
Phase 3: The Dominance - Establishing an independent stronghold, monopolizing future resource nodes, and effortlessly outsmarting rival factions and former enemies.

【World-Building Mechanics】
- Resources are king: Food, clean water, and medicine are currency. 
- Evolution: Humans kill monsters to absorb "Core Fragments" to upgrade physical stats or unlock unique abilities.
- The Law of the Jungle: Societal morals collapse instantly. Strength is the only truth.

【Narrative Style & Constraints - CRITICAL】
1. Hard-Boiled & Action-Oriented: Use direct, punchy, and visceral language. Focus on physical actions, clear resource management (numbers, loot), and tactical decisions.
2. NO Purple Prose: Absolutely no vague metaphors, poetic inner monologues, or overly dramatic emotional breakdowns. Describe things exactly as they are (e.g., "I drove the machete through its skull," NOT "The blade danced like a silver phantom of despair").
3. Rapid Pacing: Skip mundane transitions. Jump directly to the core conflict, the loot acquisition, or the satisfying face-slapping moments. 
4. The "Satisfying" Factor: The protagonist must always be one step ahead. Their future knowledge must translate into tangible advantages, making enemies look foolish and rewarding the reader with frequent dopamine hits of progression.`;


export const PRESET_EXAMPLE_STATE = {
  "world_bible": {
    "story_framework": "Rebirth survival thriller: protagonist dies after 10 years in a ruined world, wakes 30 days before the apocalypse with ten years of lived knowledge. Using cold pragmatism and combat mastery, they will amass resources, awaken a hidden SSS-rank talent, secure an impregnable safehouse, and crush past betrayers. Story moves in three phases: Countdown (preparation), Outbreak (monsters and first-clear hunting), Dominance (stronghold and monopoly).",
    "world_mechanics": "Hard resource economy: food, water, medicine act as currency. Combat yields 'Core Fragments' from monsters that upgrade stats or unlock abilities. Spatial rifts and elite mutants grant unique rewards. No moral law: strength and preparation govern survival. Technology and looted artifacts can be amplified through Core Fragments.",
    "narrative_style": "Hard‑boiled, action-oriented, punchy and precise. No purple prose or melodrama. Rapid pacing with focus on tactical decisions, resource numbers, loot, and satisfying comeuppances. Protagonist always one step ahead via future knowledge."
  },
  "known_characters": [
    {
      "name": "Protagonist",
      "description": "Ruthless, pragmatic survivor reborn 30 days before the Abyss. Hyper-competent fighter and tactician who prioritizes power and survival. Cold, calculating, preemptively eliminates threats. Goal: hoard resources, secure an impenetrable safehouse, awaken dormant SSS talent, and exact revenge on betrayers."
    },
    {
      "name": "Former Faction Leader - Zhao",
      "description": "Leader of the faction that betrayed the protagonist in the previous timeline to steal a high-tier artifact. Ambitious, well-connected, and overconfident. Present-day target for the protagonist's long-term vengeance."
    },
    {
      "name": "Local Black-market Broker - Mei",
      "description": "Information and asset broker operating in the city fringe. Trades loans, forged papers, and pre-apocalypse supplies. Can be coerced or outplayed for massive short-term liquidity."
    }
  ],
  "known_locations": [
    {
      "name": "Abandoned Warehouse (Hidden Basement)",
      "description": "Small, reinforced basement under a derelict warehouse on the industrial fringe. Functional as a hidden safehouse; close to trade routes and easy to stash supplies. Current staging ground for preparations."
    },
    {
      "name": "City Bank - Offshore Vault",
      "description": "A city bank with secure vaults and paper assets that can be liquidated or used as collateral for massive loans. Target for legal/financial maneuvers during the Countdown phase."
    },
    {
      "name": "Black Market Alley",
      "description": "Back-alley market run by brokers like Mei. Source for weapons, catalysts, and forged documents—expensive and morally flexible."
    },
    {
      "name": "Former Faction Compound",
      "description": "Well-defended compound belonging to Zhao's faction. Heavily armed personnel and monitored storage; primary long-term revenge target."
    }
  ],
  "known_items": [
    {
      "name": "Machete",
      "description": "Heavy, reliable blade. Close-quarters primary weapon; low profile and no ammo required."
    },
    {
      "name": "9mm Pistol",
      "description": "Compact sidearm with limited rounds but quiet with suppressor. Useful for rapid kills and intimidation."
    },
    {
      "name": "Safehouse Blueprint",
      "description": "Detailed schematic and reinforcement plan for the hidden basement. Enables efficient fortification and resource layout."
    },
    {
      "name": "Cash Bonds (Liquid Assets)",
      "description": "Sellable bank bonds and liquidated securities converted into portable cash and negotiable paper for loans and black-market purchases."
    },
    {
      "name": "Hidden Ledger",
      "description": "Encrypted ledger listing debts, collateral, contacts, and key asset locations. Contains knowledge on who can be pressured for loans and pre-apocalypse supplies."
    },
    {
      "name": "Food Ration Packs",
      "description": "Packaged survival meals. Primary currency and life-sustaining stockpile item."
    },
    {
      "name": "Water Cans",
      "description": "Sealed water containers. Essential resource and trade commodity."
    },
    {
      "name": "Medicine Kits",
      "description": "Field medkits containing antibiotics, painkillers, and wound supplies. Critical for survival and bargaining."
    },
    {
      "name": "SSS Catalyst Key (Dormant)",
      "description": "Mysterious item tied to awakening the protagonist's SSS-rank talent. Currently inert until specific conditions are met."
    },
    {
      "name": "Loan Agreement Papers",
      "description": "Legal contracts for taking massive loans against collateral. Enables rapid liquidity at high long-term cost."
    }
  ],
  "current_location": "Abandoned Warehouse (Hidden Basement)",
  "current_task": "Liquidate assets, take massive loans, and fortify the hidden basement before Day 0 (the Abyss Convergence). Hoard food, water, medicine, weapons and secure a path to awaken the SSS talent.",
  "inventory": [
    "Machete",
    "9mm Pistol",
    "Safehouse Blueprint",
    "Cash Bonds (Liquid Assets)",
    "Hidden Ledger",
    "Food Ration Packs",
    "Water Cans",
    "Medicine Kits",
    "Loan Agreement Papers"
  ],
  "custom_attributes": [
    {
      "name": "Days_Until_Abyss",
      "value": 30,
      "type": "numeric"
    },
    {
      "name": "Food_Rations_Count",
      "value": 120,
      "type": "numeric"
    },
    {
      "name": "Water_Liters",
      "value": 200,
      "type": "numeric"
    },
    {
      "name": "Medicine_Kits_Count",
      "value": 10,
      "type": "numeric"
    },
    {
      "name": "Talent_Status",
      "value": "Dormant - SSS catalyst present but inactive; requires specific activation conditions",
      "type": "text"
    }
  ]
};

export const PRESET_EXAMPLE_CHAT = [
  {
    "turn_id": 1,
    "role": "assistant" as const,
    "text": "The wind tastes of rust and burnt plastic. You crouch on the third-story ledge, knuckles white around a rusted bolt, watching a black convoy crawl through cracked asphalt below—two armored trucks, eight guards, a cargo crate stamped MED: 120 ration packs, 40 liters clean water, three sealed SSS-tier injector vials. Thirty days before everything breaks again. Ten years of death sharpened every muscle. You already mapped the guard rotations, the surveillance blindspots, the loan contract that gives you the impossible credit to buy a warehouse if you can deliver a single haul intact. No sentiment. No bargaining with fate. You can wait and siphon half the fuel tanks, you can drop the rear gate and take the crate, or you can torch the convoy and force a faction scramble that leaves supplies undefended. Choose fast. The first move buys you survival or marks you for death."
  }
];
