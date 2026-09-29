# Using Story Workshop

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
