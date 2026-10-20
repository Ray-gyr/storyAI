"""
基准测试 · 生成质量检查：场景有没有按章切换、叙述是否陷入无休止的危机、事件触发是否生效。

  - 每章：当前地点（世界状态 current_location）与该章设定地点的匹配比例
  - 叙述最后一段含危机词的比例（第一版写作 prompt 的 300 回合开发故事为 72%）
  - 每个事件触发回合：玩家行动与叙述开头，供人工核对

运行：python scripts/eval/benchmark/check_story.py <out 子目录，如 smoke-dev / dev>
"""
import json
import re
import sys
from collections import Counter
from pathlib import Path

DIR = Path(__file__).resolve().parent / "out" / sys.argv[1]
rounds = [json.loads(line) for line in (DIR / "rounds.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
transcript = json.loads((DIR / "transcript.json").read_text(encoding="utf-8")) if (DIR / "transcript.json").exists() else None

STOP = {"the", "a", "an", "of", "to", "at", "in", "on", "s", "and", "now", "after", "back", "forced", "detour", "open", "hidden"}
CRISIS = re.compile(r"(danger|threat|alarm|bleed|blood|breach|hiss|suffocat|oxygen|drift|grip|slip|lose|fail|crack|tear|rip|scream|lunge|crossbow|gun|fire|close[sd]? in|pain|warning|critical|ambush|arrow|blade|sword)", re.I)


def keywords(text):
    return {w for w in re.findall(r"[a-z0-9]+", (text or "").lower()) if w not in STOP and len(w) > 2}


chapters = sorted({r["chapter"] for r in rounds})
spec_locations = {}
for r in rounds:
    if r["scripted"] and r["round_in_chapter"] == 1:
        m = re.search(r"travel to (.+?) to |head for (.+?) to ", r["action"])
        if m:
            spec_locations[r["chapter"]] = m.group(1) or m.group(2)

print(f"{DIR.name}: {len(rounds)} rounds, {len(chapters)} chapters\n")
print("location match per chapter (rounds whose current_location shares a keyword with the chapter location):")
total_match = 0
for ch in chapters:
    rs = [r for r in rounds if r["chapter"] == ch]
    target = keywords(spec_locations.get(ch, ""))
    match = sum(bool(target & keywords(r["location"])) for r in rs)
    total_match += match
    top = Counter(r["location"] for r in rs).most_common(2)
    print(f"  ch{ch:<3}{match}/{len(rs)}  target: {spec_locations.get(ch, '?')[:40]:<40} top: {' / '.join(f'{l} x{n}' for l, n in top)}")
print(f"  overall: {total_match}/{len(rounds)} = {total_match / len(rounds):.0%}")

if transcript:
    narr = [t["text"] for t in transcript if t["role"] == "assistant"]
    crisis = sum(bool(CRISIS.search(t.strip().split("\n")[-1])) for t in narr)
    print(f"\nnarrator turns ending with crisis wording: {crisis}/{len(narr)} = {crisis / len(narr):.0%}  (first-version dev story: 72%)")

print("\nscripted event-trigger rounds (action -> narration start):")
by_round = {}
if transcript:
    for i in range(1, len(transcript), 2):
        by_round[(i + 1) // 2] = transcript[i + 1]["text"] if i + 1 < len(transcript) else ""
for r in rounds:
    if r["scripted"] and r["round_in_chapter"] != 1:
        print(f"  [r{r['round']}] {r['action']}\n      -> {by_round.get(r['round'], '')[:220].replace(chr(10), ' ')}")
