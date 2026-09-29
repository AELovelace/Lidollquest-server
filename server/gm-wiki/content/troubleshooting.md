# Troubleshooting and recipes

[Wiki home](index.md)

## Access and editor problems

| Symptom | Check and recovery |
| --- | --- |
| Workshop says to sign in | Sign in on `/gm` at the same hostname, then reload. The account must still have the GM role. |
| Pop-out does not open | Use the normal Open Story Workshop link or open `/gm/flow-editor` directly. |
| Publish is disabled | The server rollout switch is off. Drafts and preview are still available; ask the operator about rollout. |
| New asset is absent from a selector | Click Refresh content to load saves from another window. Workshop references include [draft] records; live map placement still lists published content. |
| “This flow changed” or stale revision | Another edit won. Preserve your text, reload current records, and reapply the change. |
| Recovered draft is older than the server | Compare before saving. Recovery is local to the tab, not authoritative server history. |
| Map click appears to do nothing | Read the status/error message. Wait for regeneration, reload the map revision, and choose a reachable unoccupied tile. |

## My story is missing from a quest reference

A saved **New flow** record is the story sequence. A **Quest operation** reference selects a journal quest with stages, objectives and rewards; publishing a flow does not turn it into that separate record.

If you already made the journal quest, use **Refresh content** and find it by name and ID. Saved but unpublished quests now appear with **[draft]**. On an older server version, publish the quest in the Quests editor and refresh the workshop to make it appear.

If you only made the flow, select a Quest operation block, leave Content reference empty, and choose **Create journal quest for this flow**. The helper creates and selects a matching draft. Review its objectives, giver and reward; keep edits in the bundle, save, validate and publish. The original flow stays intact. You do not need to type or copy the new quest ID to link that block.

## The NPC does not offer the story

Check that the flow is published, publication/start rollout is enabled, the binding kind is `npc`, the binding references the correct NPC ID, and its entry exists. Check current binding flags, client compatibility, and whether that character has already completed a nonrepeatable flow.

Make sure you placed the same canonical NPC you edited. A matching name is not proof of a matching ID. Approach close enough to interact and finish any existing scene or encounter. Close an old conversation and talk again after publication.

## The wrong greeting appears

Inspect the current character's flags. Review reaction order: the first match wins, and an empty condition matches everyone. Place specific rules above broad rules. Verify the chosen page ID and explicit default page.

An open conversation remains stable. Reopen it to select a new greeting. Accepted quests may also retain captured NPC definitions; compare with a fresh character before assuming a new publication was ignored. Check mandatory native reactions when extending an existing service NPC.

## A wait never completes

For a quest wait, inspect the journal: the entire referenced quest must be ready or claimed. An active stage, pending branch choice or failed quest does not satisfy it. Check target IDs, zone restrictions, required count, personal/party credit and whether the task event occurred after acceptance.

For a flag wait, inspect All, Any and None groups. Ensure there is a reachable way to set the flag before that wait. A Set flag block after the wait cannot satisfy it until the wait has already finished.

## Victory did not finish the quest

The monster may not match the objective target, the zone restriction may be wrong, or the quest may not have been active when the kill occurred. A party's battle does not automatically credit every unrelated quest. Confirm the owner received eligible authoritative kill credit.

If the quest is ready but rewards are absent, it still needs a claim. Add a Quest operation `claim` or the intended normal turn-in path. If claiming fails, check inventory space and current quest status before repeating combat.

## The reward repeats or pays less than expected

Check for both a quest reward and a flow Reward granting the same payout. Then check Repeatable and any loops back to rewards. Receipts prevent duplicate processing of one step, not intentionally reaching a new reward step in a new run.

Lower coin payment can reflect the existing account reward cap. Compare intended quest, combat and story payouts separately. Never tell a player that reconnecting should bypass a reward limit.

## The orb is dark or missing

A dark orb can be waiting for its required earlier orb or a flag condition. A spent, nonrepeatable orb disappears for that character. A retired or unpublished orb does not become available just because its placement remains.

