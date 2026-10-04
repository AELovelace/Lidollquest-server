# NPCs and dialogue

[Wiki home](index.md)

An NPC record defines who the character is, how they look, what they say, and which quests they offer. A placement gives that record a location. An entry binding optionally attaches a playable personal story, which plays as soon as the player bumps into the NPC.

## Replace an engine or placed NPC's dialogue

Add **NPC interaction** on the story canvas, choose its NPC, and connect **next** to your scene. Dragging from **Engine NPCs** creates this entry for an existing resident without creating another placement. A placed NPC entry covers every placement of its shared record; engine entries identify a zone and fixture. Current generated dungeon NPC references may change with layout resets.

Set **Story requirements** on the entry and choose whether it runs on **Every interaction** (default) or once per character. This setting is independent of the main flow's Repeatable setting. NPC interaction blocks override legacy bindings and greeting reactions; eligible entries use flow ID order, then block order. Put specific entries before a catch-all. Preview and isolated tests can start at the selected entry.

The server owns the entire interaction while replacement content is available or active. Default dialogue, services and quest options remain hidden through objective waits and even actions that finish without a page. Ordinary chat returns on a later interaction only after the entry is consumed or ineligible and no replacement run remains. A flag check connected straight to End still handles the interaction; gate the entry itself to restore ordinary chat.

## Create the shared NPC

Use **+ npc** to open the NPC's block canvas. Keep the generated ID, and select Settings to edit name, description, sprites, wander radius and quest links. Add **Dialogue page**, **Player choice**, and **Greeting reaction** blocks from the palette. Select a page before adding its choices. Connect the Settings greeting output to the default page. Start with a stationary NPC while testing proximity and placement.

In Settings, **Design a Sprite Lab look** chooses body, hair, clothing, accessories and colours. The static quest editor includes the same layer catalogue and artwork, so previewing and saving a look works without a live GM connection. Looks travel with exported NPC records and receive the same validation when imported. A look replaces the walking sprite; a separately selected portrait still takes precedence in conversations.

**Default facing** chooses Down (south), Up (north), Right (east) or Left (west). A wander radius of zero keeps the NPC facing that way. Wanderers begin with that direction and turn when they step. This works for both layered looks and directional walking sprites. Save and publish to update existing placements; a one-frame image has no directional frames to show.

Choose **Save content drafts** to save the NPC bundle independently. **Publish content** publishes the reviewed shared records without requiring a flow. **Back to story flow** keeps the bundle available to save/publish with that story. Specialized artwork tools remain in the advanced NPC editor; its Dialogue section links to this block canvas. Refresh deliberately after another editor changes the same record to avoid stale revisions.

