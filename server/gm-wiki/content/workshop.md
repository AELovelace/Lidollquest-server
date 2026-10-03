# Using Story Workshop

The online world now starts with essential services, the retained Coastal Caverns story, the seven hireable companions and Pip. Other old built-in town NPCs, dungeon story NPCs and campaign/weekly quests have been removed from the live world and library. Companion and tutor sheets are available under **Included online stories**; archived edits are recovered only when no newer live sheet exists. Use **+ npc**, **+ quest** and **+ orb** to build your team's content. Existing GM-created content and the rewritten Caverns story remain available; the offline campaign is separate.

[Wiki home](index.md)

## The workspace

### Shared content uses blocks too

Click an existing quest, NPC or orb in the content library (or **+ quest**, **+ npc**, **+ orb**) to open its canonical block canvas. Select one block to edit in the small right inspector. **Back to story flow** keeps your content drafts and returns to the surrounding flow. The workspace title and save button identify which kind of content you are editing.

Quest canvases offer stage, objective, item pickup, token collection/delivery and branch blocks. Select a stage before adding an objective or branch. Adding a stage inserts it after the selected stage/branch. NPC canvases offer page, choice and ordered reaction blocks; select a page before adding its choice. Orbs offer narrative pages. Existing data opens directly, with its IDs and relationships preserved.

Green connections select the next stage/page or an ending. Dashed gray lines show ownership: delete an objective/choice block to remove it from its parent. The Settings output selects the starting stage or default greeting. Content deletion/duplication operates on one selected block at a time; moving can still use multiple selections. Stable IDs stay fixed while names and text remain editable.

**Pickups & quest tokens** lists inventory items and targets from quest drafts and saved placements. Click or drag a target onto a selected quest stage. Token objectives include a named selector, a new-target ID field and **Show / place objective on map**. Generated item pickups are visible in the map's pickup list too.

**Check blocks** highlights structural problems. **Save content drafts** saves shared drafts, and **Publish content** reviews their bundle before publication. The server also validates definitions and checks revisions. Content layout is local browser-tab recovery data; the original quest/page fields remain the saved runtime format. Flow previews and isolated tests remain available after **Back to story flow**. Advanced GM stage/dialogue sections open this same block workspace.

The left pane contains a searchable block palette and content library. The center is the story canvas. The right pane edits the selected block or the overall story. **Player preview** opens a collapsible presentation pane over the canvas. **Zone map & placements** opens the world placement tools.

The toolbar contains New flow, Refresh content, Save draft, Validate, Publish, Rollback, Undo, Redo, Duplicate, Delete, Fit, Arrange, zoom controls, Flag library, Player preview, and In-game test. The saved-flow dropdown selects an existing draft. Refresh content updates the catalog while preserving your flow and pending bundle edits.

## Export and import bundles

**Export bundle** downloads one JSON file holding the open story flow, the shared quest, NPC, orb and monster drafts it needs, and the authored flags they use. **Import bundle…** reads such a file back. Imported records arrive as unsaved bundle edits and the flow opens as a draft, so the usual **Save draft**, **Save content drafts**, validation and publication review still apply; importing never publishes anything.

The confirmation lists what the file contains, which saved drafts your next save would replace, and which flags are created immediately. If a saved flow already uses the bundled flow's ID you can replace that draft or import the story as a copy with a new ID. Flags that already exist keep their current definitions.

The same file format is produced by the **public quest editor**, a statically hosted copy of this workshop that anyone can use without an account. It has the shipped zones, items, spells, sprites, monsters and engine flags, keeps drafts in the visitor's browser, runs the same validators and player preview, and has no publishing, map placement or in-game tests. Contributors export a bundle and hand it to a gamemaster, who imports it here, places NPCs, tokens and locations on the map, and publishes after review. The build command is `node scripts/build-public-quest-editor.mjs`; see the server README.

## Add and edit a block

Click a palette button to create a block, or drag it onto the canvas. Select its card to show its properties. Give it a label that explains its job, such as “Offer the rescue,” “Victory only,” or “Return after helping.” Labels are for authors; **Player-facing text** is what the player reads.

