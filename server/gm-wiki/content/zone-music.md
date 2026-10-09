# Zone music

[Wiki home](index.md)

Every song in LiDollQuest is a file the server sends, not something built into the game, so GMs can change music without a game update. This page covers the three places music is set:

- the **Music** tab of the GM panel (`/gm`), right after **Welcome**
- the **Zone music** box in the Map Editor
- the **Music** block and quest **Stage music** in the Story Workshop

## Songs: library and uploads

| Kind | Where it comes from | How slots name it |
| --- | --- | --- |
| **Library** | The game's built-in tracks (`boss`, `combat`, `desert`, `dungeon`, `forest`, `princess`, `princess2`, `town`, `castle`). They are converted from the game repo's `audio-masters/music/` folder. | By name, e.g. `town` |
| **Uploaded songs** | A GM uploads them on the Music tab. | By title in the menus (stored as `upload:<id>`) |

**Uploading.** On the Music tab, under **Uploaded songs**, choose a file (mp3, ogg, wav, flac or m4a, up to 50 MB), give it a title and press **Upload**.

- The server converts it to a 96 kbps mp3 for the browser game and an ogg copy for the desktop game. **Keep your original file**, because the converted copies are smaller and lower quality.
- Songs can be up to 10 minutes long.
- Uploading the same audio twice keeps one copy.
- **Only upload music you have the rights to.**

**Deleting** an upload is refused while any zone, Story Workshop flow or quest stage still plays it. The refusal names what still uses it. Players who already downloaded it keep their copy in their own cache, but nothing can pick it any more.

**What it costs players:** each player downloads a song once, about 0.7 MB per minute of music. After that their browser (or the desktop game's music cache) keeps it, so coming back to a zone costs nothing.

## Zone music: the three slots

| Slot | What it does | Left blank |
| --- | --- | --- |
| **Field** | The music while walking around the zone. **(silence)** plays nothing. | Inherits (see below) |
| **Battle** | Replaces the `combat` song for ordinary fights started in this zone. | Inherits, then the `combat` library track |
| **Boss** | Replaces the `boss` song for boss fights started in this zone. | Inherits, then the `boss` library track |

**Volume** (0-100) sets how loud the zone's field song plays. It multiplies each player's own music slider.

**Inheritance.** Each slot is looked up in this order:

1. The zone's own row.
2. For a hub room, its hub's row. For example, Honeydew Inn uses Honeydew Village.
3. The **Default** row.

The **Plays** line on each zone shows the field song it ends up with and where that comes from. **Clear** forgets a zone's row so it inherits again.

**Previewing.** Every song menu has a **▶** button that plays the song in your browser. **Stop preview** ends it.

## The Map Editor's Zone music box

The Map Editor has a **Zone music** box at the bottom of the right-hand column. It shows the zone you are looking at, with the same slots, volume, preview, Save and Clear as the Music tab, and it saves to the same place. It also lists any **story overrides** for that zone, i.e. quest stages whose Stage music names it or "any zone".

## Story music and priority

A player's own story can override zone music for that player only:

- **Music block** (Story Workshop):
  - **scene:** plays a song until the scene ends
  - **once:** a sting that plays one time, then the previous music comes back
  - **silence:** no music until the scene ends
  - **keep:** a song that follows the character into every zone, even after logging out
  - **clear:** stops the kept song

  See [Flow block reference](blocks.md#music).
- **Stage music** (quest stage blocks): while a stage is current, the listed zones (or "any zone") play the listed field, battle and boss songs. See [Quest stages and objectives](quests.md#stage-music).

When several apply, the game plays the first of:

1. sting
2. scene music
3. kept song
4. quest stage music
5. zone music

Fights keep their battle music and return to the right song afterwards.

## Adding a library track

1. Put the original file in the game repo's `audio-masters/music/` folder. Its file name becomes the song name, e.g. `castle.mp3` becomes `castle`.
2. Run `python python/export_online_music.py`. It converts new or changed masters into the server repo's `server/music-library/` folder and updates both `music-library.json` and the game's `datafiles/generation/music_library.json`.
3. Commit both repos, deploy the server, and ship a game build. The game needs the updated `music_library.json` to know the new name; uploads need no game build.

## Troubleshooting

- **Save refused:** the message names the slot. Silence is allowed only in the Field slot, and volume must be a whole number from 0 to 100.
- **Upload refused:**
  - "Upload mp3, ogg, wav, flac or m4a": the file isn't audio.
  - "ffmpeg is not installed": run `deploy/fedora-deploy.sh` on the server.
  - "Another song is converting": wait a moment and try again.
- **A preview or song does not play in game:**
  - The nginx proxy must publish `/quest-music/` (`deploy/nginx-quest-music.conf`).
  - The game page must allow media from its own site.
  - Check `curl -sI https://lidoll.dev/quest-music/<id>.mp3`. The second request should show `X-Cache-Status: HIT`.
- **Desktop players:** the first visit to an area keeps the old music for a moment while the song downloads.
- **Takedown:** after deleting an upload, purge the proxy cache on the nginx host: `sudo rm -rf /var/cache/nginx/quest-music/*`.
- The audit log records `music_set`, `music_clear`, `music_upload` and `music_delete`.