Check read history as well as flags. Clearing a flag does not clear the read receipt. If the orb is bound to a flow, also check that flow's repeat policy, completion history and binding requirements.

## A battle or spawn cannot start

Finish outstanding combat, mandatory scenes, world-turn processing or purchases. Check for a conflicting active story and a compatible client. Make sure there is reachable space near the owner for the story enemy, and verify ordinary party capacity and follower limits.

If the issue appears only after travel, inspect the actual destination and arrival position. If it appears only with a party, test each participant's state rather than adding a fourth actor to work around the problem.

## Test code problems

Codes belong to the creating GM and expire after 30 minutes. A used code is associated with its character. Use the same account and server, end an existing test first, and finish conflicting real interactions before starting.

After changing a draft, create a fresh code. If a copied once-only quest is already claimed, use a clean character rather than assuming a false flag is a full reset. If the GM role is revoked, continuing the test is correctly refused.

## Recipe: refusal now, acceptance later

Make the flow repeatable. Put Check flags at the beginning to route completed characters to a harmless return greeting. Connect refusal to a short Dialogue and End. Set the success flag only after the intended successful completion. This permits a future offer without paying successful characters twice.

## Recipe: return to the giver before reward

Use a multi-stage quest: first kill/collect, then a talk or delivery objective targeting the giver. Wait for the quest to become ready, or conclude the first interaction and use the ordinary NPC turn-in. Claim only after the return requirement is fulfilled. A Claim block alone does not require a walk back from wherever the flow currently is.

## Recipe: two remembered outcomes

Use a Player choice with two outputs. On each route, set its authored outcome flag and clear the opposing authored flag if exclusivity is intended. Give NPC reactions specific conditions for each result and an explicit unchosen default. Keep quest branches synchronized with the chosen route when the journal also branches.

## Recipe: a quest unlocks a later memory

After a successful claim, set a completion flag. Require that flag in an orb's story conditions. Use the orb's pages for a simple scene or bind it to a separate epilogue flow for a playable continuation. A separate flow avoids accidentally consuming the epilogue when a nonrepeatable rescue flow ends.

## What to include in a bug report

Record the server/build, flow ID and published revision, node label/ID, related quest and NPC IDs, map edition, character ID, exact action, expected result, actual error, and whether you were in an isolated test. Include relevant flag names and quest status. Do not include sign-in grants, tokens or private credentials.

## Ask the GM wiki assistant

Open **Ask the GM wiki assistant** from Story Workshop or the GM panel for a separate chat window. It uses your staff sign-in and can show matching handbook sections and pictures. See [Using the GM assistant](ai-help.md) for follow-ups, image controls and troubleshooting.

## Placed quest token visibility and pickup

Older servers could record a failed token interaction as a pickup receipt without awarding collection progress. With the recovery fix installed, these receipts no longer hide or block tokens when the matching collection objectives still have zero progress. Pick up the token normally; no quest reset or map regeneration is needed. Successful pickups remain protected against repeat collection. If some collection progress already exists and a token is still missing, include the quest and placement IDs in a bug report: the server preserves ambiguous old receipts rather than guessing which pickups were real.

GM-placed `token` objects appear in the game only for an active, incomplete `collect` objective with token enabled and a matching target ID. Any zone restriction and objective conditions must also match. Accept the quest first. Walk onto the token, click it while beside it, or press **E** beside it. Walking through it in a confirmed movement batch also collects it. A placement grants at most one token per accepted quest stage; clicking after walking cannot grant another. Collection hides that placement for the collecting character and leaves it available to other eligible characters. Abandoning or finishing the collection stage hides tokens that are no longer needed.

The GM map retains every authored placement. If it is visible there but absent in the game, check the accepted quest's current stage, exact target ID, token checkbox, conditions and zone. Published changes do not rewrite already accepted quest definitions; test a changed quest with a fresh eligible character or fresh isolated test state. For count greater than one, place distinct tokens with the same content ID.