Select one page, choice or reaction to edit its fields in the right inspector. Solid lines select the next page; dashed gray lines identify the page owning each choice. See [content block controls](workshop.md#shared-content-uses-blocks-too). Older tutorial images show the previous forms.

The [advanced conversation tutorial](tutorial-conversations.md) connects topics, personal flags and ordered return greetings.

## Dialogue pages

Each page has a stable ID, text, a next destination, and actions. `close` ends the conversation. A page with no actions can continue to its next page. Actions create player choices with labels, destinations, optional quest operations, and conditions.

Use short, readable pages. Give choices an actual meaning: “I'll bring the supplies” and “Not right now” communicate more than two identical “Continue” labels. Put practical task information in both the offer and the quest journal.

| Dialogue action | Use |
| --- | --- |
| `none` | Move to another page without a quest operation |
| `offer` | Accept the referenced quest when eligible |
| `turn_in` | Claim the referenced ready quest |
| `branch` | Choose the specified branch of a quest waiting for that choice |

Each choice block supplies these controls. Reaction blocks retain their ordered priority; **Move reaction earlier** moves a rule up. Existing specialized NPC services may also appear at runtime; preserve their behavior when adding a story.

## Keep quest services available

The NPC's quest list and giver references connect ordinary quest offers to this NPC. A bound story suppresses those options while active, including waits and silent actions. Completed one-time stories release the NPC on a later interaction; repeatable stories need binding requirements to become ineligible. For legacy bindings, a page-only greeting reaction can choose a server conversation instead. An eligible NPC interaction block takes precedence over those reactions.

Do not duplicate the same offer in several places unless that is deliberate. If the player can accept both through normal dialogue and through a flow, test entering the flow with the quest already active. The flow accept operation leaves an already active instance in place; later steps must still make sense for its current progress.

## Ordered story reactions

Story reactions choose the starting dialogue page or flow entry based on current flags. The first matching rule wins. A matching rule that chooses a **page** (and no flow entry) opens that dialogue page instead of auto-playing the bound story; the story is then offered as **Continue personal story** on that page. A rule that chooses a flow **entry** auto-plays the story from that block. Add specific rules before broad ones, drag them into the desired order, or use Move up. Always choose an explicit **story default** page for the fallback.

Example order:

| Priority | Conditions | Page |
| --- | --- | --- |
| 1 | All set: `story_scout_rescued`, `story_scout_epilogue` | `old_friend` |
| 2 | All set: `story_scout_rescued` | `thanks` |
| Default | No matching rule | `greeting` |

With both flags true, the first rule must win. Reversing these rules makes the more specific old-friend page unreachable whenever the broader rescue rule matches.

Set `page` to an existing dialogue page for a greeting reaction. Set `entry` to a block ID in the NPC's bound flow for a different story starting point. A page-only reaction changes the greeting; an entry-only reaction does not automatically author a greeting page. Check that every referenced flow entry still exists before publication.

Existing mandatory native reactions and services have their own behavior. When extending one of those NPCs, test the mandatory conditions as well as the authored flag rules; do not assume an imported page is a complete copy of every native service.

## Conversation stability

The server selects the greeting when the interaction begins. An already open conversation keeps its page rather than rewriting text under the player. Choice requirements are checked again when selected. A changed flow publication or a different matching story-entry reaction can make an open personal-story offer stale.

The expected recovery is to close and talk again. Do not tell a player to retry the same stale choice repeatedly. This protects the player from silently entering a different story than the one that was offered.

## Seed a flow from dialogue

Open the NPC record and select **Seed a new draft flow from this content**. The importer copies page text, choices, destinations, supported quest actions, and choice requirements into a new flow draft. It does not publish the flow or delete the source NPC pages.

Review every imported branch. Specialized native services or effects are not guaranteed to translate into supported flow operations. Validation may identify an operation that needs manual replacement. Add supported blocks explicitly rather than assuming an imported label performs the original service.

Once you publish an explicit binding, the selected interaction can start the flow. Later legacy dialogue edits do not silently rewrite the imported flow's text. Decide which authored surface owns that scene and edit it there.

## Test the NPC in context

Place the published NPC on a reachable tile. Approach with an eligible character and verify the default greeting, each overlapping reaction, quest offers, progress options, turn-in, and the story offer. Repeat with another character whose flags are false. Finally change an applicable requirement while an offer is open and verify a clean stale-choice rejection.


## Editing shipped residents

Use [Included online story sheets](workshop.md#included-online-story-sheets) to change a built-in resident or dungeon NPC while retaining its native service and quest routes. Clicking an imported engine NPC opens its sheet; dragging an engine NPC onto a flow still creates an explicit replacement interaction.

## Give a placement a patrol or schedule

In the Map Editor, choose **NPC routes** and select a managed NPC placement. Routes belong to that placement, not every copy of the shared NPC record. They override random wandering while present; conversations pause movement. **Save routes** commits immediately and restarts the NPC from home. An active player must be in the zone to watch normal walking.

See [NPC routes and pathfinding](npc-routes.md), [Build an NPC patrol](tutorial-npc-patrol.md), and [Daily work hours and timed rounds](tutorial-npc-schedules.md) for illustrated controls, movement demonstrations and complete exercises. This tool does not assign patrols to arbitrary engine residents.
