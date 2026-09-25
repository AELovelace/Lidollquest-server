# Rose Court / Frostveil Tundra release

Deploy this service and `server/tundra-data.json` before the matching game.
No database migration, tracker change or credential update is needed. Preserve
all existing databases, weekly editions, personal claims and reward receipts.

Rose Court (`princess-rose`) adds the usual lobby, four annexes and Lantern-balanced
arena. Its hall connects Quarters and Tundra. Lantern gains Tundra at (10,6), while
Clockwork retains Quarters and Desert. Legacy lobby dungeon entry validates the
same adjacency as hall pads; reconnects retain their existing route and inventory.

Frostveil (`overworld-tundra`, route `frostveil-crossing`) uses the shared weekly engine,
100x50 connected crossing layout, seven clearings, two beginner enemies per
clearing, existing personal loot/provenance and separate chat/claims. Its west
exit reaches Rose Court; its east reaches Lantern Court. No boss coin award.

Export future edits from the game using `python/export_online_tundra.py`. Changes
apply to new editions. The Desert generator's original endpoints and random draw
sequence are retained as defaults; existing serialized maps are not regenerated.

Validation: `npm test` includes 100 deterministic Frostveil maps, all hub annexes,
pad adjacency, crossing/reconnect/replay, full inventory, needs settlement,
weekly resets, beginner class combat and the 262144-byte gateway ceiling. Run the
game's `ps/Test-OnlineZones.ps1 -TundraOnly` for the two-player UI regression.
