# Zones and placements

[Wiki home](index.md)

Content becomes discoverable when it is placed in the world. Story Workshop uses the existing zone-map, placement and regeneration services. It does not paint terrain or construct new zones.

![The map tools keep content kind, content ID, lifetime and the generated map together.](../assets/tutorial/reference-map-placement.png)

## Open the map

Choose **Zone map & placements**, select an existing zone, and wait for its map. The dialog shows the map edition and current status. From a selected block, **Show on map** highlights matching content in the map view; choose the relevant zone if it is not the one already shown.

The map dialog contains its own **Drag published content onto this map** list. Use that list while the dialog is open; the main canvas library is behind the dialog. NPCs, orbs and monsters must be published and active to appear there.

## Place content

Drag a published item onto a free tile, or choose a placement kind and content ID in the fields, then click a tile. The server checks reachability and separation from entrances, fixtures, other placements and occupants. A visually empty tile is not always valid: nearby protected tiles or a disconnected pocket can still make it unsuitable.

Use positions near a recognizable landmark and leave the walking route clear. For NPCs and orbs, verify the character can stand on or beside the interaction rather than only seeing it across a wall.

| Kind | Content field | Use |
| --- | --- | --- |
| `npc` | Published NPC ID | Conversations and bound personal stories |
| `orb` | Published orb ID | Readable memories and bound orb stories |
| `monster` | Published monster ID | Ordinary placed encounter content |
| `token` | Matching quest target ID | Quest token collection |
| `interact` | Matching objective target ID | An interaction hotspot |
| `location` | Matching visit target ID | A location objective |

For objective placements, provide a useful label and optional artwork. The target ID is the link to the quest; two labels that happen to match are not enough.

## Lifetimes

**Persistent** placements survive new map editions. The system attempts to realize their logical position on a valid reachable tile when geometry changes; the exact tile may move. **Temporary** placements belong to the current edition and ordinarily expire when that edition is replaced.

Use persistent content for ongoing quests. Active quests can prevent removing or expiring required placements. When the server refuses a change, inspect the affected quests and provide a replacement or use the existing advanced removal workflow with its explicit failure decision. Do not repeatedly force regeneration to work around the check.

Monster placement has its own respawn and roaming controls. The **Monster respawns** and **Monster roams** fields describe placed monster behavior; they are different from the personal, nonrespawning enemy created by a flow Spawn monster block.

## Update or remove a placement

For a listed content placement, edit X, Y, and Lifetime, then choose **Update placement**. This preserves the placement's identity and content references. **Open content** returns to the shared record. **Remove** removes the placement, not the entire canonical NPC or orb.

Monster placement/removal uses the existing world tools; use the advanced Zones tools when a monster is not in the content-placement list. Do not expect deleting a flow block to remove a live map entity.

Map operations commit immediately and have edition/revision checks. If another GM edits the map, reload it before retrying. Canvas Undo only handles authoring edits; it does not undo an already committed world operation.

## Spawn settings and regeneration

**Edit zone spawn settings** opens the existing zone record when one is available. Depending on the zone, settings include spawning, enemies roaming, enemies per room, respawn intervals, pursuit steps, weighted enemy pools, and boss selection. Some controls apply only to the corresponding zone type.

**Regenerate…** requests the existing regeneration operation with its normal player and encounter safeguards. **Cancel pending regeneration** cancels an applicable outstanding job. **Toggle hub layout lock** applies to a supported generated hub district, not every dungeon or interior.

Regeneration is not a preview of your flow. It can replace live generated geometry after the service's safeguards permit it. Inspect players, ongoing quests and encounters before using it, and check persistent placements afterward.

## Placement acceptance checklist

1. The canonical record is published and not retired.
2. The target zone and current edition are correct.
3. The tile is reachable and leaves usable entrance and interaction space.
4. Quest target IDs match the placement content IDs exactly.
5. Lifetime matches the intended availability of the quest.
6. Two different characters can approach and interact without blocking each other.
7. Required content survives a supported regeneration or fails safely with a clear reason.
