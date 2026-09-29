# Preview and isolated tests

[Wiki home](index.md)

Use both preview and an in-game test. Preview answers “does this story read and branch correctly?” An isolated game session answers “do the actual quest, battle, inventory, flag and travel services behave correctly?”

## Testing automatic entries and lineups

Select **When flag is set** or **When objective completes**, then **Preview from this entry** to inspect its branch. In **In-game test**, choose **Start at entry** to run that sub-scene in isolation, or start at the main entry and complete the pickup normally. Three selected monsters must appear as three separate combatants, including duplicates; victory must wait for all of them. Verify the scene does not repeat on reconnect, and that a suspended objective wait returns after the scene.

Use a newly accepted quest when testing completion tracking. Objectives completed before this tracking existed do not gain retroactive receipts. Events defer during dialogue/combat and retry crowded starts without undoing collected parcels.

## Orb visibility checks

Place an orb with **Hidden until revealed**, then test **Reveal orb -> Dialogue -> Hide orb -> End**. Check the actual map and reconnect in each state. A second character must retain their own state, hidden reads must be rejected, and revealing a read-once orb must not reset its read receipt. Preview reports simulated visibility without touching live overrides; isolated tests copy the character's visibility and read history and keep later changes inside the test.

## Player preview

Save your work, then choose **Player preview**. The preview displays dialogue or narrative text, optional artwork, and choice buttons. It highlights the current block on the canvas. Use the offered battle outcomes to inspect victory, defeat and retreat continuations.

Expand **Simulated conditions** to test flags and, for Piety check blocks, simulated patron and piety. Try below, equal to and above the threshold, a different patron, and no patron. Imported numeric choice requirements can also expose simulated values. These controls affect preview state only. Restart returns to the starting route; check the current simulated flags when comparing paths, since a previous simulated Set flag may have changed them.

Preview does not grant real rewards, create real encounters, deliver items, move the character, or update a real quest. A simulated wait or battle outcome is an author-supplied result. Passing preview is not proof that an objective target, monster balance, inventory claim or zone destination is correct.

## Create an isolated test

1. Save a valid flow draft and its related asset drafts.
2. Choose **In-game test**.
3. Optionally select **Use current preview flags** to copy the explicit simulated flag values into the test character.
4. Click **Create test code**, then copy the code.
5. Enter the online game on the same server with the creating GM account.
6. Open **GM → Powers → Test a story** and submit `/storytest CODE`, replacing CODE with the copied value.

The character must be out of combat, mandatory defeat scenes, conflicting stories and pending purchases. A code belongs to its creating GM and, once used, its selected character. Codes expire after 30 minutes; the server limits each GM to five unexpired sessions. A test can recover through a server restart while its code remains valid.

**Pasting on desktop:** Test a story prefills `/storytest ` in the chat box. Paste only the copied code with **Ctrl+V** or **Shift+Insert**, then press **Enter**. In the browser on Mac, use **Cmd+V**. Pasting appends to the draft; it does not submit. Escape keeps the draft, and clicking the chat field or pressing T restores focus. These shortcuts require the updated game client with the clipboard-input fix; reloading an older build will not add them.

The test starts the draft flow directly. It is useful before you publish a live binding or placement. It does not by itself prove that a normal NPC offer or orb approach starts the story correctly; test those entry interactions separately in a controlled environment after publication.

## What is isolated

The test uses a copied character, separate quest/encounter/world state, and a local test wallet. Gameplay inside it cannot pay the real account, change real character flags, grant real progression, or create real shared placements. Normal local/cloud saves are suppressed while the client is in the isolated session.

Flag overrides change only the copied character. Other copied progress remains relevant: a once-only quest already claimed on the original character can still be ineligible in the copy. For a clean first-run test, begin from an appropriate character. Clearing a victory flag is not a reset of every quest, reward and orb receipt.

The web GM tools outside the test still operate on the real server. In particular, web map placement and Flag library character overrides do not become sandbox actions just because your game client is testing a flow. Use preview overrides and in-game test gameplay for isolated experiments.

## Exit and repeat

Use `/storytest stop` or the GM **End story test** action. Check that the character returns to its original location/progression view and real wallet balance. Expired or stopped test-session commands are rejected rather than applied to the real character.

Create a fresh code after changing the draft you want to test. Do not assume a running test automatically adopts new edits. Exit an old test before entering another.

## A practical test matrix

| Case | Check |
| --- | --- |
| First visit, flags absent | Default greeting, offer and requirements are sensible |
| Refusal | Player can leave; future offer behavior matches the repeat policy |
| Acceptance | Correct quest and stage appear before relevant events occur |
| Victory | Objective counts, claim succeeds, intended flag is set, total rewards are correct |
| Defeat | Mandatory processing completes before story continuation; no success payout |
| Retreat | No false victory; player has an understandable retry path |
| Return visit | Correct reaction wins; no duplicate one-time reward |
| Overlapping rules | Most specific intended rule appears first |
| Stale open choice | Changed requirements or publication cause a clean rejection |
| Reconnect/restart | Outstanding scene or encounter resumes without repeating committed effects |
| Full inventory or capped coins | Reward handling remains understandable and recoverable |
| Another character | No inherited flags, dialogue history or completion from the first character |
| Party and follower | Valid combinations work; no fourth participant or second party follower |

## Release checklist

Read every visible page aloud or at normal reading speed. Check that choice labels fit, artwork does not hide important text, and the player can always identify the next task. Verify keyboard, pointer/touch, and small-screen presentation in compatible desktop/browser and Android builds.

Test the actual placed NPC and orb, including distance checks, dormant prerequisites, repeat visits, and blocked entrance space. Review quest prerequisites and timers with a character that does not have GM shortcuts active. If you use god mode for routing checks, repeat the balance check without it.

Keep a short result note with flow ID and revision, related asset revisions, test character, scenarios checked, and any unresolved issues. Publish only the revision you actually reviewed. See [Publishing](publishing.md).
