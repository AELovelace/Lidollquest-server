# LiDollQuest GM wiki

Make online quests that players can discover, finish, and remember. This guide covers the **Story Workshop**, the shared NPC, quest, monster and orb editors, world placements, and the testing and publication tools.

The articles are ordinary Markdown files. This website reads and renders them in your browser; **View Markdown** opens the source of the chapter you are reading. Use the search button, `/`, or Ctrl+K to search all chapters.

## Start with a complete example

Follow [Build your first quest](first-quest.md) to make a scout who asks for help, a tracked battle objective, a victory flag, a grateful return greeting, and an orb that becomes available afterward. The tutorial includes refusal, defeat, and retreat, so it is a playable story rather than just a happy-path diagram.

If this is your first GM session, read [Access and authoring basics](getting-started.md) and [Using Story Workshop](workshop.md) first. Keep the workshop in one window and this guide in another.

## Choose an advanced tutorial

Each guide has real editor pictures, field-by-field instructions, a publication path, and checks for the failure cases. Click a picture to enlarge it. IDs in pictures are examples: copy your own generated asset IDs when following along.

- [A three-quest chain](tutorial-chain.md): Unlock three journal quests in order with prerequisites and separate claims.
- [A piety-gated quest](tutorial-piety.md): Check patron and piety, protect acceptance, and remember completion.
- [Find and deliver a parcel](tutorial-delivery.md): Place quest tokens, collect them, deliver them, and claim the reward.
- [Advanced conversations](tutorial-conversations.md): Create topic loops, conditional choices, and remembered NPC reactions.
- [Visit and spend time in a zone](tutorial-zone-stay.md): Require arrival, connected time in the destination, and a return report.
- [Unlock a secret memory orb](tutorial-secret-orb.md): Use a personal flag to open a placed story orb and build a memory trail.
- [A repeatable daily patrol](tutorial-daily-patrol.md): Author repeat eligibility, modest rewards, and a complete return route.

## The authoring workflow

1. **Plan the player experience.** Write the offer, the task, the possible outcomes, and what the world should remember.
2. **Create shared content.** NPCs, quests, monsters, orbs and zone settings remain canonical records in their existing libraries.
3. **Connect a flow.** Use blocks to present dialogue, accept a quest, wait for progress, start a battle, change a flag, and conclude the interaction.
4. **Bind and place it.** A binding chooses what interaction starts a flow. A placement puts the NPC, orb or objective on a valid world tile. You often need both.
5. **Test every outcome.** Preview the presentation, then use an isolated in-game test for real gameplay behavior.
6. **Publish deliberately.** Check shared references, resolve validation errors, and release the new definitions. Existing runs retain their captured definitions.

## Find the right chapter

| I want to… | Read |
| --- | --- |
| Understand dragging, ports, undo, and the properties pane | [Using Story Workshop](workshop.md) |
| Add an objective to a player's journal | [Quest stages and objectives](quests.md) |
| Write an NPC who remembers helping them | [NPCs and dialogue](npcs.md), then [Player story flags](flags.md) |
| Learn what a block actually does | [Flow block reference](blocks.md) |
| Make a readable orb or illustrated scene | [Orbs, narratives and artwork](orbs-art.md) |
| Trigger a fight or award an item | [Battles, rewards and effects](monsters-rewards.md) |
| Put the content into an existing dungeon | [Zones and placements](maps.md) |
| Paint terrain and inspect reachability | [The Map Editor](maps.md#the-map-editor-pop-out), [Map editing tutorial](tutorial-map-editing.md) |
| Give an NPC a patrol or daily schedule | [Route reference and interactive demo](npc-routes.md), [Patrol tutorial](tutorial-npc-patrol.md), [Schedule tutorial](tutorial-npc-schedules.md) |
| Change the pages a new character reads on arrival | [Welcome tutorial](welcome-tutorial.md) |
| Moderate a player shop or read its ledger | [Player shops](player-shops.md) |
| Try a story without affecting real progression | [Preview and isolated tests](testing.md) |
| Release or restore an earlier version | [Save, publish and rollback](publishing.md) |
| Fix a missing offer or a stalled objective | [Troubleshooting and recipes](troubleshooting.md) |

## Four concepts to keep separate

**Quest:** a journal task with stages, objectives, eligibility and a claimable reward. **Flow:** the sequence of story actions and choices. **Flag:** a persistent fact belonging to one character. **Placement:** a location where a character can interact with content.

A flow does not replace the quest system. An NPC block does not create a placement. A flag does not automatically complete an objective. Connect those systems deliberately using the tools described here.

## Scope of this guide

This wiki documents online GM authoring. Stories are personal even when an eligible party joins a battle. The existing three-participant battle limit and one-follower-per-party cap continue to apply. Executable stories cannot run arbitrary code, moderation commands, or account administration.

Maps use existing zones and generation controls. Terrain drawing and new-zone construction are outside Story Workshop. The AI conversation service does not authoritatively change story flags or execute story blocks.
