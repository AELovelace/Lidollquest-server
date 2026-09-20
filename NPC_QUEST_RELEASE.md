# NPC and quest authoring release

Upload the coordinated tracker, quest-service, browser and Windows packages. No new environment variables or provider credentials are needed. NPC artwork uses the existing saved `PIXELLAB_API_TOKEN` and Python worker configuration.

1. Back up the live SQLite database using SQLite's online backup facility, or stop the service while copying its database/WAL files together. Managed PNG artwork, published history, placement positions, accepted quest definitions, conversation state, jobs and claim receipts are database-backed. Preserve the complete deployed data directory and retain the matching shipped exports.
2. Install the tracker gateway update using its normal deployment procedure and restart `lidoll-tracker`. Both browser and native gateways now forward authenticated `quests/detail` reads.
3. Extract the quest server into a new release checkout and run `sudo bash deploy/fedora-deploy.sh`. Its additive tables are initialized automatically. Keep the existing database and `/etc/lidollquest/server.env`.
4. Upload the browser game package and distribute the Windows package. Publish NPCs and quests only after these compatible clients are available. Older clients receive an update-required error once live NPC/quest content is published.

Use **NPCs** to draft dialogue, select or generate artwork, and publish definitions. Use **Quests** to define prerequisites, stages, objective credit, clocks, repeat policies and rewards. Publish a referenced NPC first; then publish its quest and add quest offers to the NPC. Existing resident NPCs are available as quest givers without replacing their services.

Use **Zones** to place NPCs, interaction objects, quest tokens and location markers. Objective IDs connect objects/markers to quest targets. Placements default to persistent and relocate to reachable tiles when terrain changes. The alternative is current-map-only placement. Map replacement is blocked if expiring temporary placements would strand active quests; add a persistent replacement or explicitly fail them first. Removal reports active quest dependencies; supply a replacement or explicitly fail the affected quests. Whole-Dive regeneration validates required placements before activation and retains the current map on failure.

Player quest instances pin their definitions and rewards at acceptance. Publication and rollback affect future acceptance; accepted content and receipts remain durable. Claims use the existing account coin caps, RPP ledger, item provenance and currency delivery outbox. Inventory overflow leaves claims pending. State conditions use the existing validated character-loadout model; this release does not turn the client-trusted campaign needs model into an anti-cheat system.

Server changes add `npc` and `quest` content kinds, `world_place_content`/`world_remove_content` GM actions, NPC-associated staged art jobs, online quest/conversation actions through `/zones/action`, authenticated `/quests/detail`, and additive snapshot fields `onlineQuests`, `worldPlacements`, `worldInstance`, `questNpcLinks` and `questVersion`. Compatible clients enter with `quest_version: 1`. Quest mutations include the reviewed `quest_revision`; ordinary command IDs, controller leases and character revisions still apply.

The desktop editor continues to modify offline campaign sources. Online overrides are not written into shipped exports by the admin console. New shops/services, arbitrary scripts and automatic campaign-quest migration are not part of this release.
