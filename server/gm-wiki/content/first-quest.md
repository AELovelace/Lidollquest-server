# Build your first quest

[Wiki home](index.md)

This walkthrough makes **A Light for the Scout**. An NPC asks the player to clear a danger. Accepting starts a journal quest and a battle. Victory completes and claims the quest, then records `story_scout_rescued`. Future visits get a grateful greeting. A nearby orb becomes readable and presents a short epilogue.

Use a development server or controlled test area while learning. Saving or previewing a flow does not place anything; map placement is a separate live operation.

## 1. Choose the ingredients

Choose an existing zone and an already published, modestly tuned monster. Do not create a new monster for this first pass. Record its ID and the zone ID.

Create a new flow, give it the name **A Light for the Scout**, add Entry and End, connect Entry's `next` to End, and Save draft. Keep the generated flow ID. Set **Repeatable** on: refusal or a lost battle must not permanently consume the interaction. A flag check will prevent repeated victory rewards.

Use this worksheet as you create the records:

| Symbol in this guide | Your actual value |
| --- | --- |
| `SCOUT_ID` | Generated ID of your new NPC |
| `QUEST_ID` | Generated ID of your new quest |
| `MONSTER_ID` | Published monster selected from the library |
| `ZONE_ID` | Existing zone where you will test |
| `ORB_ID` | Generated ID of the epilogue orb |
| Victory flag | `story_scout_rescued` |

Do not type the uppercase symbols into fields. Substitute the corresponding actual IDs. If the suggested flag already belongs to another project, choose a project-specific name and use it consistently.

## 2. Create the memory flag

1. Open **Flag library**.
2. Enter `story_scout_rescued` as New flag ID.
3. Use **Rescued the scout** as the readable name.
4. Describe it: “Set after the scout rescue quest is claimed; unlocks the grateful greeting and epilogue orb.”
5. Click **Create flag**.

No player has been marked rescued. The flag definition exists; a missing character value still means false.

## 3. Create and publish the scout

Click **+ npc** in the content library. Keep the generated ID and record it as `SCOUT_ID`. Set the name to **Lantern Scout**, choose a sprite, and keep wander radius at 0 for the initial test.

Keep the `greeting` page and change its text to:

> My lantern went dark when the path guardian appeared. Could you clear the way so I can get home?

Set its next page to `close`. Add a second dialogue page with ID `thanks`, next `close`, no actions, and this text:

> You cleared the path! I left a little memory by the entrance for you. Thank you for helping me home.

Leave the NPC quest list empty for this first publication. Keep **story default** as `greeting`. Add one **story reactions** entry: under its conditions, require **All set → Rescued the scout**; set page to `thanks`; leave entry empty.

Choose **Keep edits in bundle** and Save draft. Open the same NPC in **Advanced GM tools → NPCs**, review it, and publish it. Publishing the NPC before the quest avoids a circular prerequisite during this introductory workflow. Reload the workshop to refresh its catalog.

## 4. Create the journal quest

Click **+ quest**. Keep its generated ID as `QUEST_ID`. Name it **A Light for the Scout** and describe the request and destination in player-facing language.

Set these fields:

| Field | Value |
| --- | --- |
| givers | One entry: `SCOUT_ID` |
| repeat | `once` |
| timer mode | `online` |
| timer seconds | `0`, meaning no deadline |
| turn in mode | `journal` |
| turn in npc | Empty |
| prerequisites | Empty for this tutorial |

Create one stage named **Clear the path**. Keep its generated stage ID, set mode `all`, and next `complete`. Add one objective:

| Objective field | Value |
| --- | --- |
| type | `kill` |
| text | “Defeat the path guardian for the Lantern Scout.” |
| target | `MONSTER_ID` |
| count | `1` |
| sharing | `personal` |
| zone | `ZONE_ID` if the task should only count there |
| token | False |

Set a small reward appropriate for your test, for example **10 XP** and **0 coins**, with no items or permanent stat changes. This is an example amount, not a balance recommendation for every zone. The monster may also award its normal combat rewards.

Keep edits in bundle and Save draft. Publish the same quest through **Advanced GM tools → Quests**. Reload the workshop. The published scout already satisfies the giver reference. You may later add this quest to the NPC's quest list if you also want its ordinary quest-offer menu; the flow's explicit accept operation is enough for this tutorial.

## 5. Assemble the rescue flow

Open the rescue flow. Replace the initial Entry-to-End connection with the graph below. Give blocks these labels so you can recognize them; block IDs can stay generated.

