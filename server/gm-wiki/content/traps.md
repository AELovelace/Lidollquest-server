# Floor traps

[Wiki home](index.md)

Floor traps are hidden tiles that spring when a character steps on them: a splash, a snare, a sticky glue scene, a payout in LittleBig City. Online they come from one live **trap registry**, edited in the GM panel's **Traps** tab, and reach players in two ways:

- **Campaign full dungeons** (Castle Dungeon, Auto-Nursery, Regression School, Regression Hospital) scatter hidden traps across each weekly floor. Each route rolls from traps in zone **any** plus its own zone key (`bsp`, `nursery`, `school`, `hospital`).
- **Map Editor trap placements** put a trap on a chosen tile in any online zone: hubs, overworlds, Dives and full dungeons.

Both use the same trigger rules, checks and scenes, so a trap behaves the same wherever it springs.

## The registry

The shipped registry is the game's `datafiles/generation/traps.json`, exported to the server as `traps-data.json`. The Traps tab layers your changes on top:

| Status | Meaning |
| --- | --- |
| shipped | Exactly what the last export shipped |
| edited | A shipped trap with your changes |
| custom | A trap you created |
| retired | Removed from every pool; placements naming it are inert |

Filter the list by zone, type and status, or search by id, name or message. Changes apply to the next trap sprung, with no restart.

### Fields

| Field | Notes |
| --- | --- |
| Id | `a-z`, `0-9` and `_`. Fixed after the first save. Placements and the game refer to it. |
| Type | `damage`, `heal`, `wet`, `tum`, `wet_tum`, `str_drain`, `stamina_drain`, `stamina_heal`, `inco_up`, `excitement`, `spawn_enemy`, `civic_reward` or `dud` |
| Weight | Whole number, 1-1000: relative chance within its pool |
| Min / Max or Amount | The rolled value (`{value}` in the message). Use both min and max, or one fixed amount. |
| Zones | At least one of `any` or the registry's zone keys. `any` joins every pool. |
| Trigger style | `pressure`, `wire`, `click`, `swing` or `sticky`: changes the amount, and crawling can slip under wires |
| Narrative scene | Optional. Must be one of the shipped trap narratives; without one the player sees the message. |
| Lingering | Wet/tum added on each later step for the given number of turns |
| Message | Shown to the player. `{value}`, `{name}`, `{trigger}` and `{zone}` are filled in. |

The **Advanced JSON** box holds the checks and rarer fields:

```json
{
 "avoid_check": {"label": "Slip past the snare", "stat": "DEX", "difficulty": 12,
   "state_modifiers": [{"state": "crawling", "bonus": 3}],
   "partial_text": "You almost clear it."},
 "detect_check": {"label": "Read the wire path", "stat": "INT", "difficulty": 11},
 "resist_check": {"label": "Tear free", "stat": "STR", "difficulty": 11},
 "struggle_threshold": 2, "wait_threshold": 4, "archetype": "tutorial_wire"
}
```

Check stats are `STR`, `DEX`, `DEF`, `INT` or `CHA`. A successful avoid skips the trap; a partial halves it. Detect adds to the avoid roll; resist reduces the amount.

Every save is validated. An unknown zone, type, stat, field or narrative, or a range out of bounds, is refused with the reason, and nothing is saved.

### Retire, restore, reset

- **Retire** takes a trap out of every pool. Shipped traps are tombstoned rather than deleted, so a later export cannot bring them back by accident.
- **Restore** brings a retired trap back, keeping any edits. On an edited shipped trap, **Restore shipped** discards your edits.
- **Reset everything** discards every edit, retirement and custom trap.

Every save, retire, restore and reset goes in the audit log.

### Using the registry in the offline game

**Download traps.json** saves the live registry in the game's own `traps.json` format. Copy it over `datafiles/generation/traps.json` in the game project to use the same traps offline. Rebuilding the server export from that file then makes it the new shipped baseline.

## Placing a trap in the Map Editor

1. Open the Map Editor, select the zone and choose **Place content**.
2. Choose kind **Trap**, then a trap, or **Random** to roll a fresh trap from the zone's pool each time it springs.
3. Click a free tile. The usual placement rules apply: reachable, away from entrances, fixtures and other content, 128 managed placements per zone.

Trap placements show as a red diamond. Move them with **Select / move**, copy and paste them, or remove them in remove mode, like other placements. Full dungeons' generated floor traps show as dashed diamonds for reference. They reroll with the floor and cannot be edited.

**Random pools by zone:** full dungeons use their route's keys; LittleBig City uses `littlebig_city`; desert, gulch and caldera maps use `desert`; woods and taiga use `forest`; other hubs use `town`; everything else uses `any` alone.

## What players experience

- Trap tiles look like ordinary floor. Players never receive trap placements or their positions. Gamemasters see them in game as a red cross.
- Traps never block movement. A queued walk stops on an armed trap, so its scene plays where it sprang.
- Each character springs a placement **once per map edition**. A persistent placement re-arms when its zone gets a new map (the weekly Dive floor or the monthly hub layout). An avoided trap counts as sprung. A placement whose trap is retired does nothing, and stays armed until the trap is restored.
- The result plays as a scene in the narrative box. Struggle and wait choices, page effects and lingering wetness work as on campaign floors.
- `spawn_enemy` traps only ambush inside full dungeons. Elsewhere they show their message only. `civic_reward` pays coins (within the daily cap) and XP, scaled by the player's shame tier.

## Troubleshooting

- **"Choose a live trap from the Traps tab, or Random."** The trap id is unknown or retired. Reload the Map Editor.
- **The trap never fires for me.** You already sprang it on this map edition, or its trap is retired. Test with a second character, or move the placement to a new map edition.
- **My edit did not change a scene already open.** A scene keeps the trap it rolled. The next spring uses the new values.
