# Access and authoring basics

[Wiki home](index.md)

## Open the correct server

Open the game server's `/gm` page and sign in with a LiDollID account that has the gamemaster role. Choose **Open Story Workshop** or **Pop out Story Workshop**. The workshop lives at `/gm/flow-editor`; this guide lives at `/gm/wiki/`.

The ordinary workshop link works when a browser blocks pop-ups. The in-game **GM → Powers** menu and the packaged Python editor can also launch the workshop. A browser window must use the same server origin as the signed-in GM panel: signing in on one hostname does not sign in another hostname.

Keep the GM panel available for advanced editing and the workshop available for assembling stories. Both edit the same server records. Opening the wiki does not grant editing privileges; every editing request still requires a current staff identity.

If you see a sign-in error, follow **Advanced GM tools / Sign in**, complete sign-in, and reload the workshop. If the server refuses your address or requires HTTPS, use the approved GM address. See [Troubleshooting](troubleshooting.md).

## Drafts are different from live content

A **draft** is the latest saved work on a record. A **published definition** is what new gameplay uses. Saving a draft does not switch player interactions to it.

The selected flow has a revision. Shared records have their own revisions. The server refuses stale edits rather than allowing an older window to overwrite a newer save. When working with another GM, agree who owns the current edit to each shared asset.

New content may need to be saved and reopened before all normalized default fields appear. Workshop reference dropdowns include published records, saved drafts marked **[draft]**, and records being edited in the current bundle. **Refresh content** picks up content saved in another window without discarding the open flow. Referenced unpublished drafts and their unpublished prerequisites are included in the publication bundle, with revision checks and a confirmation listing included assets. Live map placement still requires published content.

**New flow** creates a story sequence, not a journal quest. On a Quest operation or quest-wait block with an empty reference, choose **Create journal quest for this flow** to create and select a draft with the flow?s name and description. Review its giver, objectives and rewards before publishing. If the flow already has a battle, the helper suggests a kill objective for its first battle; this is a starting point to review, not a guarantee of the intended quest design.

## Names, record IDs, and block IDs

| Identifier | Purpose | Authoring advice |
| --- | --- | --- |
| Display name | Human-readable NPC, quest, or story title | Write something players can understand. |
| Content record ID | Connects quests, placements, NPCs, and flows | Copy it accurately; keep it stable after saving. |
| Block ID | Identifies a specific node in a flow | The workshop generates it; use the label for readability. |
| Choice ID | Selects an output from a Player choice block | Use a distinct ID for each choice; changing it requires reconnecting. |
| Flag ID | Names a personal memory | Use a descriptive ID such as `story_scout_rescued`. |

The **+ npc**, **+ quest**, **+ orb**, and **+ monster** buttons generate record IDs. Keep those IDs and record which one belongs to which asset. Editing an ID field is not a supported rename of an existing record. In examples, symbolic names such as `SCOUT_ID` mean “paste your scout's actual ID,” not text to enter literally.

## Plan before dragging

Write a short design note containing:

- Where the story begins and how the player recognizes the NPC or orb.
- What the player is asked to do, including where they must travel.
- What is tracked in a quest and what is remembered by a flag.
- What happens on refusal, defeat, retreat, and a repeat visit.
- Which rewards come from combat, quest claims, and explicit story rewards.
- Which assets are reused by other stories.

For a first project, use one existing zone, one NPC, one published monster, one quest stage, and one authored flag. Add branches after that complete route works.

## What changes immediately

Flow and bundled asset edits wait for Save or Publish. Map placements, placement updates, regeneration controls, and GM flag overrides are separate server actions. They are not undone by the canvas Undo button.

Creating a flag definition changes the flag library. It does not set the flag on all characters. Inspecting and clicking an individual character's flag value changes that character immediately and is audited. Use preview overrides or an isolated test for experiments.

## A useful first-session checklist

1. Sign in and open both the workshop and this wiki.
2. Check whether publication is enabled; drafts and preview remain useful while rollout is disabled.
3. Create a small flow with Entry connected to End and save it.
4. Inspect one existing NPC, quest and monster to learn the form structure.
5. Follow the [worked tutorial](first-quest.md).
6. Use [isolated tests](testing.md) before placing a live entry point near players.

## Ask the GM wiki assistant

Open **Ask the GM wiki assistant** from Story Workshop or the GM panel for a separate chat window. It uses your staff sign-in and can show matching handbook sections and pictures. See [Using the GM assistant](ai-help.md) for follow-ups, image controls and troubleshooting.