| Block label | Type and settings | Connections |
| --- | --- | --- |
| Start rescue | Entry | `next` → Already rescued? |
| Already rescued? | Check flags: All set `story_scout_rescued` | `match` → Welcome back; `no_match` → Ask for help |
| Welcome back | Dialogue: “The path is safe. Thank you again.” | `next` → Finish |
| Ask for help | Player choice with the offer text | `help` → Accept rescue; `later` → Maybe later |
| Accept rescue | Quest operation: `accept`, reference `QUEST_ID` | `next` → Path guardian |
| Path guardian | Battle, reference `MONSTER_ID` | `victory` → Check journal; `defeat` → Recover first; `retreat` → Try again later |
| Check journal | Wait for objective: `quest`, reference `QUEST_ID` | `complete` → Claim rescue |
| Claim rescue | Quest operation: `claim`, reference `QUEST_ID` | `next` → Remember rescue |
| Remember rescue | Set flag: `story_scout_rescued` | `next` → Thank the player |
| Thank the player | Dialogue describing the cleared path and orb | `next` → Finish |
| Maybe later | Dialogue: “Of course. Come back when you're ready.” | `next` → Finish |
| Recover first | Dialogue: “Rest first. We can try the path again.” | `next` → Finish |
| Try again later | Dialogue: “The path is still guarded. Come back when you're ready.” | `next` → Finish |
| Finish | End | None |

In **Ask for help**, edit the default choice or replace it with two choices: ID `help`, label “I'll help you,” and ID `later`, label “Maybe later.” Connect both outputs. Write player-facing text on every Dialogue and Player choice block.

Do not add a separate Reward block for the same 10 XP. The Quest claim already grants the quest reward. The victory flag belongs after successful claim so a failed claim cannot announce that the whole rescue is complete.

Connect defeat and retreat explicitly. Those branches do not set the rescue flag. Mandatory game defeat processing occurs before the defeat continuation. The quest remains available to finish; abandoning and reaccepting a quest does not promise a fresh timer or erased progress.

## 6. Bind the NPC

Click **Story settings / bindings**, then **Add entry binding**:

- Trigger: `npc`.
- Content: your Lantern Scout.
- Entry block: Start rescue.
- Conditions: leave empty; the first Check flags block handles returning characters.

The normal NPC interaction will offer **Continue personal story**. It will still have its normal greeting and applicable quest/service options. The flow is repeatable so a refusal is not permanent; the top flag check makes repeat visits harmless after success.

Validate. Fix every missing output, blank text, missing reference, or incorrect operation before continuing. Save draft.

## 7. Test the rescue before release

Use **Player preview** and follow every choice and battle outcome. Switch the rescue flag on and off. Preview skips real gameplay effects, so use it to check wording and routing, not whether the kill objective actually counts.

Next create an **In-game test** code and start it with `/storytest CODE`. If your real character has already completed the test quest, use a clean test character: the sandbox starts from a copy of that character's current quest progress. Clearing a flag alone does not remove a claimed quest.

Verify that acceptance creates the journal quest, the real battle awards its kill objective, the claim completes, and the rescue flag becomes true. Exit with `/storytest stop`. The real character must be unchanged. See the full [testing checklist](testing.md).

## 8. Publish and place the entry point

When publication is enabled, review and publish the flow. Open **Zone map & placements**, select `ZONE_ID`, expand the map's published-content list, and drag the scout onto a reachable free tile near a convenient entrance. Leave space around portals and occupants. Use a persistent lifetime if the NPC should survive map regeneration.

Placement is a live action. On a production server, schedule this step after the content has been reviewed. Enter with a compatible client, stand beside the scout, and talk. Check refusal, acceptance, and the grateful greeting on a return visit.

## 9. Add the epilogue orb

Create an orb with a readable title, glow color, and one nonempty page. In **story conditions**, require All set `story_scout_rescued`. Save and publish it, then refresh the catalog.

For a simple epilogue, the orb's own page is sufficient. For a playable or illustrated continuation, create a **separate** flow named **Scout epilogue** with Entry → Narrative → End. Add an `orb` binding to `ORB_ID`. Write the epilogue on the Narrative block, validate, test, and publish it. Keep this epilogue flow nonrepeatable and the orb nonrepeatable for a one-time memory.

Place the orb on a valid tile near the scout. Test with an unrescued character: it should be dormant. Test with a rescued character: it should read the epilogue. After a one-time read, it should no longer appear for that character. Another character's orb availability is independent.

## What you have built

You now have shared NPC, quest, monster and orb records; one repeatable but reward-guarded rescue flow; a personal victory flag; an ordered NPC reaction; and actual map placements. Extend it with additional stages or choices only after this complete route passes [release testing](testing.md#release-checklist).
