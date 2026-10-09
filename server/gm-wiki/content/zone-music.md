# Zone music

[Wiki home](index.md)

The **Music** tab of the GM panel (`/gm`), right after **Welcome**, sets which game track plays in each online zone. Every hub, hub room (Inns, temples, stores, the Farmstead), overworld, dungeon and Dive has a row. Changes reach players on their next screen refresh. Nobody needs to restart or redeploy anything.

## The three slots

| Slot | What it does | Left blank |
| --- | --- | --- |
| **Field** | The music while walking around the zone. **(silence)** plays no music at all. | Inherits (see below). |
| **Battle** | Replaces the game's `combat` track for ordinary fights started in this zone. | Inherits, then the game's own `combat` track. |
| **Boss** | Replaces the game's `boss` track for boss fights started in this zone. | Inherits, then the game's own `boss` track. |

**Volume** (0-100) sets how loud this zone's field track plays. It multiplies each player's own music slider, so 50 is half as loud as the player chose. It never makes music louder than the player's setting.

## Inheritance

Each slot is looked up separately, in this order:

1. The zone's own row.
2. For a hub room, its hub's row. For example, Honeydew Inn (`honeydew-lantern-beds`) uses Honeydew Village (`honeydew-lantern`).
3. The **Default** row at the top of the tab.

The **Plays** column shows what the Field slot ends up as for each zone and where that comes from. If nothing is set anywhere, the zone keeps whatever was already playing, which is how online play behaved before this tab existed. **Clear** forgets a zone's row so it inherits again.

## Previewing

Each slot has a **▶** button that plays the chosen track in your browser. For a blank Field slot it plays the inherited track. Only one preview plays at a time; **Stop preview** ends it. The preview is the same mp3 the game plays.

## Adding a new track

The list holds the sounds in the game's **`bgm`** audio group. To add one:

1. Import the track into GameMaker and put it in the `bgm` audio group. Sounds in the default group follow the SFX slider and are not offered here.
2. Run `python python/export_online_music.py` from the game repo. This rewrites `server/music-catalog.json` and copies the mp3s into `server/music-preview/`.
3. Commit the server repo and deploy as usual. A player's game build must also contain the track: an older build skips a track it does not have and keeps playing what it had.

`castle.wav` in the game's `sounds/castle/` folder is not registered in the IDE yet, so it does not appear in the list.

## Troubleshooting

- **Save refused:** the message names the slot. Silence is allowed only in the Field slot, and volume must be a whole number from 0 to 100.
- **Preview says "No preview":** the server is missing `music-preview/<track>.mp3`. Re-run the exporter and deploy.
- **The music did not change in game:** the player may be in a fight, since battles keep their music until they end. Otherwise the zone may inherit from a row you did not expect; check its **Plays** column.
- The audit log records `music_set` and `music_clear` with the zone, the three slots and the volume.
