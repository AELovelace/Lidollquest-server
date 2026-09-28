# Quest stages and objectives

[Wiki home](index.md)

A quest tracks a character's task in the journal. A flow controls the interactions around that task. Use Quest operation blocks to accept, claim, abandon, or choose a quest branch; use Wait for objective when the story should pause until the referenced quest is ready or claimed.

![The shared quest form exposes stage objectives and delivery fields.](../assets/tutorial/advanced-delivery-deliver.png)

For full examples, try the [three-quest chain](tutorial-chain.md), [parcel delivery](tutorial-delivery.md), [zone stay](tutorial-zone-stay.md), or [daily patrol](tutorial-daily-patrol.md).

## Create and organize a quest

Use **+ quest** in the workshop library or the existing Quests editor under Advanced GM tools. Edit the same record in either place, and reload after saving it elsewhere to avoid stale revisions.

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

Set next to another stage ID, `complete`, or `failed`. Every stage must be reachable. Quest-stage cycles and prerequisite cycles are rejected. A branching stage uses its branch destinations when objectives are met rather than automatically taking next.

`complete` means the quest is **ready to claim**. It does not mean the player has received rewards. This distinction matters for prerequisite quests, flags that represent a fully completed request, and flow waits.

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
