# NPCs and dialogue

[Wiki home](index.md)

An NPC record defines who the character is, how they look, what they say, and which quests they offer. A placement gives that record a location. An entry binding optionally attaches a playable personal story, which plays as soon as the player bumps into the NPC.

## Replace an engine or placed NPC's dialogue

Add **NPC interaction** on the story canvas, choose its NPC, and connect **next** to your scene. Built-in residents are in the same NPC dropdown, marked `[engine NPC]`; choosing one creates the entry without creating another placement. (They are no longer listed in the content library.) A placed NPC entry covers every placement of its shared record; engine entries identify a zone and fixture. Current generated dungeon NPC references may change with layout resets.

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

Use [Included online story sheets](workshop.md#included-online-story-sheets) to change a built-in resident or dungeon NPC while retaining its native service and quest routes. Built-in sheets open with a direct link (`/gm/flow-editor?kind=sheet&id=<sheet id>`); the catalogue and the Engine NPCs library drawer are hidden. An NPC interaction block that picks the engine NPC still creates an explicit replacement interaction.

## Give a placement a patrol or schedule

In the Map Editor, choose **NPC routes** and select a managed NPC placement. Routes belong to that placement, not every copy of the shared NPC record. They override random wandering while present; conversations pause movement. **Save routes** commits immediately and restarts the NPC from home. An active player must be in the zone to watch normal walking.

See [NPC routes and pathfinding](npc-routes.md), [Build an NPC patrol](tutorial-npc-patrol.md), and [Daily work hours and timed rounds](tutorial-npc-schedules.md) for illustrated controls, movement demonstrations and complete exercises. This tool does not assign patrols to arbitrary engine residents.

## Companion memory and backstories (Companions tab)

The seven hireable companions (Dame Elowen, Astra, Mira, Rosalind, Sable, Vex and Wick) remember each character they
travel with. They talk in their own voice, draw on their backstories, and become more open as their bond with that
character grows. All of this is on the **Companions** tab of the GM panel.

**Backstories.** Each companion has a few short sections, like "Raised at the Iron Chapel". The AI uses a section
when it fits the conversation.

**Dialogue preset.** Under the companion picker in **Backstories**, the **Dialogue preset** list sets how that companion
talks in every AI reply:
- **Authored default** uses whatever the desktop editor's Companion tab set (shown in brackets).
- **Persona voice** uses no preset: the companion talks only from their persona and voice lines.
- **Normal**, **Gentle** or **Baby talk** use the matching trained style.
The change takes effect on the companion's next reply, with no export or restart, and is recorded in the audit log.
- **Reveal bond** keeps a section secret until the character's bond with that companion (0-100) reaches the number.
  **Reveal flag** also requires a story flag.
- Sections marked **DRAFT** were written by Lumi and still need a GM read-through. Edit the text if needed, then
  click **Sign off**. **Add a section** creates a new one, and **Delete** removes a section from the game.
- Write sections as plain facts about the companion, two or three sentences each.
- Put names you want the companion to say into the text. The AI refuses names it has never been shown.
- Changes reach the AI servers with the next reply.
- Known canon conflicts to settle are listed in the game repo's ONLINE_FOLLOWERS_GUIDE.md. Examples: Rosalind the
  companion vs. the nursery boss, and Astra "freed from" vs. "never had" the curse.

**Bond and memories.**
- A character's bond with a companion grows when they share experiences: fights won (+2), quests finished (+5), new
  places (+1), revives (+3). It grows at most **bond_hourly_cap** per hour.
- Companions also remember accidents and changes. Those count as embarrassing.
- After a chat, the AI notes anything personal the player said, saved as "Doll said ...".
- Past **keep_per_pair** memories, the oldest minor ones are folded into a short relationship summary.

**Slips and gossip.**
- When other players can hear, a companion may let an embarrassing memory slip (**slip_chance**). If anyone else
  actually heard the line, the speaker loses **slip_dignity** Dignity. The same memory can't slip again for a day.
- Companions can also tell anonymous stories about other travellers (**gossip_chance**). They never name anyone
  and never repeat what a player said.

**Talking without the name.**
- **Follow-ups:** once a companion answers a player, that player's lines count as talking to them for
  **followup_window_s** (180 s), anywhere within earshot (the area-chat range: 20 tiles sideways, 15 up or down).
- **The hirer:** a player's own hired companion listens to them without the name (**hirer_default**).
- **Classifier check:** when other players are around, a classifier first decides whether answering would be natural
  (**address_classifier**).
- **Crowds:** with **busy_threshold** other players on screen, players must use the name again (except in their own
  ongoing conversation).
- **Typos and nicknames:** one-letter typos of longer names, and the Companion tab's **nicknames**, count as the name
  (**fuzzy_names**).
- **Emotes** like `/me hugs Elowen` get a reaction (**emote_replies**).
- **Reactions:** hired companions speak up on their own (**reactions_enabled**).
  - **When:** they greet on hire, and comment on boss wins, quests, revives and losses. Ordinary wins and new places
    get a comment at **reaction_chance**.
  - **Where the lines come from:** AI lines for big moments at **reaction_ai_chance**, and at most once per
    **reaction_cooldown_s**. The written lines are in each companion's `online.reactions` (Lumi's drafts, editable in
    the desktop editor's Companion tab).
  - **Accidents:** they get comfort only when nobody else can hear. In public they can only come out as a slip.
  - **AI budget:** optional AI lines share **ai_calls_per_minute**.
- **Musings:** a hired companion whose hirer stands still in a town for **musing_after_s** may say something on their
  own, about every 5-7 minutes (**musings_enabled**, **musing_chance**, **musing_cooldown_min_s**/**max_s**).
- **Banter:** two hired companions near each other occasionally trade two lines about themselves or the place, never
  about players (**banter_enabled**, **banter_chance**).
- **Situation:** companions notice the place, the time of day, and a player's health, hunger and thirst
  (**situation_enabled**). They mention needing the toilet, wet or messy padding, or smell only when nobody else can
  hear.

**Character memories.** Type a character name or id to see:
- that character's bond with every companion, with a **Set bond** box for testing secrets
- the relationship summaries
- every memory, with a **Delete** button on each

**Wipe all companion memories** removes everything for that character. Every change on this tab is recorded in the
audit log.

## Give an NPC an AI persona (Ambient Life)

An NPC with an AI persona can start short conversations with other persona NPCs and with players standing nearby. It also answers when someone says its name in area chat.

1. Open the NPC in the NPC editor and go to the **AI persona** step (between Quest links and Review).
2. Fill in the character template:
   - **Occupation**: what the Decider sees as their role.
   - **Desires** and **personality traits**: one per line, written as "Name - note".
   - **Background**.
   - Up to four **interests**.
   - **Relationships**: type another NPC's name to link them.
   - A few **voice lines**.
   - **Chattiness**.
   - **Who they talk to**.
   - **Speaking style**: the authored dialogue preset (Normal, Gentle, Baby talk, or the persona's own voice).
3. Click **Test line** to hear how they sound, and **Test gate** to see whether they'd join in on a line. Both use the local AI and post nothing in game.
4. Tick **AI persona enabled**, publish, and place the NPC anywhere with the placement map.
5. On the **Ambient Life** tab, set `ambient_enabled` to on in Tuning and save.

The **Ambient Life** tab also shows:
- a **Dialogue presets** list: one dropdown per NPC with its AI persona on. It overrides the speaking style from the NPC editor right away (no publish needed). **Authored default** goes back to the NPC editor's choice;
- live conversations, recent lines and the Decider's choices;
- an **Export decisions** button (player names are replaced with Player1, Player2, ...).

Good to know:
- Each NPC says at most `ambient_max_responses` (default 5) lines per conversation. The Decider usually ends things sooner.
- If the Decider is down, or the server isn't set to `QUEST_PARTICIPATION_BACKEND=decider`, nothing ambient happens.
- Ambient lines never use the paid AI. If the panel ever shows a COST ALARM, tell the developers.
- Persona NPCs may comment on what anyone can see about a player (wet clothes, padding, a smell). It costs no Dignity.
- Only players on screen hear ambient lines: 20 tiles to either side and 15 up or down (the area-chat range since 2026-10-15). The whole Arcanum Tower fits inside that, so everyone in the tower hears its residents; a player outside does not.
- Shopkeepers have no persona. With `ambient_beckons` on, they call out to passers-by now and then.
- Example residents: Padma, Wren, Felix and Brittany in Utopia's Arcanum Tower commons. Open them in the NPC editor to see a finished persona.

