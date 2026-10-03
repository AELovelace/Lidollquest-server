# Welcome tutorial

[Wiki home](index.md)

The welcome tutorial is a short run of pages that greets a new character once, in the first hub they enter, and then never again for that character. It is not a story flow: it has no blocks, flags or NPCs. Edit it on the **Welcome** tab of the GM panel (`/gm`), right after **Tutor NPC**.

## What players see

The client shows the saved title and pages as cards the player pages through. A page can carry one button that opens a link in a new tab (the wiki, the store, Discord). Closing the last page marks the tutorial as seen on that character; a replayed or repeated close is harmless. Pip (see the Tutor NPC tab) remains the place for questions afterwards.

The shipped default is four pages: a warm introduction, how to move and talk, the Player Wiki, and a gentle note about the store. **Reset to defaults** brings those back at any time; it asks for confirmation first.

## Who sees it

- **Tutorial is on** switches the whole feature. Off hides it everywhere and removes the pages from snapshots.
- Characters created **after** the feature was installed on the server see it once. The install date is shown in the status line.
- **Show to existing characters too** also shows it, once, to every older character who has not seen it yet. Turn it on after rewriting the pages when you want everyone to read the new version; it does not reset anyone who already closed it.

## Limits

| Field | Limit |
| --- | --- |
| Title | 1-60 characters, one line |
| Pages | 1 to 8 |
| Page heading | 1-60 characters, one line |
| Page body | 1-600 characters; line breaks are kept, other control characters are removed |
| Button label | 1-24 characters, or no button |

Saving replaces the whole page list, so use **Up**, **Down** and **Remove** on the tab rather than editing records elsewhere. The audit log records who saved, the switches, the title and the page count, not the prose.

## Link allow-list

A button link must start with `https://` and point at `lidoll.dev`, a subdomain of it (for example `https://wiki.lidoll.dev/`), or `discord.gg`. Anything else is refused with a message naming the page. The default wiki, store and Discord targets come from the server environment (`LIDOLLQUEST_WIKI_URL`, `LIDOLLQUEST_STORE_URL`, `LIDOLLQUEST_DISCORD_URL`); the status line shows the values in use.

## Troubleshooting

- A player reports no welcome: check the switch, then whether the character was created before the install date (turn on **Show to existing characters too** if they should still see it).
- Edits do not appear: players see changes on their next screen refresh; the **Preview** box shows what is saved on the server, not the unsaved form.
- Save refused: the message names the page and field that is over its limit or has a disallowed link.
