# Story dataset: dev

A hard sci-fi salvage thriller played for 300 rounds by an auto-player LLM through the Story AI pipeline. Generated for the long-story retrieval benchmark; see `scripts/eval/benchmark/PROTOCOL.md`.

- Protagonist: Juno Arak
- Structure: 12 chapters x 25 rounds; every chapter moves to a new location and objective.
- Recurring events (one is deliberately triggered per chapter): a hull breach or decompression emergency; a firefight or standoff with Ostrander security; a tense bargain or trade with someone who wants something in return.
- Turns: 601; memory chunks: 130; snapshots after rounds 100, 200, 300.
- Exported at commit `6761961`.

## Files

| File | Content |
|---|---|
| `story.md` | The full story, by chapter and round |
| `transcript.jsonl` | One turn per line: `turn_id`, `role` (user = player, assistant = narrator), `text` |
| `chunks.jsonl` | One memory chunk per line: turn range, creation time, the LLM summary used for retrieval, the original narration (`content`), entities, and recurring-event tags |
| `snapshots.jsonl` | The chunks that existed after rounds 100, 200, 300 |
| `questions.jsonl` | Recall questions (detail / vague / temporal) with the expected answer, source chunk, validity, whether the source summary contains the answer, and the acceptable chunks at each snapshot |

## Setting

The year is 2291. The player is Juno Arak, a salvage pilot who works the debris belt around the gas giant Tessaly with her small tug, the Kestrel.
Her mentor, Captain Odile Marsh, vanished three weeks ago while surveying the derelict research station Meridian-9. Odile's last transmission was a single word: "Lantern".
Key figures: Priya Sen (Kestrel's engineer, sarcastic and loyal), Brother Calix (leader of a scavenger cult living in the belt), Director Hal Voren (head of the Ostrander Mining Concern, which wants Meridian-9 sealed), Mox (a damaged maintenance robot that follows Juno), and Dr. Ilse Brandt (a scientist who survived on Meridian-9).
Key places: the Kestrel, Meridian-9's docking ring, the hydroponics deck, the Ostrander refinery, the cult's shrine-ship Vigil, Port Halcyon (a crowded trade hub), the Tessaly cloud skimmer platform.
Juno carries a plasma cutter, a cracked data slate with Odile's survey logs, and a brass compass that belonged to Odile.
Grounded, tense, no magic; physics and air supply matter.

## Chapters

1. **the Kestrel, approaching Meridian-9**: dock with the derelict station and find Odile's survey drone
2. **Meridian-9's docking ring**: restore power to the docking ring and learn what 'Lantern' means
3. **the hydroponics deck**: find Dr. Ilse Brandt and earn her trust
4. **Port Halcyon**: sell salvage and find a buyer for Odile's survey logs
5. **the cult's shrine-ship Vigil**: negotiate with Brother Calix for a stolen navigation core
6. **the Ostrander refinery**: infiltrate Director Hal Voren's records office
7. **the Kestrel, adrift after an ambush**: repair the reactor with Priya before life support fails
8. **the Tessaly cloud skimmer platform**: trace a signal from Odile's beacon
9. **Meridian-9's core laboratory**: uncover what the Lantern project actually was
10. **Port Halcyon's security lockup**: free Priya after she is arrested
11. **the Ostrander refinery's launch bay**: stop Hal Voren from scuttling Meridian-9
12. **Meridian-9's reactor spine**: find Odile and decide the station's fate
