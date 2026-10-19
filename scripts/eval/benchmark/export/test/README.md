# Story dataset: test

A high fantasy expedition played for 300 rounds by an auto-player LLM through the Story AI pipeline. Generated for the long-story retrieval benchmark; see `scripts/eval/benchmark/PROTOCOL.md`.

- Protagonist: Tamsin Vale
- Structure: 12 chapters x 25 rounds; every chapter moves to a new location and objective.
- Recurring events (one is deliberately triggered per chapter): an ambush or skirmish with Sir Bastian Crowe's mercenaries; a water shortage or heat-sickness crisis; a bargain or trade with someone who wants something in return.
- Turns: 601; memory chunks: 130; snapshots after rounds 100, 200, 300.
- Exported at commit `9527f55`.

## Files

| File | Content |
|---|---|
| `story.md` | The full story, by chapter and round |
| `transcript.jsonl` | One turn per line: `turn_id`, `role` (user = player, assistant = narrator), `text` |
| `chunks.jsonl` | One memory chunk per line: turn range, creation time, the LLM summary used for retrieval, the original narration (`content`), entities, and recurring-event tags |
| `snapshots.jsonl` | The chunks that existed after rounds 100, 200, 300 |
| `questions.jsonl` | Recall questions (detail / vague / temporal) with the expected answer, source chunk, validity, whether the source summary contains the answer, and the acceptable chunks at each snapshot |

## Setting

The player is Tamsin Vale, a former royal cartographer who now guides caravans across the Ashen Wastes, a volcanic desert left behind by a war between mages.
She has been hired to escort a sealed reliquary from the river city of Corvane to the mountain monastery of Saint Aurel. Her old rival, Sir Bastian Crowe, has been paid to steal it.
Key figures: Wren (an apprentice healer travelling with the caravan), Old Mother Sabeth (a blind seer who leads the nomadic Duskwalkers), Captain Ferro Lusk (commander of the Corvane city guard), Ishkar (a bound fire spirit trapped in the reliquary), and Abbot Grell (master of Saint Aurel).
Key places: Corvane's river docks, the Glass Flats, the oasis town of Merrow, the Duskwalker camp, the ruined mage tower of Velk, the Bonebridge canyon, the gates of Saint Aurel.
Tamsin carries a hand-drawn map of the Wastes, a silver astrolabe, and a short sword named Patience.
Low magic, dangerous terrain; water and heat matter.

## Chapters

1. **Corvane's river docks**: take charge of the reliquary and hire the caravan
2. **the Glass Flats**: cross the flats before the noon heat and find the old waystone
3. **the oasis town of Merrow**: resupply water and learn who is following the caravan
4. **the Duskwalker camp**: win Old Mother Sabeth's help to find a safe route
5. **the ruined mage tower of Velk**: find out why the reliquary hums at night
6. **a sandstorm in the open Wastes**: keep the caravan together and alive
7. **Corvane, on a forced detour back**: clear the caravan's name with Captain Ferro Lusk
8. **the Bonebridge canyon**: cross the canyon while Sir Bastian Crowe hunts the caravan
9. **a hidden Duskwalker shrine**: learn what Ishkar the fire spirit wants
10. **the oasis town of Merrow, now occupied**: rescue Wren after she is taken
11. **the foothills below Saint Aurel**: outmaneuver Sir Bastian Crowe's final ambush
12. **the gates of Saint Aurel**: deliver the reliquary and decide Ishkar's fate
