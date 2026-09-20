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

## Quest token artwork correction

This correction needs only a quest-server update. Refresh the admin page after deployment. Tokens and interaction objects now have their own sprite selector, 32?32 preview and PNG upload; shipped inventory icons are included. The server validates and persists the chosen artwork. Existing compatible browser/Windows clients already consume placement sprite references; no client or tracker update is required for this correction.

## GM Guide

The GM Guide tab includes a first-quest walkthrough, tokens/deliveries, all objective types, branches, dialogue, placement, rewards, artwork, monsters, troubleshooting and an ID lookup. Help buttons in the authoring panels jump to the matching topic without discarding editor forms. This update needs only the quest-server package; restart the service and refresh the admin page. No tracker or game-client build is required.

## Weekly hub quest pack

`content/weekly_quests.json` ships with this repository and is published after the
compatible clients are out, because publishing live quest content enables the
client-version requirement. From this checkout:

Add one line to `/etc/lidollquest/server.env` and restart:

```
LIDOLLQUEST_QUEST_PACK=content/weekly_quests.json
```

That is the whole deployment. The quests are boot content, validated at startup, with
no gamemaster sign-in and no upload step. The panel can still edit or retire any of
them afterwards.

To publish to a running server instead, without a restart, use the uploader:

```bash
npm test
node scripts/upload-weekly-quests.mjs --base https://<host> --signin
```

The pack's givers are existing roaming district residents, so no NPC has to be
published first and no zone placements are required. Re-running publishes only
changed quests; `--retire` withdraws the pack from new acceptance while leaving
accepted instances and their claims intact. See README.md for the full description.
