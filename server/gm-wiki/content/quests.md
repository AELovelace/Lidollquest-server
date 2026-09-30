# Quest stages and objectives

[Wiki home](index.md)

To start a scene when one objective completes, add **When objective completes** in the story flow and select that quest, stage and objective. Connect next to Battle for a parcel ambush, then drag 1-3 monsters into the Battle. The objective entry fires once per accepted attempt before whole-quest completion; **Wait for objective** retains its whole-quest readiness behavior.

A quest tracks a character's task in the journal. A flow controls the interactions around that task. Use Quest operation blocks to accept, claim, abandon, or choose a quest branch; use Wait for objective when the story should pause until the referenced quest is ready or claimed.

Quests now open as stage, objective and branch blocks with a compact inspector. See [the content block controls](workshop.md#shared-content-uses-blocks-too). Older tutorial screenshots show the previous forms; their objective field meanings still apply.

For full examples, try the [three-quest chain](tutorial-chain.md), [parcel delivery](tutorial-delivery.md), [zone stay](tutorial-zone-stay.md), or [daily patrol](tutorial-daily-patrol.md).

## Create and organize a quest

Use **+ quest** in the workshop library. The advanced Quests editor's New action also opens this block canvas, and **Edit quest blocks** opens an existing record. Select Settings for eligibility and repeat controls; select **Rewards / complete** for rewards. Save with **Save content drafts** and publish with **Publish content**.

Write a name, description, stage text, and objective text that tell the player what to do and where. Technical targets and IDs are not substitutes for instructions. A quest description should identify the destination, task, and return requirement.

## Eligibility and repeats

| Setting | Meaning |
| --- | --- |
| givers | NPC IDs allowed to offer this quest |
| prerequisites | Quest IDs whose rewards must already have been claimed |
| conditions | Current character numeric or flag requirements |
| repeat `once` | One successful claim per character |
| repeat `daily` / `weekly` | Eligible again according to the server's repeat period |
| repeat `cooldown` | Eligible again after cooldown seconds following claim |
| cooldown seconds | Interval for the cooldown repeat policy |

A character can have at most 16 active, branching, or ready quests. An unavailable quest should not be advertised as immediately acceptable in story prose. Quest acceptance through a flow still checks eligibility and prerequisites.

An abandoned attempt can resume its captured definition, timer, and progress when reaccepted. Do not write a retry that relies on abandonment erasing everything. Use a deliberately designed repeat policy and test the actual state transitions.

## Stages

A stage contains an ID, name, player-facing text, mode, objectives, a next destination, and optional branches. Mode `all` requires every objective; mode `any` requires at least one. The first stage is the initial stage.

Select a stage and add objective or branch blocks from the palette or inspector. **Quest stage** inserts a new block after the selected stage or branch; keep its generated stable ID. Connect its output to the next stage or ending. Use the Settings start output to choose the first stage. All stage creation and editing happens on this canvas. **Collect item pickup**, **Collect quest token** and **Deliver quest token** preconfigure the corresponding objective; select the target and count in the inspector.

Set next to another stage ID, `complete`, or `failed`. Every stage must be reachable. Quest-stage cycles and prerequisite cycles are rejected. A branching stage uses its branch destinations when objectives are met rather than automatically taking next.

`complete` means the quest is **ready to claim**. It does not mean the player has received rewards. This distinction matters for prerequisite quests, flags that represent a fully completed request, and flow waits.

## Objective completion flags

Create an authored flag in **Flag library**, select the objective block, then choose **+ Set flag on completion**. Pick the flag in the attached action's inspector; up to 16 authored flags can be set. The objective and action stay connected on the quest canvas, and deleting the action removes its effects. Save and publish the content, then accept a new quest to test it.

These flags become true when that individual objective meets its count and conditions. Other objectives may still be unfinished, and rewards need not be claimed. No active story flow is needed. State, equipment and item objectives that are already met may fire on acceptance. In an `any` stage, uncompleted objectives do not fire.

The effect runs once per objective per accepted attempt. Repeated events, reconnects, server restarts, and abandoning/resuming the same attempt keep that receipt. Clearing the flag later does not make the same objective set it again. A new repeat attempt can run it again. Timers and eligible party members persist their own effects. Existing accepted quests keep their pinned action lists when new content is published. GM Advance stage completes its objective actions; Complete quest skips the remaining actions.

Only active authored `story_...` flags can be selected and published. Engine achievements remain protected. Use a story flow's Set flag after Claim when the flag must mean the reward has actually been claimed. The **Wait for objective** flow block still waits for the whole quest to become ready or claimed.

## Objective reference

| Type | What completes it | Target and authoring notes |
| --- | --- | --- |
| `talk` | An eligible conversation event | NPC ID; accept the quest before the conversation you intend to count. |
| `visit` | Visiting the named destination | Zone ID or location-objective content ID, depending on the task. |
| `interact` | Interacting with the matching object or reading an orb | The shared content/objective ID, not a guessed display name. |
| `collect` | Holding enough real items, or collecting quest tokens | Item ID for inventory collection; matching token ID when token is true. |
| `deliver` | Explicit delivery through a designated NPC interaction | Target item/token ID, count, and delivery NPC; real items or tokens are consumed. |
| `kill` | Authoritative victory credit against the specified monster | Published monster ID; optional zone restriction must match the battle location. |
| `equipment` | Having the specified item equipped | Item ID and optional slot; this is a current-state check. |
| `state` | Meeting a numeric character condition | Field, comparison and value, such as health `gte` 10. |
| `timer` | Enough stage time, or connected time in the selected zone, has elapsed | Count is seconds. Blank zone uses the quest clock; an explicit zone uses accumulated connected presence there. |

Each objective also has a stable ID, descriptive text, count, optional zone, conditions, and sharing mode. Use unique IDs within a stage. Two different items with similar names still have different IDs.

For placement-backed objectives, enter the exact same content/objective ID on the placement and on the objective target. A `location` placement supports a visit task, `interact` supports an interaction, and `token` supports collection. See [Maps](maps.md).

## Numeric and flag conditions

Numeric conditions use `field`, `op`, and `value`. Supported comparisons are `gte` (at least), `lte` (at most), and `eq` (equal). Supported fields include health, stamina, shame, wet, tum, incontinence, excitement, childish, forced_inco_turns, had_wet_accident, and had_tum_accident.

Flag conditions use the same All set, Any set, and None set groups described in [Player story flags](flags.md). Multiple conditions must all pass. A condition is a gate on eligibility or progress; adding it does not itself set the flag or change the stat.

## Quest branches

A branch has an ID, label, destination stage or terminal result, and conditions. When the stage objectives finish, the quest enters a choice state. A Quest operation block with operation `branch` must reference the quest and the exact branch ID, and it only succeeds while that branch choice is pending.

A Player choice block and a quest branch are separate things. To make one player choice select a quest branch, connect that choice output to a Quest operation configured for `branch`. Do not connect directly to later prose and assume the journal advanced too.

## Timers and sharing

A timer objective with an explicit **zone** pauses outside that zone and resumes on return. Offline gaps and service downtime are not backfilled; the existing presence timeout can credit the last part of a lost connection. Progress is accumulated, not an uninterrupted-stay streak. Previously recorded objective credit is preserved when upgrading; subsequent credit follows the zone restriction. The quest-level deadline remains a separate clock and can still fail the quest. See the [zone-stay tutorial](tutorial-zone-stay.md) for the three-stage pattern and required server version.

Timer seconds `0` disables the overall deadline. `online` measures connected quest time; `realtime` uses wall-clock time and includes absence. Write explicit time limits into the quest's player-facing text.

Objectives default to personal credit. Opt into `party` only when shared progress is intended. Shared credit still follows the existing proximity, active-instance, objective, and encounter rules. A party member cannot advance another player's personal story choices or flags simply by sharing a quest objective.

## Claims and rewards

Turn-in mode `journal` permits journal-style completion. Mode `npc` names a designated turn-in NPC. A flow Claim operation uses the quest service and the captured turn-in identity; if you want the player to physically return, author a return objective or a second NPC interaction rather than assuming the Claim block teleports them back.

Rewards can include XP, coins, RPP, items, spells, supported permanent stat changes, and equipment changes. Set conservative values and inspect the full reward summary. The player must have inventory capacity for applicable rewards. Coins remain subject to account reward limits.

Claim once through the quest system. Add an explicit flow Reward only when it is a separate, intentional reward. [Battles, rewards and effects](monsters-rewards.md) explains the overlapping reward sources.

## Placed quest token visibility and pickup

GM-placed `token` objects appear in the game only for an active, incomplete `collect` objective with token enabled and a matching target ID. Any zone restriction and objective conditions must also match. Accept the quest first. Walk onto the token, click it while beside it, or press **E** beside it. Walking through it in a confirmed movement batch also collects it. A placement grants at most one token per accepted quest stage; clicking after walking cannot grant another. Collection hides that placement for the collecting character and leaves it available to other eligible characters. Abandoning or finishing the collection stage hides tokens that are no longer needed.

The GM map retains every authored placement. If it is visible there but absent in the game, check the accepted quest's current stage, exact target ID, token checkbox, conditions and zone. Published changes do not rewrite already accepted quest definitions; test a changed quest with a fresh eligible character or fresh isolated test state. For count greater than one, place distinct tokens with the same content ID.

## Daily and weekly flag resets

In the quest **Settings** block, select **daily** or **weekly** under **Repeat policy**, then choose **Clear flags when this quest resets**. Add existing flags or create one directly; up to 16 authored story flags are supported. An empty list preserves all flags. Save and publish, then accept a new attempt to use the changed settings.

After a successful reward claim, the selected flags clear once at the next midnight UTC for dailies, or Monday midnight UTC for weeklies. Due resets apply offline and before returning players' NPC greetings, story conditions and quest offers. Unfinished, ready-but-unclaimed and abandoned quests preserve their flags. Once-only and cooldown quests cannot configure reset flags.

Targets and repeat policy are pinned to the accepted definition. Later publication does not rewrite pending resets, and older attempts without the option are unchanged. Use quest-specific flags because shared flags affect every story reading them. Engine achievements cannot be cleared this way. A flag set again after rollover stays set until a new claimed attempt schedules another reset. GM Remove cancels pending resets; GM Finish without rewards does not schedule them.

## Minimap quest guide

Players track one quest at a time. The minimap then shows a **gold** marker on the door, gate, pad or wall gap to take toward the objective, and a **blue** marker on the objective itself once they are in the right zone. Blue corners around the whole minimap mean "somewhere in this zone". The guide always follows the **first unfinished objective in the order you wrote them**, even in an "any" stage, so list objectives in the order players should walk them.

To make the markers point well:

- Talk, deliver and NPC turn-ins find the resident fixture or the published NPC's placement. A published NPC with no placement gets no marker.
- Location visits, interacts, token collects and orbs point at their placement. If the same content ID is placed in several zones, the nearest one wins. Set the objective's zone to pin one.
- **Kill objectives need a zone**, or the guide only looks in the zone the player is already in. With a zone it points at the nearest living monster of that kind.
- Plain item collects, state, equipment and timer objectives have no place unless you give them a zone. Players then see only the HUD text.

A route through a disabled Dive, or to a zone with no way in, shows "The way there is closed right now" instead of a marker. The **quest_guide** switch on the Loot tab (or **Minimap quest guide** on the in-game GM Combat page) hides every marker for everyone when set to 0. Tracking is kept, so setting it back to 1 restores the markers.
