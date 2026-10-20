'use client';

import { useEffect, useState } from 'react';

/** 等待叙述者回复时轮流显示的提示语（与题材无关，科幻、奇幻、末日等故事都适用） */
const MESSAGES = [
    'The world is unfolding...',
    'Ink is finding its way onto the page...',
    'The narrator leans in to listen...',
    'Somewhere, a door creaks open...',
    'Footsteps echo down unseen halls...',
    'The threads of fate are tightening...',
    'Old memories stir in the dark...',
    'The map is redrawing itself...',
    'Distant voices begin to murmur...',
    'The dice are still rolling...',
    'A candle flickers as the story leans closer...',
    'Consequences are taking shape...',
    'The next page is turning...',
    'Shadows shift at the edge of the scene...',
    'The world remembers what you did...',
    'Rumors travel faster than you...',
    'The wind carries news from afar...',
    'Someone, somewhere, has noticed you...',
    'The chronicle adds another line...',
    'Fate weighs your choice...',
];

const INTERVAL_MS = 2500;

/** 从随机一条开始，每 INTERVAL_MS 换下一条 */
export default function UnfoldingMessage() {
    const [index, setIndex] = useState(() => Math.floor(Math.random() * MESSAGES.length));

    useEffect(() => {
        const timer = setInterval(() => setIndex(i => (i + 1) % MESSAGES.length), INTERVAL_MS);
        return () => clearInterval(timer);
    }, []);

    return (
        <span className="text-[#8D7B68] italic tracking-widest text-sm sm:text-base animate-pulse block" style={{ textIndent: 0 }}>
            {MESSAGES[index]}
        </span>
    );
}