Dialogue, Narrative and Player choice blocks also offer **Portrait / artwork**. Choose an existing approved asset or compiled sprite. See [Artwork](orbs-art.md#artwork).

Drag a monster onto an existing Battle to add it to that fight (maximum three, including duplicates). Add **When objective completes** or **When flag is set** to start a separate scene from a parcel pickup or a progression flag. Select the trigger and connect its next output; no interaction binding is needed.

Dragging a library record onto the canvas creates an appropriate reference block: a monster becomes Battle, a quest becomes Quest operation, a zone becomes Travel, an NPC becomes Dialogue, and an orb becomes Narrative. Inspect the result: this does not automatically create a placement, entry binding, complete conversation, or all related quest steps.

## Connect execution ports

1. Click an output port on the source card.
2. Click **Input** on the destination card.
3. Check the labeled wire.

For example, connect a Battle's `victory` output to Set flag and its `defeat` and `retreat` outputs to different explanatory pages. Each output has one destination. Several outputs can converge on the same block.

Select an already-connected output and choose another input to reconnect it. Select a wire and press Delete to remove that connection. You can also choose destinations in the right pane's **Connect next**, **Connect victory**, or other output fields.

Solid execution wires mean “run this next.” A dashed reference button opens shared content. A content reference does not execute that asset as a separate story or put it on the map.

## Move around and organize

| Action | Control |
| --- | --- |
| Move a card | Drag the card body |
| Select several cards | Shift-click cards |
| Select all cards | Ctrl+A outside a text field |
| Duplicate selection | Duplicate or Ctrl+D |
| Delete selection or selected wire | Delete |
| Undo / redo canvas edits | Ctrl+Z / Ctrl+Shift+Z, or toolbar buttons |
| Move selected cards precisely | Arrow keys while navigating the canvas |
| Pan | Drag empty canvas |
| Zoom | Mouse wheel over the canvas, or − / + |
| Show the complete graph | Fit |
| Lay out connected blocks | Arrange |
| Save | Save draft or Ctrl+S |

Duplicate copies selected blocks and connections between those selected blocks. Check incoming and outgoing connections to blocks outside the selection afterward. Arrange changes visual positions; it does not choose the correct story order for you.

Cards and controls can receive keyboard focus. Avoid using graph shortcuts while typing in a text field. Click empty canvas or **Story settings / bindings** to return the right pane to flow settings.

## Story settings and bindings

For NPCs, add **NPC interaction** directly to the canvas. Choose an engine resident or placed NPC, set requirements and **Every interaction**, and connect **next** to story actions. The **Engine NPCs** library also supports drag-and-drop entry creation. Explicit NPC blocks take priority over legacy bindings and greeting reactions; among eligible blocks, flow ID order then block order decides. Basic dialogue is suppressed throughout server actions, including objective waits and silent completion. It returns on a later interaction with no active or eligible replacement.

Set a stable flow ID, name, description, and Repeatable setting. Use **Add entry binding** to choose a trigger kind, referenced content, entry block, and optional flag requirements.

| Trigger | Meaning |
| --- | --- |
| `npc` | Plays the personal story as soon as the player bumps into that NPC, overriding its normal chat (see [NPC reactions](npcs.md#ordered-story-reactions)) |
| `orb` | Starts when the character reads that placed orb |
| `zone` | Starts from the supported zone-entry path |
| `objective` | Uses completion of the referenced quest instance: ready or claimed |

The objective binding is a quest-level completion trigger, not a free-form individual objective ID. For stage-by-stage behavior, use quest stages and branches, then explicit waits or choices in the flow.

A published legacy binding belongs to one active flow. NPC interaction blocks can have several conditional entries; keep alternatives within one flow with specific entries first and a broad fallback last. See [NPC reactions](npcs.md#ordered-story-reactions).

## Edit a shared record

Open an item in the content library or click a block's **Reference** button. The shared record form opens in a dialog. Expand nested sections to edit them. Arrays have Add, Remove and Move up controls; their entries can also be dragged to reorder.

Choose **Keep edits in bundle**, then **Save draft** on the flow. These edits are part of the current bundle, not an unrelated copy of the content. Publishing that bundle changes the shared asset for future users of the asset, including other stories.

### Dress an NPC with Sprite Lab

Open an NPC from the content library and select its **Settings** card. Under the ordinary fields is **Sprite Lab look**:

1. Choose **Design a Sprite Lab look**. The NPC starts as a dressed body in its original colours.
2. Pick an item for each slot (Body, Hair, Torso, Legs, Shoes, and up to three of Head, Face, Neck and Back). Items marked ★ are premium for players; staff can use them freely.
3. Colour each part with a swatch or the colour picker, and drag the slider for tint strength. Tick **Original** to return a part to its drawn colours.
4. Watch the preview: front, left, right and back, walking. **Randomize** rolls a whole outfit.
5. Save and publish the NPC as usual.

Players then see the look on the map instead of the walking sprite, and in the conversation portrait unless the NPC has its own portrait art. **Remove look** returns the NPC to its walking sprite. The same designer is on the **Artwork** step of the GM panel's NPCs tab.

Built-in town residents work the same way. Open the resident's **Resident / service NPC** sheet from the content library; the designer sits at the bottom of its overview card. Publish the sheet to show the look to players. Merchants and NPCs inside dungeons keep their original sprites for now.

Some canonical fields use technical labels such as `next`, `target`, `mode`, or `sharing`. Their supported values are documented in the relevant chapters. No JSON editor is required. If a specialized control is absent from the generic form, use the existing advanced editor for that same record, then reload to obtain its current revision.

Quest references include **[draft]** journal records and unsaved bundle records. Newly referenced unpublished dependencies are included in the flow?s publication bundle; existing published assets are not replaced by their separate draft edits unless you explicitly edit them in the bundle. A flow itself is not a quest reference: use **Create journal quest for this flow** on an empty quest reference to start a linked journal record. See [Piety check](blocks.md#piety-check) for the new faith branch block.

## Validate, recover, and resolve conflicts

Use **Validate** frequently. Errors identify affected blocks or missing connections; warnings can identify unreachable content. Incomplete drafts can be saved, but errors must be fixed before publishing or running a validated test.

Unsaved flow work is stored for recovery in that browser tab under the signed-in owner. After a reload, accept the recovery prompt if it contains the work you want. This is not a server backup and does not follow you to another browser.

If another window changes a record, copy any important unsaved prose, reload the current server draft, and apply your intended changes again. Repeatedly clicking Publish does not resolve a revision conflict. See [Publishing](publishing.md).

## Shared asset publication controls

NPC and quest forms now have a fixed toolbar for **Save asset drafts**, **Publish asset bundle...**, **Keep edits in bundle**, and **Remove from bundle**. Errors stay visible inside the form. Saved shared edits remain in the current flow bundle until publication, including after tab recovery. Library labels show draft-only records and unpublished changes. The [publishing guide](publishing.md#publish-an-npc-or-quest-without-a-flow) explains the distinction between these buttons and the canvas Publish button.

## Ask the GM wiki assistant

Open **Ask the GM wiki assistant** from Story Workshop or the GM panel for a separate chat window. It uses your staff sign-in and can show matching handbook sections and pictures. See [Using the GM assistant](ai-help.md) for follow-ups, image controls and troubleshooting.


## Included online story sheets

Click **Included stories** in the toolbar to reveal the converted catalogue and clear its search while preserving current edits. **Included online stories** opens at the top of the content library by default; open a region to select its sheets. These source sheets are separate from the **Choose a flow** dropdown. If this section is missing entirely, the game server needs the story-sheet update deployed and restarted before reloading the browser.

Included NPC, scene, service and quest sheets carry a permanent **Built-in** marker plus **Needs human re-authoring**. Saving, publishing or restoring a revision does not clear that task. After a human has re-authored the sheet, use **Mark human re-authoring complete** in its inspector; **Mark as needing human re-authoring** reopens it. The Built-in marker remains, and custom-created sheets do not receive it. Search the library for **Needs human re-authoring** to find remaining work. This editorial status persists separately from content drafts and publication, so marking it never activates quests or changes player progress.


Open **Included online stories**, choose a region, then an NPC, service or story scene. These are the game's shipped definitions. Select a card and use **Open ?**, **Up one level** and **Sheet overview** to navigate trees, pages, choices, checks and effects. **Add entry** and **Add supported field** expose supported authoring controls. Named page connections are editable; keep stable page IDs and once-only keys. Native service and quest choices remain available when editing source sheets.

Hub residents expose a greeting and optional **topics** with a **topic label**. **online ? Shared NPC choices and service confirmations** holds service wording; retain placeholders such as {price}. Companion voice/example/fallback and tutorial settings have sheets too. Generated replies and service transactions remain runtime behavior.

**Save content drafts** keeps edits private. **Publish content** changes subsequent interactions. **Compare shipped default** and published revision history can restore a draft for review. Source changes never overwrite your saved edits. Existing conversations and accepted quest definitions retain their pinned data.

The included quest library also shows optional weekly pack definitions as drafts until enabled or published. Opening or saving them does not activate offers. Existing placements are reused; no duplicate NPC or map regeneration is needed. New client builds read published tours/topics/service wording; older clients retain packaged text.
