# LiDollQuest server

The `/gm` panel is organized into Players, Chat, RP Journal, RPP, Curses & Blessings, Moderation, and Performance tabs. The sticky header keeps refresh, automatic refresh, and sign-out available. Switching tabs preserves drafts and filters; arrow keys, Home, and End navigate the tab bar, which scrolls horizontally on phones. This is a quest-server panel update only: redeploy the service and reload `/gm`; no game or tracker rebuild is needed.

## Public character descriptions

`POST /characters/action` supports free `description` edits with `saves:write`.
Send the owned `character_id`, `request_id`, `description` (up to 2,000 Unicode
characters, blank to clear), and `description_revision` (initially zero). Conflicting
profile edits return `description_conflict`; ordinary gameplay does not invalidate
a draft. Descriptions live outside save/loadout imports and appear in inspection,
companion and MommyBot profiles. RP posts capture the current description.
Deploy with the updated omo-trainer companion and game client. No new environment
settings or manual migration are required. `test/management.test.mjs` covers the API.

## Premium private sprites

The animation compatibility update reads PixelLab `last_response`, requests
`keep_first_frame: false` so eight generated frames remain eight, and downloads
the character ZIP when completed jobs return storage metadata. It preserves each
job's direction and sorts exported frames numerically. `incomplete_animation`
diagnostics now include bounded idle/per-direction frame counts. Deploy this
server update before retrying a generation that failed during packing; the game,
tracker and token configuration need no changes. ZIP retries never submit paid
generation again. See the [PixelLab API specification](https://api.pixellab.ai/v2/openapi.json).

Deploy the tracker sprite routes and diamond-consent changes before the GX client.
Install Python 3.11+ and `pip install -r python/requirements.txt`; set the service's
`PIXELLAB_API_TOKEN` and optionally `PIXELLAB_PYTHON` (default `python3`). Keep these
secrets on the server. No key disables new generations without affecting saved art.

If the game says **Generation is not configured yet**, add `PIXELLAB_API_TOKEN`
to `/etc/lidollquest/server.env` using `sudoedit`, then restart
`lidollquest-server` and reopen the private collection. The setting must be loaded
by the quest service, not just an interactive shell or the tracker. Existing
environment files are preserved on redeploy. `QUEST_COMPUTE_WORKERS` is independent.
The Fedora installer ships `python/` and installs system Python, Requests and
Pillow; use `PIXELLAB_PYTHON=/usr/bin/python3` with those packages. Older releases
that omitted the worker folder need the corrected release as well as the token.

`GET /sprites`, `GET /sprites/asset`, and `POST /sprites/action` use authenticated
account ownership. Generations cost one diamond, reserve one of five per-character
slots before payment, and run in one background worker. The shared Python client
comes from the desktop walk generator; copy it with the game's
`python/prepare_private_sprite_worker.py` when that generator changes. Worker
failures refund through durable wallet receipts; restarting an interrupted worker
marks its generation for refund rather than resubmitting it. Refund recovery runs
when the owner opens their collection. Run one service process per SQLite database.

Draft sprites attach once to the account's next created character. Selection is
character-exclusive; other players can fetch equipped art only while sharing a
live zone. Descriptions and saved collections stay private. Deleting a completed
sprite frees its slot without refunding it. Existing browser grants need renewed
consent for diamond spending. Test with `node --test test/private-sprites.test.mjs`;
the GX fixture uses synthetic PNGs and never spends real provider credits.

Generation failures log `quest_sprite_generation_failed` with an allowlisted
code/stage and optional numeric `http_status`; provider response bodies, prompts,
tokens and raw Python stderr remain private. Check `journalctl -u lidollquest-server`
for `python_unavailable`, `worker_missing`, `python_dependency_missing`, or a
provider HTTP error (401 token, 402 credits, 422 validation, 429 limit). Reopening
the collection retries outstanding game-diamond refunds. Regression coverage:
`node --test test/private-sprite-provider.test.mjs test/private-sprites.test.mjs`.

## Shared RP and admin journal

`rp_post` accepts a narrative up to 12,000 Unicode characters and one to eight
distinct partner character IDs in the author's current area-chat room. Active
presence, controller, revision, dungeon edition, account blocks and mutes apply.
The durable command receipt prevents duplicate posts/counts; an account can post
once per ten seconds. Unicode letters/numbers form words (internal apostrophes
and hyphens stay in a word). Trimmed, sanitized prose retains paragraphs; character
counts include spaces and newlines. Only the author earns review credit.

`rp` snapshots carry small summaries, valid partners and writing totals. `rp_read`
loads a full post and its captured public paperdoll in the receipt without changing
character revision. Authors/selected partners can reread after moving; others need
to be in the original area. Blocked posts are hidden. Area chat uses a server-owned
`rpId` link and the yellow notice "<name> posted an rp"; OOC receives no notice.

Authenticated `/gm/rp` supports `search`, `character`, and zero-based `page`, with
25 narratives per page and recent award history. `/gm/action` `rp_award` requires
`character_id`, `expected_awards`, `expected_level` and a review `reason`. Staff
must review 1,000 words initially, +500 for each previous RP level awarded. Awards
give exactly one ordinary level, preserving existing XP and applying HP/stat points
and mage spell unlocks. No automatic RP XP is paid. Any level change resets current
word/character counters; lifetime totals and narratives persist. Award receipts in
`quest_rp_awards` retain reviewer, target, words, characters and level transition.
Transactions and expected-version checks reject stale/double awards.

The schema is additive: `quest_rp_posts`, `quest_rp_partners`, `quest_rp_progress`,
and `quest_rp_awards`; no map regeneration or tracker proxy change is required.
Deploy this service before the GX client. Verify with
`node --test test/roleplay.test.mjs test/gm.test.mjs` and the game's `--rp-only`
two-client browser fixture. The existing short chat cleanup never deletes RP prose.

## Frostveil Taiga

`dive-taiga` / `frostveil-taiga` adds an 80×80 weekly region with Forest and Tundra
enemies, their authored spells/DEX, and both native scenery pools. Its only entrance
is the north-center Tundra trail (50,1). The Taiga southern exit (40,78) and manual
retreat lead back to Tundra; no hub or Dive Hall offers a shortcut. Crossings use
the existing command transaction and party transfer, retaining route-scoped claims,
fog, equipment and replay receipts. Reconnect resumes the branch; weekly reset
returns to the original hub through the normal recovery rules.

Export the game's `taiga.json` and `online_taiga.json` with
`python/export_online_taiga.py`. Deploy `server/taiga-data.json`,
`server/wilderness-links.mjs`, and the updated service modules before the rebuilt
client. Existing Tundra maps gain the trail additively and publish `geometryVersion`
for live collision/minimap refresh; never delete weekly maps or progress to apply it.
The new route otherwise uses the Monday 04:00 Pacific lifecycle. Run
`node --test test/taiga.test.mjs test/tundra.test.mjs`; the game browser fixture
`--taiga-only` exercises two real clients, mixed terrain and both return controls.

## Enemy ATB variation

Shared encounter player cards now receive `mp` and `maxMp` from each character's committed loadout. Reads never mutate or refill mana. Deploy the service before the rebuilt client for current/max MP on all party cards; newer clients can still display their own MP against older services using the local loadout.

All authored enemy catalogs now export explicit `dex`: 1–14 by species, with Guardian Iris at 8. The game Enemies editor exposes DEX (ATB), while Iris is in Dungeon Dive > boss.dex. After edits, run `export_online_dive.py`, `export_online_desert.py`, `export_online_tundra.py` and `export_online_campaign_dives.py` (Quarters must precede campaign Dives). Deploy all four generated catalogs and restart the service. New encounters use the stats; already-persisted encounters retain their captured values. Weekly floors need no reset and existing clients already read the server timers.

Shared Dive enemies independently reroll their Dexterity-derived delay each cycle within the existing min/max limits. `enemy_delay_variance` defaults to 0.2 (±20%); `enemy_initial_stagger_ms` adds 400 ms per roster index to opening and service-restart timers only. Occasional coincident attacks remain possible. Player timing and arena turns are unchanged. Persisted `duration`/`readyAt` keep reads and reconnects stable; restart grants staggered recovery without replaying missed attacks.

Edit the corresponding `online_*` fields in the game's Combat Tuning editor and run `python/export_online_combat.py`. Deploy the updated service and `server/combat-data.json`, then restart; existing clients already display variable timers. No client rebuild, database migration or weekly reset is required. Verify with `node --test test/parties.test.mjs`.

## Dive defeat equipment

Dive defeat, submission and failed charm apply the opponent's authored first/repeat outfit once during settlement. Shared battles affect only losing members, using their actual defeat opponent. Export Enemy Data kits and item definitions with the game's `python/export_online_combat.py`, then deploy `server/combat-data.json` with this service before updating the client. No database migration or weekly floor reset is required.

Displaced gear retains its exact item data; equipment bonuses, dress mirrors and diaper state update through the equipment helper. Cursed slots, insufficient bag room and retired item IDs skip individual pieces with a settlement log message. No sale rights are minted for forced items. Durable encounter receipts and advancing loadout revisions protect reconnects and stale campaign imports. `lastResult.defeatEquipment` reports the selected variant and per-item results; client defeat scenes only present them. Run `node --test test/defeat-equipment.test.mjs test/dive.test.mjs test/parties.test.mjs test/companion-equipment.test.mjs` for focused coverage.

## MommyBot online announcements

Set a dedicated `MOMMYBOT_ONLINE_TOKEN` (32-128 URL-safe random characters) to
enable `GET /integrations/mommybot/joins?after=0&limit=20`. Only server-to-server
Bearer authentication with this secret is accepted; game wallet tokens and
browser Origin requests are rejected. The feed returns a persistent `stream`
UUID, ascending `events` (`id`, `name`, `joined_at`, numeric `online`),
`latest_cursor`, `next_cursor` and `has_more`. Names are character names; no
account IDs, credentials, chat, inventory or care events are exposed.

Authenticated gameplay commits record account arrivals atomically with presence.
Heartbeats, room changes, character switches and reconnects within two minutes
do not repeat announcements. Companion/cloud reads and character creation do not
announce. Events persist for seven days. Disabled configuration emits no events.
No GameMaker client rebuild is required.

Configure MommyBot with `LIDOLLMMO_ONLINE_ENABLED=true`, the same token,
`LIDOLLMMO_ONLINE_URL=http://127.0.0.1:4191/integrations/mommybot/joins` (or this
server's private LAN address), and channel `1550612967253352528`. Restart both
services. The bot starts at future arrivals, checks every ten seconds, skips
offline/stale joins, pings the destination server's **lidollmmo** role, and saves delivery progress. See MommyBot's
`MMO_ONLINE_GUIDE.md` for setup, permissions and limitations.

Run `node --test test/online-feed.test.mjs test/service.test.mjs` to verify the
protected feed, signed-in joins, command replay, heartbeats and reconnects.

Crawling now persists as a recoverable stance. Hub and Dive movement enforce a 400 ms minimum while crawling (200 ms standing); shared NPC clocks remain unchanged. Physical damage is reduced 25%, with a minimum of one. The `stand` action costs one ordinary combat turn or shared action-gauge cycle and needs no enemy target. Exhaustion or equipped `forces_crawl` definitions reject standing without spending an action. The campaign client supplies its two-stamina crawl recovery during the existing prepared-turn needs commit.

Enemy `enemy_stat` spells can apply `stat_effect: "crawling"`; combo effects accept `type: "crawling"`. The game exporter adds `crawl_equipment` to `combat-data.json`, including the opt-in Cursed Crawling Anklets example. Deploy refreshed combat, campaign-Dive and hub definitions with the service and rebuilt client. Existing save flags/receipts are reused; no database migration is required. Combat, party and world tests cover recovery, replay and movement boundaries.

## Gamemaster panel

`GET /gm` is the staff moderation surface. Access is granted by LiDollID identity,
not by a shared secret: the operator signs in with their own account and it must
hold the `gamemaster` role in Little Log user management. There is no panel token
to distribute, rotate or leak, and every action is recorded against the account
that performed it. Set `LIDOLLQUEST_GM_ENABLED=false` to remove the surface
entirely.

### MommyBot account matching

The tracker hashes `client_id + ":" + owner`, so MommyBot's `lidollbot` wallet ID
must never be used directly as `quest_characters.owner`. Updated MommyBot first
calls the tracker's authenticated `GET quest-account?client_id=lidollbot` and
uses the returned `lidollquest` account ID for `/integrations/mommybot/character`.
Deploy the Little Log tracker bridge before MommyBot. Existing character rows,
wallet IDs and clients need no migration or rebuild. Keep the existing shared
`MOMMYBOT_ONLINE_TOKEN` on the game and bot services.

`node --test test/mommybot-tracker.test.mjs test/mommybot-profile.test.mjs` checks
both real app-specific IDs against an existing character, cross-account denial,
revocation and simulated showcase messages. The integration test uses sibling
`omo-trainer` and `MommyBot` checkouts (override `TRACKER_ROOT`/`MOMMYBOT_ROOT`).
The read-only owner diagnostic expects the translated game ID, not the bot ID.

### Paperdoll portraits

`/integrations/mommybot/character` returns `portrait_png` (base64) and
`portrait_size` alongside the inspection sheet. The service composites the
character itself, from the same authored sprite layers the companion client draws
in `paperdoll.js`, so the Discord post and the in-browser preview show the same
character.

Two constraints shaped this. The service has no dependencies and no `node_modules`,
so a native canvas was not an option: `server/png.mjs` is a stdlib decoder and
encoder built on `node:zlib`, deliberately narrow to 8-bit RGBA non-interlaced PNG,
which every exported layer is. Anything else is refused loudly rather than decoded
approximately. `server/paperdoll.mjs` holds the layer order, ported line for line
from the companion; **if one changes, change the other.**

There is no item-to-sprite lookup table. An equipped item resolves to
`sprTQ_<item_id>`, so artwork is discovered by name and new items need no mapping.
Missing artwork is skipped rather than drawn wrong, and only names present in the
exported manifest are ever opened, so an item id can never reach the filesystem.

Artwork lives in `server/paperdoll-assets/` (1,540 layers, ~25 MB, committed) and is
produced from the game checkout:

```
python python/export_paperdoll_assets.py --server-root <this repo>
```

It exports at half scale, giving a 194x438 portrait that Discord renders inline at
full size while costing a quarter of the compositing work. A deployment without the
assets serves every other field and omits the portrait rather than failing.

Renders are cached per `character_id` + `revision`, and decoded layers in a bounded
LRU, so a re-view is free and repeat characters are cheap. Measured: ~70 ms cold,
~26 ms warm, 0.01 ms cached. That is synchronous work on the event loop, so it is
visible in the `/gm` performance panel under sustained first-time views.

Run `node --test test/paperdoll.test.mjs test/mommybot-profile.test.mjs`.

### Live curse and blessing tuning

The panel's **Curses & blessings** section edits the shared enchantment table that
every dive route rolls against. It is behind the same live LiDollID gamemaster
identity, address, origin and TLS rules as moderation, and every write is recorded
in `gm_audit` against the account that made it.

The shipped table arrives in `dive-data.json`, exported from the game checkout's
`datafiles/generation/enchantments.json`. That baseline is never written to at
runtime. Overrides live in `gm_enchant_tuning` and `gm_enchant_entries`, and
`server/enchantment-store.mjs` layers them on top:

- **Rates** - the eleven numeric knobs, chiefly the two ramps. Curse chance falls
  as item rarity rises; blessing chance climbs. The panel previews the resulting
  per-tier rates and warns if a change stops the curse rate falling.
- **The table** - edit a shipped entry, retire it, or write a brand new curse or
  blessing with its own garment gate, rarity band, proc and stat changes.

Every field is validated server-side before storage, so a malformed entry is
refused at the panel rather than reaching a live dive: ids must be unique and
lowercase, slots must be real item categories, a proc cannot fire faster than
every 30 steps, stat changes are bounded to +/-200, and a movement lock must leave
at least a 5% escape chance. A shipped entry is **retired**, not deleted, because
the next content export would otherwise bring it back.

Edits reach the next chest on every route without a restart: the loot roller
watches a revision fingerprint and rebuilds when it changes. Loot a player already
holds is served from their visit's own receipts and is never rewritten. `enchant_reset`
discards every override and returns to exactly what the last content export shipped.

Run `node --test test/enchantment-store.test.mjs test/enchantment.test.mjs test/gm.test.mjs`.

### Area and global OOC chat

Snapshots retain room-scoped `chat`/`chatArea` and add `globalChatSupport: true`
plus a separate `globalChat` array. Both histories have channel metadata, shared
sequence IDs, a 40-message visible limit, a 100-row stored limit per stream, and a
24-hour visibility window. Global speech uses `quest_chat.zone = 'global:ooc'`
across all active multiplayer areas; it is never a movement destination.

Send `{action: "chat", channel: "area" | "global", text: "...", ...}` through the
ordinary authenticated, revision-checked command route. Omitting `channel` retains
legacy area behavior. `both` is a client viewing option, not a destination: each
message targets exactly one stream, and receipt replay cannot duplicate it.
Dungeon commands retain their edition check. Presence/controller checks, blocks,
mutes and the shared five-messages-per-ten-seconds budget apply to both channels,
including dungeon speech. Activity announcements stay local. Gamemasters can select
**Global chat (OOC)** in the existing chat filter and remove messages there.

The GX action log's top-right button cycles Area / Global (OOC) / Both. Its permanent
bottom input keeps history visible while typing and has an **Area / OOC** selector
in Both mode. Click or press T to focus, Enter/Send to submit, Escape to release
focus without losing the draft. Global log entries receive
`ooc: ` before the speaker and render baby blue (`#89CFF0`); channel metadata
controls the colour, never player text. Area speech keeps its existing colour.
Deploy this service before the rebuilt GX client. Old clients stay area-only;
new clients refuse OOC sends when the server does not advertise support.

Run `node --test test/global-chat.test.mjs test/dive.test.mjs test/gm.test.mjs`.
The game checkout's GX browser fixture supports `--global-chat-only`.

### Recorded server performance

The `/gm` panel includes **Server performance**, backed by the same live LiDollID
gamemaster checks as moderation. `GET /gm/performance` is read-only and also obeys
the panel's address, origin and TLS rules. `/health` remains a simple availability
probe and exposes no statistics.

The service records one aggregate sample per minute into `server_performance_samples`
in `quest.sqlite`, even while nobody has the panel open. It retains at most 1,440
samples from the last 24 hours, including across restarts. A graceful shutdown also
records a partial interval of at least one second. The panel refreshes the current
interval every ten seconds and charts the last hour or last day; restarts and missed
intervals appear as gaps. Each sample carries its actual duration and process session.

- Process CPU: **100% is one occupied core**, not 100% of the host. Native/background
  threads can take process CPU above 100%. Available CPU parallelism is also shown.
- Event-loop utilization, delay p95/max (20 ms timer sampling), resident/heap memory.
  An idle loop normally has a delay near the sampling resolution; loop utilization
  can include synchronous waits and is not itself CPU usage.
- Gameplay request throughput, active/peak requests, mean/max response time, 4xx/5xx,
  429 throttles and disconnects. Health probes and staff traffic are excluded from
  these request counters; process CPU still includes the entire service.
- Expand **Work timings by operation and zone** for current or latest recorded calls,
  total/mean/max elapsed milliseconds and thrown errors. Simulation, generation and
  pathfinding are grouped by authored zone; snapshots, zone actions/reads, response
  JSON encoding and gameplay account authentication/debits/credits are also timed.

Timings include elapsed waits and nested scopes overlap. Do not add their totals or
treat network latency as CPU time. Synchronous scopes include SQLite reads/writes;
this is not a per-query profiler. No tokens, player IDs, chat, paths supplied by
players or request bodies are recorded. Timing labels have a fixed memory ceiling.
Old detailed scopes stay in the bounded database history; the panel downloads detailed
timings only for the latest recorded interval and the current interval.

A failed history write leaves gameplay running and displays a recording warning;
a failed panel refresh marks displayed readings stale. Removing the operator's role
returns them to sign-in. Deploy the quest service to enable this feature; no tracker
deployment, content export, editor schema change or GX.games rebuild is needed.

Run `node --test test/performance.test.mjs test/gm.test.mjs` for calculations,
retention, restarts, rejected/disconnected requests, failed writes and access checks.
The game checkout's `node python/tests/fixtures/gm_performance_browser.mjs` checks
the real panel with synthetic identities/history and writes desktop/mobile captures
under `build/gm-performance-browser/`. Synthetic chart data is not a capacity benchmark.

### Granting the role

In the Little Log admin console, User management now offers **Gamemaster**
alongside Participant and Admin. The role is deliberately narrow: it unlocks this
panel and nothing else. A gamemaster cannot open the Little Log console, read or
export anyone's records, moderate the social timeline or send notifications —
those remain `admin`. Administrators hold gamemaster implicitly, so the job can be
delegated without handing over the whole console. Changing or disabling the role
takes effect on the operator's very next request, because identity is revalidated
with LiDollID on every staff call rather than cached in a session.

### Signing in

The panel runs a LiDollID device authorisation, the same flow the native game
uses. It shows a user code and a link to the approval page; the operator approves
it from any signed-in Little Log session and the panel receives a `wallet:read`
grant. That scope carries identity alone: the panel can never move coins, read
cloud saves, touch social data or act as a character. An approved account that
lacks the role is refused at the moment of sign-in, so the page never holds a
session it could not use. The grant lives in tab memory only and is never written
to storage. The service proxies both sign-in steps, so the operator's browser
never talks to the tracker directly and no CORS entry is required.

### Reaching a headless server

The service host has no browser, so the panel is opened from another machine and
`HOST` must be an address that machine can reach. Set `HOST` to the server's LAN
address (or `0.0.0.0` for every interface) and restrict who may use the staff
routes with `LIDOLLQUEST_GM_ALLOW`: comma-separated IPv4/IPv6 addresses and CIDR
blocks, for example `10.1.1.23` or `10.1.1.0/24`. An unlisted caller receives 403
`gm_forbidden_address` before the page is served and before any identity is
considered. A malformed entry throws at startup rather than silently admitting the
network. Leaving it unset applies no address restriction, leaving the gamemaster
role as the only barrier. The allowlist covers `/gm` alone; gameplay, `/health`
and the join feed are unaffected.

The comparison uses the socket's own address, correctly handling the
`::ffff:10.1.1.23` form a dual-stack bind reports.

### Behind a reverse proxy

Set `LIDOLLQUEST_GM_TRUST_PROXY` to the proxy's address (IPs and/or CIDR blocks).
Only a caller matching it has its `X-Forwarded-For` and `X-Forwarded-Proto`
believed; from anyone else both headers are ignored entirely, so a client cannot
forge an operator address or claim a secure channel. The real caller is resolved by
walking the forwarded chain from the right and taking the first hop that is not one
of our own proxies. With no proxy declared, the socket address is used and
forwarded headers never matter.

`LIDOLLQUEST_GM_REQUIRE_TLS=true` then refuses `/gm` — the sign-in page included —
with 403 `gm_insecure_transport` unless the request reached the operator over
HTTPS. A request is considered secure when this process terminated TLS itself, or
when a trusted proxy reports `X-Forwarded-Proto: https`. Without a trusted proxy
configured, nothing can satisfy it, which is deliberate: the flag is meaningless
without a terminator in front. Set both together.

This matters because the operator's grant travels in an `Authorization` header and
stays valid for thirty days. Anyone who reads it off the wire holds working
gamemaster access, and the role check cannot tell them apart from the real
operator. Restrict the service port to the proxy so the plaintext listener cannot
be reached directly:

```sh
sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="10.1.1.20/32" port port="4191" protocol="tcp" accept'
sudo firewall-cmd --reload
```

A private LAN with no proxy is a reasonable place to leave both settings unset. An
SSH tunnel (`ssh -L 4191:127.0.0.1:4191 host`) with `HOST` on loopback remains the
lightest option when the panel is needed only occasionally.

### nginx

Terminate TLS at the proxy and forward the whole `/gm` prefix. The service needs
both forwarded headers; `X-Forwarded-Proto` drives the TLS requirement and
`X-Forwarded-For` drives the address allowlist.

```nginx
server {
  listen 443 ssl;
  http2 on;
  server_name gm.lidoll.example;

  ssl_certificate     /etc/letsencrypt/live/gm.lidoll.example/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/gm.lidoll.example/privkey.pem;

  location /gm {
    proxy_pass http://10.1.1.21:4191;          # the LiDollQuest service
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header Origin            "";      # the panel is same-origin to itself
    proxy_read_timeout 30s;
  }

  location / { return 404; }                    # nothing but the panel is published here
}

server {
  listen 80;
  server_name gm.lidoll.example;
  return 301 https://$host$request_uri;
}
```

Clearing `Origin` matters: the service rejects a cross-origin `Origin` on staff
writes, and the browser sends the public hostname while the service sees its own.
Removing the header leaves the same-origin path, which the bearer credential
already makes safe. `$proxy_add_x_forwarded_for` appends the real client to any
existing chain, which is what the right-to-left walk above expects. Publish only
`/gm`: the gameplay API authenticates its own callers and does not belong on this
hostname.

### Routes

`GET /gm` serves a single self-contained page with no external assets; the shell
carries no player data. `POST /gm/signin/start` and `POST /gm/signin/poll` run the
device authorisation and are the only unauthenticated routes, bounded by a
per-caller attempt ceiling. Everything below requires a live gamemaster identity.

`GET /gm/overview` returns `serverTime`, every room with its live occupancy, the
current player roster, sanctions in force, the last fifty gamemaster actions with
their actor, and account/character totals. `GET /gm/chat?zone=&limit=` reads shared
area chat, tagging automatic care announcements as `activity` rather than hiding
them. `GET /gm/player?owner=` or `?character_id=` summarises one account: its
characters, live presence, sanctions, recent messages and the actions taken against
it. Character summaries carry only flat values, never inventory, equipment or
credentials. `GET /gm/whoami` reports the signed-in account.

`POST /gm/action` takes `{"action":...}` with one of:

| Action | Effect |
| --- | --- |
| `kick` | Drops the presence row. The client's next command returns 409 and the player re-enters. The character is untouched. |
| `warp` | Moves a live player to another hub room, arriving on its declared spawn tile. Refused during a run or Dive, and Dives are never destinations. |
| `mute` / `unmute` | Withholds the `chat` command only. Movement, combat, trade and Dives continue normally. |
| `suspend` / `unsuspend` | Refuses every authenticated route with `account_suspended` (zones, cloud saves and character management alike), drops the session immediately and removes the player from other rosters. Local campaign saves are untouched; cloud sync simply pauses until it is lifted. |
| `broadcast` | Posts an announcement into a room as an activity line, which clients already render apart from player speech. |
| `delete_chat` | Removes one message by `seq`. |

Sanctions take `minutes` (0 records an indefinite one) and an optional `reason`.
Expired sanctions clear themselves on the next lookup, so no sweeper is required.
A gamemaster cannot mute or suspend their own account. Every action writes a
`gm_audit` row naming the acting account, the target, the detail and the reason.
The panel never reads wallet credentials, never writes character inventories and
never mints coins.

Account identifiers shown in the panel are the per-app pseudonyms LiDollQuest
already uses (`sha256('lidollquest:' + participant)`). This service cannot resolve
them to a Little Log participant, and the panel deliberately does not try.

Two tables are created on first start: `gm_sanctions` and `gm_audit`; an existing
`gm_audit` gains its `actor` column automatically. Deploy the updated tracker
before this service, because the role decision travels on the wallet response. No
weekly floor reset or GameMaker client rebuild is required, and the mute and
suspension messages are ordinary rejection text existing clients already display.
Verify with `node --test test/gm.test.mjs`.

## Unified accounts and cloud campaigns

### Character and save management

`POST /characters/action` requires `saves:write`, owned `character_id`, current character `revision` and a stable `request_id`. Actions are `rename` with `name` (5 stars), `appearance` with an allowlisted paperdoll `appearance` object (1 star), and `delete` with `confirm` equal to the current character name. Paid actions require `stars:write`. Class/stats/equipment and NPC world sprites are excluded from makeovers; the existing sprite-change action stays free. Exit shared rooms and finish pending encounters/turns/shop purchases before management.

`quest_management` freezes validated requests before wallet debits, blocks character gameplay during settlement and retries the same operation after reconnect/restart. Names and paperdoll appearance are locked after the first campaign import, then changed only through paid management. Character deletion removes its bank, provenance, personal dungeon progress, cloud versions and staged uploads. Tombstones prevent old creation requests from resurrecting it. Account currencies, friendships, reward caps, financial receipts and earned outbox payouts remain intact.

Cloud management uses `/cloud/action` with `base_revision` equal to `head_revision`, stable `request_id` and owned `character_id`: `rename` takes version `revision` and a 1–48 character `label`; `delete` takes the version revision; `clear`, `pause` and `resume` operate on the whole character history/sync setting. Clearing the last version pauses uploads until explicitly resumed. Labels are free metadata and never rewrite campaign blobs. Deleting the newest version promotes the newest survivor; `head_revision` still advances. Downloads and history expose this head separately from the immutable version revision. Empty histories return `empty: true` metadata instead of a download. List responses include per-character `settings` for pause status and head revision.

Management changes invalidate staged chunks. Monotonic heads and persistent upload receipts prevent stale devices and retries from republishing removed versions. Three retained versions are counted independently of revision gaps. Back up `quest_cloud_heads`, `quest_cloud_receipts`, `quest_management` and `quest_deleted_characters` along with the existing database. No new environment variables are required. Deploy the tracker gateway first, then this service, then the rebuilt game. Snapshots advertise `saveManagement` and `characterManagement` capabilities.

Deploy the updated Little Log tracker/auth gateway and this service before the rebuilt game. Zone snapshots advertise `capabilities.unifiedCreation`, `inspection`, `friends` and `cloudSaves`; older currency-only grants continue to work for gameplay. New endpoints require explicit `social:read` or `saves:read/write` consent, validated through the wallet authority on every request.

`create` optionally carries bounded regular-creator `creation` choices, protected by its durable creation request ID. Five characters per account remain the limit. The next campaign import reconciles the character name without replacing its ID. Little Log account display names are separate from character names.

`GET /zones/inspect?character_id=...&target=...&controller=...` requires owned live presence and a live target in the same area; dungeon editions and room/corridor chat areas must match. The response contains only allowlisted appearance/status fields and known equipped item IDs/names, plus the Little Log relationship fetched through its social API. Export `server/profile-items.json` using the game's `python/export_online_profiles.py --server-root <checkout>` after item edits. Friend mutations remain entirely in Little Log.

Cloud storage lives in this service's SQLite database. `GET /cloud` lists current previews. Add `character_id` to read current metadata, `history=1` for the three retained versions, or `revision` and zero-based `part` to download base64 chunks. `/cloud/action` accepts:

1. `begin`: `character_id`, stable `request_id`, `base_revision`, assembled UTF-8 `bytes`, and lowercase SHA-1 `checksum`.
2. `chunk`: the same character/request IDs, zero-based `part`, and base64 `data` (128 KiB decoded, except the final chunk).
3. `commit`: the same IDs. Publication validates owner, format envelope, completeness and checksum in one transaction. Retries of a committed request return its receipt.

The SHA-1 digest matches GameMaker's UTF-8 checksum primitive and detects transfer corruption; the browser computes it asynchronously with WebCrypto. Authorization comes from grants and ownership checks. One private staged upload per account is retained for at most 24 hours. A second device receives `cloud_upload_busy` and waits instead of erasing an active transfer. `QUEST_CLOUD_MAX_BYTES` defaults to 67108864. Each character retains its current save and two prior revisions. Revision divergence returns `cloud_conflict`; only an explicit user choice should retry against a newer base. Never merge room worlds automatically.

Saves contain campaign worlds, quests, companions, difficulty, local gold and the ordinary migration version. They exclude credentials, shared balances and copied online rooms. `online_revision` on entry rejects future revisions and restores committed inventory/status when a restored campaign predates the last loadout change. Banks, fights, shop provenance, chests, rewards and payout tables are not part of cloud storage and cannot be restored from it. Back up the entire Quest database, including the new `quest_cloud_*` tables.

Run `npm test` and the game checkout's `ps/Test-OnlineZones.ps1 -AccountsOnly`. The account fixture uses two linked users and a fresh browser context, inspection with different appearances, Little Log acceptance, cross-device restore, conflicting saves and recovery. Run the full arena/dungeon fixture and save/editor regressions for release.

## Weekly Dungeon Dive

Scenery/loot v2 adds full campaign furniture footprints, one weighted potion and
one extra random treasure per non-entry room, alongside each personal weekly chest.
The active edition receives this dressing once without changing walls, chest
claims, fights or reward entitlements; saved visitor positions remain clear.
Watch `dive_dressing_upgraded` / `dive_dressing_failed` in the journal. Failure
retains the previous floor and retries after a minute. Deploy the matching rebuilt
game after the service so it renders full-size scenery below actors and supports
pickup interaction, movement collision, collection feedback and minimap markers.
Loot remains independent per character; full inventories leave it unclaimed.
Room chests and loose pickups both collect on movement contact; adjacent Interact
remains available. Replaying a move or stepping on a claimed chest cannot grant it twice.

Rose Court alone offers the shared Princess' Quarters pilot. The server
generates a validated floor on Monday at **04:00 America/Los_Angeles**, respecting
DST. Generation catches up after downtime without creating skipped editions.
The pilot ends with Guardian Iris; route/edition/depth keys support later themed
descents without implementing infinite floors yet.

Fairies roam once per second and pursue within six walkable steps; mimics and
Iris are stationary. Each non-entry room contains two enemies and one chest.
Fights reserve an enemy for one character. Normal/boss respawns take ten/five
minutes. Loot and XP persist immediately; defeat restores quarter HP at entry.
Disconnect grace is two minutes and combat inactivity expires after five.
At weekly reset, idle visitors return to their entrance lobby; active fights
have a maximum ten-minute grace, including settlement of their earned reward.

Each character claims each chest once per edition. The first Iris victory earns
50 coins within the existing account-wide 1000-coin UTC daily cap. Any capped
remainder stays explicitly claimable until edition retirement. Delivered rewards
use the existing transactional outbox and stable wallet receipt IDs.

`GET /zones` retains existing fields and adds `dive` metadata. While inside, the
zone list includes `dive-quarters` geometry/decoration and `dive` includes enemies,
personal exploration, chest claim status, reset time and outstanding boss coins.
`POST /zones/action` adds `dive_enter`, `dive_exit`, `dive_engage` (`encounter`),
`dive_claim` (`chest`) and `dive_claim_reward`. Commands made inside the dive must
carry its `edition`; heartbeat retains the existing presence protocol. Existing
move/chat/combat/inventory/stat commands work in the dive and keep ownership,
controller/revision checks and command receipts. Entry is from either lobby;
`enter` with `zone: "dive-quarters"` resumes a saved visit without importing stale
client inventory. An expired weekly visit resumes at its originating lobby.

`dive_editions` and `dive_progress` are additive SQLite tables. The floor and
claims persist across restart. Failed generation retains the last valid edition
without refreshing its claims, logs a failure and retries after one minute.

Authoring lives in the game's **Zones > Dungeon Dive** editor panel. Export with
`python python/export_online_dive.py --server-root C:/Scripts/Lidollquest-server`
from the game checkout and deploy `server/dive-data.json` with this service.
`config.enabled` gates new entries. The pilot defaults to enabled; set it false
to disable new entry while allowing existing visitors to leave. Keep the route
ID stable for existing visits. Quarters dimensions support 24–128 tiles per axis,
1–6 enemies per room and BSP depth 1–5; only the Quarters theme is available now.

Run `npm test`, then the game's `ps/Test-OnlineZones.ps1`. Deploy this service
first using the existing Fedora installer, then publish the rebuilt game.
No tracker route, nginx or scope change is necessary. Check both lobby entrances
and a chest/fight after deployment. Watch `journalctl -u lidollquest-server` for
`dive_generation_failed`, `dive_tick_failed`, `dive_encounter_abandoned` and
`quest_reward_delivery_failed`. Logs contain no wallet credentials.

The arena-specific behavior below remains unchanged.

A standalone Node 24 service for **two online zones**:

| Hub | Zone | Fight rule |
| --- | --- | --- |
| Honeydew Village | Lantern Court | Recover some HP between rounds |
| LittleBig City | Clockwork Coliseum | Every third enemy turn hits harder |

Each zone has a shared lobby with synchronized avatars and chat. Arena runs are
individual, eight-round progressive fights: attack, guard or use inventory; bank after a
win or accept a random handicap and continue. Defeat/forfeit loses the unbanked
pot. Round eight automatically banks it. Each cleared round adds `5 × round`
coins to the pot. Banking is capped at **1000 coins per account per UTC day** across
all characters/zones; runs can still be played after the cap. The allowance is
`config.daily_coin_cap` in `server/hub-data.json` (exported as `DAILY_COIN_CAP`
from `server/hubs.mjs`), shared by arena banking, dungeon bosses and item sales,
and it also bounds any single wallet entitlement. New runs have a
one-minute entry cooldown per character.

The service imports client-trusted campaign HP, stats, equipment, inventory and MP.
Local gear and mods can affect combat strength by design. The server runs arena
turns, enemies, randomness, progression and shared-currency awards; imported
gold or wallet balances never modify shared currency. Legacy clients without a
loadout retain the old fixed template.
Characters keep their arena history independently of the local campaign save.

## Service boundary

This process and `DATA_DIR/quest.sqlite` are separate from Little Log. The quest
database owns characters, presence, chat, command receipts and a reward outbox.
Little Log continues owning LiD0llID integration and the shared wallet ledger.
Game browser requests use a thin authenticated gateway in the tracker so existing
HttpOnly cookies and CSRF protections remain intact. No gameplay simulation or
quest database lives in the tracker.

```text
Game → authenticated tracker gateway → LiDollQuest service
                                      ↓ signed verified reward
                               Little Log wallet API
```

`GET /zones` lists zones and the account's roster; `?character_id=ID` also returns
that character's zone snapshot. `POST /zones/action` accepts a stable `request_id`,
per-window `controller`, `character_id` and expected `revision`. Actions are
`create`, `enter`, `heartbeat`, `move`, `chat`, `start`, `attack`, `guard`, `heal`,
`continue`, `cashout`, `flee`, `leave`. Creation additionally takes `name`; entering
takes `zone`; movement takes a cardinal `direction`; chat takes `text`. Unknown
fields and caller-selected rewards are rejected. Campaign stats are accepted only
inside the bounded `loadout` payload.

The tracker exposes these through both its existing `lidollcoin/v1/zones` bearer
routes and `lidollcoin/browser/zones` cookie routes. The standalone API accepts
only bearer authentication and rejects browser Origin requests. Native grants
are validated against the fixed `lidollquest` wallet client; client IDs and
character IDs cannot select another account's identity.

## Run locally

1. Install Node 24 or later. No third-party runtime packages are required.
2. Copy `deploy/server.env.example` to a private `.env` and set wallet connectivity
   and the reward key. Never commit or package that key with the game.
3. Set tracker `LIDOLLQUEST_API_URL=http://127.0.0.1:4191/` when both processes run
   on the same host. Keep the trailing slash. Use the actual private interface if
   the services are on different hosts.
4. Start with `node --env-file=.env server/main.mjs`.
5. Run `npm test`. With an adjacent tracker checkout, the cross-service test also
   runs; otherwise set `TRACKER_ROOT` to its directory.

`GET /health` reports process availability. It does not test wallet connectivity.

## Fedora deployment

Run these commands on the Fedora service host from a copy or checkout of this
repository. The installer deploys that local copy; it does not fetch a remote
repository. It requires Fedora with systemd and enabled repositories providing
`nodejs24` (`/usr/bin/node-24`). No npm install is needed.

### First install

1. Prepare the service account, private configuration and Node prerequisites:

   ```sh
   cd /path/to/Lidollquest-server
   sudo bash deploy/fedora-deploy.sh --init-only
   sudoedit /etc/lidollquest/server.env
   ```

   Set `LIDOLLCOIN_API_URL` to the tracker's wallet API. The example assumes
   both services share a host. The tracker may instead listen on its LAN address;
   use that address if it does not listen on loopback. Keep the trailing slash.
   Set `HOST` to the interface the tracker can reach and keep `PORT=4191`.
   The installer requires `DATA_DIR=/var/lib/lidollquest-server`.

2. On a shared host, provision the matching **server-only** reward key with the
   updated tracker helper (adjust its checkout path if needed):

   ```sh
   sudo /usr/bin/node-24 /opt/lidoll/current/scripts/configure-reward-authority.mjs \
     --tracker-env /etc/lidoll/tracker.env \
     --bot-env /etc/lidollquest/server.env \
     --client lidollquest
   sudoedit /etc/lidoll/tracker.env
   ```

   Add `LIDOLLQUEST_API_URL=http://127.0.0.1:4191/` to the tracker environment
   (use the actual private service address on separate hosts). The helper calls
   its second destination `--bot-env`; it also works for this service. It
   preserves other clients' keys and existing file ownership/mode, and prints
   no keys. If reusing an older environment file with a blank
   `LIDOLLCOIN_REWARD_KEY=` line, remove that blank line before provisioning;
   older tracker helpers can mistake it for an existing key. On separate hosts,
   securely configure the same key in the tracker's
   `LIDOLLCOIN_REWARD_KEYS.lidollquest` entry and the quest service's
   `LIDOLLCOIN_REWARD_KEY`; do not put it in the game or repository.

3. Deploy matching tracker gateway/security code, then start the services:

   ```sh
   sudo systemctl restart lidoll-tracker
   sudo bash deploy/fedora-deploy.sh
   sudo systemctl status lidollquest-server --no-pager
   sudo journalctl -u lidollquest-server -n 50 --no-pager
   ```

   The installer enables this standalone service at boot. Test a linked
   character entering an arena and banking a reward afterward; `/health`
   verifies the quest process, not wallet connectivity or key agreement.

### Updates and recovery

Update your source checkout (for example, `git pull --ff-only` if you have
configured a remote), then run this **from that updated checkout**:

```sh
sudo bash deploy/fedora-deploy.sh
```

Each run tests a new immutable release under `/opt/lidollquest-server/releases`
as `nobody`, then stops only the quest service, creates a private backup under
`/var/backups/lidollquest-server`, and atomically switches `current`.
Tests use separate temporary data; the optional tracker integration test skips
when no adjacent test checkout is available. Running the installer from the
installed `current` directory redeploys that same code; it does not download
updates. Existing configuration and persistent data are preserved.

If startup or health verification fails, the installer restores the previous
code pointer and running state. Backups and old releases remain for review.
It does **not** automatically restore SQLite: doing so could discard live
rewards already committed to the shared wallet. Schema-incompatible upgrades
need a planned migration/recovery procedure. There is a brief service interruption
while the stopped database (including WAL files) is backed up and code switches.
Check `journalctl -u lidollquest-server` if recovery itself fails.

Paths are fixed to the sample service unit. An existing manually installed
`current` directory or modified main unit is rejected before stopping the
service; migrate that installation explicitly. Use `systemctl edit
lidollquest-server` for compatible service overrides. Firewall and nginx
configuration, tracker restarts, and tracker key provisioning are explicit
operator steps; the installer does not change those services.

Deploy the rebuilt GameMaker client after both services are configured. The
existing `/tracker/` reverse-proxy location carries zone traffic; no WebSocket
upgrade or new public nginx location is needed. Short polling requests use the
existing gateway. Bind the quest service to loopback on a shared host, or a
firewall-restricted private interface between hosts.

## Persistence, retries and limits

- Online characters are account-owned, with up to five per account. Client save
  files contain only their ID/account binding, never trusted arena state.
- Only one window controls an account's active zone presence. Leases expire after
  30 seconds without heartbeat. Movement is a server-validated cardinal step,
  limited to one per 200 ms and checked against the zone map. Other players'
  positions and fight status arrive in short polling snapshots (roughly 500 ms).
- Chat is zone-scoped, max 240 characters, five messages per ten seconds per
  account, with the newest 100 retained per zone and at most 40 in a snapshot.
  Control characters and GameMaker text newline markers are removed. Names are
  character display names, not verified real-world identities.
- A zone holds at most 64 active accounts. Request admission allows 32 concurrent
  requests and two per token; authenticated traffic is capped at 600 requests per
  minute per account. These are bounds, not a production load-capacity guarantee.
- Combat state and a payout entitlement commit atomically. The wallet receives an
  HMAC-signed operation with a stable entitlement ID. Lost responses and service
  restarts replay that ID. Pending awards retry on the owner's next authenticated
  visit; no bearer tokens are stored for unattended delivery. After token
  revocation, reconnect the same account to deliver its pending awards.
- Keep SQLite backups of this service as well as the tracker. For a simple
  consistent backup, stop this service before copying its data directory, then
  start it again. Do not restore just one side of the reward history without
  reconciling pending receipts and the shared wallet ledger.

This is an initial shared-zone implementation with individual battles, not
cooperative combat. It verifies legal gameplay and bounded rewards; it does not
claim to distinguish a human player from a bot submitting legal actions.


## NPC appearances

`GET /zones` includes the public `avatars` catalog. `create` accepts an optional `avatar` ID (default `player`); `appearance` changes an existing character using the usual character_id, revision, controller, and request_id while present in an arena. The server validates IDs against `server/avatars.json`, journals updates, and includes `avatar` in character and peer snapshots. Appearance changes do not affect combat or rewards. Existing state without an avatar defaults to `player`; no database migration is required.

Regenerate the catalog from the game checkout with `python python/export_online_avatars.py --server-root C:/Scripts/Lidollquest-server` whenever NPC names or sprite assignments change. Ship this JSON with the service and deploy the matching game assets. No tracker gateway changes are required.


## Campaign character imports

`enter` and `start` accept `loadout: {player_info, inventory, player_spells, player_mp, player_mp_max, attack}`. `loadout` updates a lobby character; `use_item` commits client-evaluated inventory/equipment effects and takes an enemy turn during a fight. Existing command IDs, ownership, controller leases and revisions apply, including canonical hashing of nested payloads. Character data is explicitly client-trusted. JSON structure and size checks are operational bounds, not anti-cheat.

Loads are capped at 192 KiB (512 inventory entries); HTTP bodies at 256 KiB. Currency keys are stripped recursively. Only the selected character snapshot includes its loadout, keeping roster lists small; peers never receive another player's inventory. HP and item consumption persist back into the game. Re-entry into an unfinished run resumes its stored loadout instead of restoring spent items from an older campaign snapshot. Combat v2 supports the campaign class menus and spells, with companion metadata preserved but no companion actor.

Deploy the updated standalone service and game together. The tracker browser gateway must allow 256 KiB specifically for `zones/action`; older versions used the wallet's 8 KiB allowance and return HTTP 413 for inventories. No schema migration or wallet changes are needed.

Lobby entry HTTP 409 reasons are logged as `quest_lobby_entry_conflict` in `journalctl -u lidollquest-server`. This distinguishes stale character revisions, another active window, mismatched saved arena runs, and dungeon re-entry conflicts when a GX runner omits the HTTP error body. The log contains the fixed rejection message only, without tokens or character inventory. Preserve the server state until the actual reason is known; do not clear fights or disable ownership/revision checks to work around a generic status code.

Snapshots advertise `controllerTakeover: true`. An owner may send `enter` with `takeover: true` after explicitly choosing **Take control here** in the game. This transfers the account's one controller lease atomically, preserves the selected character's committed inventory and fight, and rejects subsequent mutations from the old window. Ownership, revision, grant and request-receipt checks still apply. The field is a boolean accepted only on `enter`; default entry and heartbeats never take over another controller. Conflicting entry returns HTTP 409 with `zone_controller_conflict`. Deploy this service before the matching game; the button is hidden when an older server does not advertise support.


## Class combat v2

Snapshots advertise `combatVersion: 2`. Updated clients send `combat_version: 2` on enter/start. New runs persist the full combat model; re-entry upgrades an older run without discarding its pot or opponent progress. Legacy clients keep their existing protocol. Deploy this service before the rebuilt game.

A fight alternates a journaled `turn_ready` (`loadout`, boolean `forfeit`) and one class action: `attack`, `cast` (`spell` ID), `charm`, `allure`, or `use_item`. Run/Submit map to `flee`/`submit`. `allocate` takes a stat key (str/def/dex/int/cha) and spends one earned point between rounds or in the lobby. Every mutation uses the existing controller, revision and request ID. Replays cannot consume MP, repeat DOT ticks, grant XP or pay coins twice.

Combat rules live in server/combat.mjs. Regenerate server/combat-data.json from the game with python/export_online_combat.py after changing spells, magic_tree.json or enemy charm profiles. The catalog is deployment data, never a client-supplied ruleset. Player data remains intentionally trusted; only the server determines enemy outcomes and bounded shared-currency rewards. `childish` joins the loadout for mage/charm formulas.

The arena has one opponent per round, no companions, and its existing recovery/handicap rules. Later rounds can cast enemy spells. Physical damage, MP, magic scaling, status effects, charm pressure/backfire, XP and level rewards follow campaign rules. Settled losses and submissions include `lastResult.defeatScene` with the stable run ID, authored enemy ID and name. The client reuses campaign defeat dialogue and aftermath as private presentation; campaign penalties, story callbacks and world quest progress are not invoked. Arena templates leave the campaign enemy ID blank and use the generic recovery scene. Run npm test before deployment, then use the full-game browser fixture from the game checkout.
# Shared hub annexes and shops

Both arena lobbies now expose Garden, Beds and Shops portals in zone definitions. Annexes isolate shared chat/presence by zone ID. `hub_visit` validates adjacency and preserves committed loadouts; `hub_rest` accepts trusted campaign bed effects with lease/revision/proximity/cadence checks. `hubVisit` resumes annex inventory on reconnect. Companions remain excluded by the game.

`shop_buy` accepts `fixture` and `offer`, never a client item or price. Stock rotates daily UTC from exported curated pools; prices use LiDollCoins. Durable `hub_purchases` records reserve inventory before a wallet debit and atomically grant the item after its idempotent receipt. Pending purchases block inventory changes; lost responses retry the same debit on the owner's next authenticated request. Insufficient balance grants nothing. `quest_purchase_delivery_pending` logs unresolved delivery. Never remove pending purchase rows or restore only one currency database without reconciling receipts.

Export `server/hub-data.json` from the game with `python/export_online_hubs.py`; regenerate `server/dive-data.json` with `python/export_online_dive.py`. Deploy this service/content before the new game. The existing tracker `operations` debit endpoint is sufficient. Food migration adds a personal meal chest per non-entry room without resetting existing weekly loot or moving furniture. Run `npm test`; the game checkout's `ps/Test-OnlineZones.ps1` exercises real shop HUD purchases and beds at both hubs.
# Personal banks and area chat

Both market halls expose a bank at (17, 9), with 512 persistent item slots per character. `bank_deposit` takes `fixture: "bank"` and inventory `slot`; `bank_withdraw` takes the fixture and opaque `bank_item` ID. Normal ownership, controller, revision and request-receipt checks apply. Commands require proximity, no fight and no pending wallet purchase. The `quest_bank` table commits together with inventory and receipt changes; preserve it in normal database backups. Storage is free and independent of weekly editions. Snapshot `bank` contains capacity/count and, only beside the bank, item entries. An inventory-full or oversized withdrawal rolls back without consuming storage.

Snapshot `chatArea` identifies the current room. Every hub annex/lobby has separate chat; Dungeon Dive scopes by route/edition/depth/generated room, with one corridor channel per floor. Room membership comes from server coordinates. Prior whole-dungeon history is not copied into room channels. Deploy this backward-compatible service before the rebuilt game; no tracker or nginx change is needed.

Banks expose 16 stored items per response, plus `page`, `pages` and `pageSize`. `bank_page` accepts a zero-based `page` and the bank fixture; this avoids sending all 512 item structs through the existing 256 KiB gateway response limit.

## Shared shop sales

Deploy this service before the rebuilt game. Startup adds `quest_item_origins` without resetting saves. Only new paid purchases and dungeon loot receive sale identities; existing or imported untracked items remain unsellable. `shop_sell` takes `fixture`, committed inventory `slot`, and `item_instance` plus the standard controller, revision and request ID. The server determines the price: half authored value (floor, minimum 1), cursed items 1, never above the original paid purchase price. Quest/zero-value items receive no sale right.

Sales use the account-wide 1000-coin UTC daily earnings allowance and require room for the entire quote; rejection leaves the item intact. Inventory removal, retired identity, cap accounting and durable wallet outbox entry commit together. Payment transport failures retry the same outbox entitlement after reconnect/restart. Tokens are character-bound, price edits are ignored, and sold/consumed/duplicated/banked tokens cannot be imported to mint another sale. Reconciliation retains identities through bank transfers and normal online equipment changes, including dresses and identical-copy swaps. Old clients remain compatible; stock or loot predating this update is not retroactively certified.

Run `npm test` for provenance, sales, cap, retry and restart coverage; the game checkout's `ps/Test-OnlineZones.ps1 -SalesOnly` exercises real Buy/Sell panels against this service and the tracker wallet.

## Companion view and bank sales

A companion client (the **LidollQuest-Companion** page, served by the tracker at
`{base}companion/` and reached from its Games tab) shows a character and her bank
between sessions, without a zone, a controller lease or any in-game presence. It
is hosted on the tracker rather than the bot because the tracker's browser wallet
gateway is same-origin only and its bearer path is locked to
`client_id=lidollquest`; nothing in this service needs to change for it.

`GET /zones?character_id=ID&view=companion` returns the usual snapshot with two
differences: `bank.items` is populated wherever the character is standing, and
`bank.companion` is `true`. Add `&bank_page=N` (zero-based) to read a further
page. Companion paging never writes the stored `bankPage`, so it cannot move the
drawer an in-game client has open. Ordinary requests are unchanged: without
`view=companion` a client still receives item payloads only while beside a bank
fixture. With `view=companion` the snapshot also carries `sheet`: the existing
`inspectionProjection` for the requested character, giving name, level, class and
resolved equipment names while still excluding raw inventory and private survival
fields. It rides along deliberately, because `GET /zones/inspect` calls
`presence()` and a companion never holds a zone, controller lease or presence
row; ordinary reads receive no `sheet`.

Each `sheet.inventory` entry carries `category`, and `is_drink` when the item is
a bottled consumable — those use `category: "food"` but belong on the
companion's Drinks tab, which mirrors the game's own item viewer. `is_drink`
comes from the item catalog exported by the game's
`python/export_companion_assets.py`, so regenerate `server/companion-items.json`
there rather than editing it by hand. No other tab needs a field: the companion
groups everything else by `category` alone.

`POST /zones/action` accepts `bank_sell` with `bank_item` (the server-issued
storage entry id), `item_instance` (its sale right) and the standard
`character_id`, `revision`, `controller` and `request_id`. Unlike `shop_sell`
it needs no `fixture` and no presence, so a banked item can be sold from
anywhere; it is handled before the dungeon router, so it also works while the
character is parked in a dive. Every other rule is the shop's: the server sets
the price, the whole quote must fit the account's remaining UTC daily allowance
(rejection leaves the item in storage), and storage removal, the retired sale
identity, cap accounting and the durable outbox entitlement commit together, so
a replayed `request_id` pays once. Selling during combat is refused. A
`bank_sell` response carries the companion-visible bank, so no second request is
needed. `capabilities` advertises `companionBank` and `bankSales`.

Run `npm test` for companion read, paging, presence-free sales, cap rejection,
forged-token rejection and replay coverage.

## Player needs and exploration

New clients attach `world_step: true` to movement. A successful step reserves `worldTurnDue` after any loot grant. The client evaluates the existing campaign needs routines and popup choices, then submits `world_turn` with the matching `world_turn_id` and complete loadout. Inventory mutations and enemy engagement wait for that result. Reconnect preserves the reserved turn and committed inventory; receipt replay cannot apply a turn twice. `loadout.world` persists the turn clock, crawling/wet-only flags and delayed accident popup state. These player effects remain client-trusted, like existing campaign imports; coin rewards remain server-controlled. Legacy clients can continue their existing movement protocol during rollout.

The rebuilt game restores ordinary Quick Actions, places online services behind MENU, and uses a Dungeon Dive staircase at (10, 2) in each lobby. Resting, overworld spell casting and intentional player actions commit their ordinary effects through the existing authenticated interfaces. Companions and campaign quest/story triggers are excluded. Test with `npm test` and the game's focused two-player hub/needs browser fixture before deploying the game.

## Weekly shared Desert

The Dustbreak Desert is a second weekly route (dustbreak-crossing / dive-desert), connecting both online lobbies. It uses the same Monday 04:00 America/Los_Angeles schedule, personal loot, combat and reset/recovery system as the Quarters, with route-isolated state. No additional coin boss reward is added. Config and authored pools are exported from the game with python/export_online_desert.py into server/desert-data.json. Deploy this service/content before the new game. npm test covers deterministic Desert generation, crossings, route isolation, reset, reconnects and all classes. See the game checkout ONLINE_DESERT_GUIDE.md for editor settings and the two-player browser regression.

Shared hubs now include Dive Halls with Quarters/Desert floor portals. The former gardens are now monthly 50x50 host-zone districts, exported from online_districts.json; their existing *-garden identifiers are retained. Definitions include authoritative width/height, spawn, exit and portal style. Garden uses a left-wall gap and Beds a right-wall gap in each lobby (y=5–6). `style: gap` includes width/height and side metadata; `move` atomically transfers characters on contact, with matching right/left return openings and safe interior arrival tiles. These boundary cells are ordinary floor. Dive Hall retains its doorway and Shops its stairs. A dungeon visit keeps both its parent origin hub and returnZone hall; crossing the Desert returns to the other hub hall. Direct lobby dive_enter remains supported for old clients during service-first rollout.

## Additional campaign Dives

The hub catalog now offers Dungeon from Rose Court; Auto-Nursery, Regression School and Haunted Forest from Lantern Court; Haunted Mansion and Regression Research Hospital from Clockwork Coliseum. Princess' Quarters is exclusive to Rose Court; the crossing pads and all route IDs remain stable. New route IDs are dungeon-weekly, nursery-weekly, school-weekly, forest-weekly, mansion-weekly and hospital-weekly, with corresponding dive-* zone IDs.

Export the game catalog with `python/export_online_campaign_dives.py` to `server/campaign-dives-data.json` and deploy it with the service before the rebuilt client. Each route uses independent weekly editions, claims, room chat and existing combat; no campaign story callbacks or new boss coin rewards execute. Snapshots add a compact `dungeons` availability catalog and include only the active route's floor. Never delete existing databases or weekly editions to apply content changes.

`test/campaign-dives.test.mjs` exercises 600 deterministic maps, route adjacency, reconnects, claims, interrupted combat and the 256 KiB gateway response budget. The full suite also retains existing Quarters, Desert, Tundra, bank, companion and daily coin-limit coverage.

## Online underwear loot balance

`non_diaper_panties_per_floor` defaults to 1 (integer 0-99). Across each character's chests and loose treasure on a weekly floor, surplus non-diaper panty rolls become eligible diapers from the route's existing loot pool. All other seeded items and weapon stats retain their original rolls. Existing saved rolls are preserved; no map reset or database migration is needed. Capacity is checked before rolling, and personal progress retains the allowance across reconnects and inventory changes. Campaign loot and NPC rewards are unaffected.

`server/dive-loot.mjs` supplies the shared roller. `test/dive-loot.test.mjs` checks 72,000 seeded rolls across all nine routes; `test/dive-loot-claims.test.mjs` covers full bags, duplicate commands, reconnects and independent character allowances through the real claim API. Export the matching game-side online settings when tuning the limit. No client protocol change is required.

## Monthly safe hub districts

Rose Court opens into The Castle, Lantern Court into Market Square, and Clockwork Coliseum into Red Light District. Each shared 50x50 district uses native host-zone scenery and four social NPCs, with no enemies, loot, arena starts or campaign quest callbacks. `hub_talk` requires adjacency and returns a normal hub notice. Existing shops, bank, beds and Dive Halls remain in their established rooms.

`server/hub-districts.mjs` materializes layouts in additive `hub_district_editions` and `hub_district_current` tables. Editions change on the first of each month at 04:00 America/Los_Angeles, including DST. Existing visitors move to the safe entrance at rollover without changing character inventory, needs turns or Dive progress. Old editions remain stored. Only the active district includes full geometry in snapshots.

Export `server/hub-district-data.json` with the game's `python/export_online_districts.py`. Deploy the service and content before the rebuilt game, preserving databases. This export does not replace hub stock, daily coin limits, companion features or weekly Dive data. The game retains the old garden IDs for saved visits and reconnects. `test/hub-districts.test.mjs` checks 300 deterministic layouts, full scenery footprints, NPC proximity, restart persistence, live rollover and bounded snapshots. See the game's ONLINE_DISTRICTS_GUIDE.md for editor and two-player browser checks.
### Shared player activity notices

Confirmed online accidents and diaper changes now post `<name> had an accident.` and `<name> changed their diaper.` to the same area action log as player chat. Contained accidents and leaks are included; wet/tum effects within one committed update produce one accident notice. A successful fresh diaper equip counts even when replacing the same item type. Rejected changes, imports, heartbeats and receipt replays do not post notices.

The client records monotonic `online_accident_seq` and `online_change_seq` counters in its existing loadout draft. `server/player-activity.mjs` publishes increases inside the accepted command transaction. Notices follow the current hub or Dive room/route/edition, use the regular bounded chat history and do not consume the player's manual chat allowance. Offline play creates no shared notices. Deploy this service addition before the rebuilt client; preserve all databases and existing editions.

Successful holds also post `<name> fidgets and shifts their weight around`. An actual excitement-meter overflow posts `Uh-Oh, <name> got way too excited in public ;)`. These use `online_hold_seq` and `online_excitement_seq`; failed holds use the accident path. Activity rows carry an `activity` marker so the client displays the exact event wording without a chat speaker prefix. Player-authored messages retain their normal speaker prefix and never open an NPC box.

## Enlarged Market Halls and Cursebreaker

All three shop annexes are 40x24 with eight merchants, bank, themed scenery, and a Cursebreaker at (9,20). Arrival is (20,21), stairs (20,22). `hub_talk` supports this NPC and `curse_remove` takes `fixture`, equipment `slot`, and `item_id`. The price is server-owned at 20 coins. Validate proximity, equipped cursed item, combat/needs state and bag capacity before reserving the existing durable purchase debit. On settlement, remove only that piece, reverse equipment effects, reconcile item provenance and update loadoutRevision. Dresses release both slots once; normal gear returns still cursed, used diapers are disposed of. Failed payments and cancelled dialogue do not change equipment.

Export with the game repository's `python/export_online_hubs.py`; it preserves existing service-only settings, including daily_coin_cap. Deploy service/content before the rebuilt client, retaining the databases and outstanding purchases. `test/market-services.test.mjs` covers layout accessibility, full sprite footprints, capacity, provenance, single-item changes, declined payment and restart/replay safety.


## Host-style courtyard layout refresh

District content version 2 replaces the common path lattice with Castle BSP rooms and branching halls, Honeydew woodland clearings and winding paths, and LittleBig City avenues, solid blocks and parks. `server/district-layouts.mjs` uses geometry settings exported from the matching campaign generators, with per-district overrides. These remain safe 50x50 social maps; campaign enemies, loot, traps and story callbacks are excluded.

Persisted layout keys now include both the month and content version. Deploying this version refreshes current districts immediately and returns visitors to (48,25); old edition rows remain archived. Same-version restarts preserve layouts and positions. Monthly regeneration still occurs on the first at 04:00 Pacific. The rebuilt client uses `district.layoutKey` to repaint and close stale NPC dialogue on either kind of refresh.

Deploy the matching service/content before the rebuilt client, preserving databases, purchases, bank state and weekly editions. Run `npm test`, including `test/district-overhaul.test.mjs`, and the game's two-player `--districts-only` fixture to verify immediate upgrades as well as monthly resets. Inactive district snapshots omit full geometry to retain the gateway response budget.


## Dive return portal contact

The movement handler now returns single-entrance Dives to their recorded entry hall when a character steps back onto the entrance tile. Explicit Desert/Tundra exits retain their destination behavior. Entry, heartbeat and reconnect never trigger a return just for occupying the portal. Transfers reuse the existing atomic return path, preserving inventory, personal claims and command receipts; pending needs turns must settle first. This correction requires a service update only, with no database reset, regenerated edition or client protocol change. `test/dive-halls.test.mjs` covers all hall destinations; the game browser re-entry fixture checks keyboard and click contact.


## Private companion character sheet

GET /zones?view=companion retains that view through the final settlement re-read, including bank_page. With no character_id it selects the account's current/latest online presence or newest character. An explicit character_id remains owner-validated. Responses include a compact roster, selected identity, bank, balances and the private sheet; dungeon geometry and duplicate raw loadouts are omitted.

server/companion.mjs adds bounded inventory entries, equipped item details, stats, appearance and Tush Status. Active gameplay, unfinished Dives/fights and pending turns use committed online state. An offline cloud preview may be used only when its online_revision is at least the committed loadout revision. Reads never mutate loadouts or renew/take over presence. Public inspection remains unchanged. Full 512-item sheets stay within the 256 KiB gateway budget.

Export companion-items.json with the game's python/export_companion_assets.py and deploy the service before the matching Little Log companion assets. Preserve all databases and bank-sale receipts. test/companion.test.mjs exercises the actual HTTP response, selected/default characters, paging, ownership, cloud freshness and response bounds. The game's companion_browser.mjs verifies the full UI and real bank sales.


Deploy defeat-scene metadata before the rebuilt game client. Older clients ignore this additive field; no databases, command receipts or weekly editions are reset. Completed scenes are remembered per character on each device; interrupted scenes can restart from the settled result.


## Shared Pink Mist

`dive-mist.mjs` adds a deterministic `floor.mist` layer once per weekly edition, including existing floors that lack it. Compact rows are included only in the visited Dive definition. Safe entrance rooms and portal margins remain clear; geometry, scenery, claims and encounter locks are preserved. Later policy edits affect new editions.

Export `datafiles/generation/online_mist.json` with the game checkout's `python/export_online_mist.py`. The defaults match campaign probabilities (Forest and Tundra default to zero). The client reuses campaign crawling effects and visuals; `worldTurnDue.mist` pins exposure for the existing recoverable needs commit. Heartbeats never apply effects. Deploy service and policy before the rebuilt game in the same content push; older clients ignore mist. No database reset or schema migration is required.

Tests: `test/dive-mist.test.mjs` checks 900 generated floors and bounded spread; `test/dive.test.mjs` covers additive installation, pending-turn replay/reconnect and snapshot size.


## Campaign Dive movement compatibility

Campaign enemy definitions export `roaming` from their source zone's `stationary` setting. Normal enemies in Dungeon, Nursery, School, Forest, Mansion and Hospital roam and pursue; authored stationary mimics and route guardians remain fixed. Newly generated floors store explicit movement flags. `enemyRoams` resolves missing flags on existing editions from the exported definition, preserving explicit flags, locks, respawns, geometry, mist and claims. Quarters and the two crossings retain their established policies.

Deploy the service and regenerated `campaign-dives-data.json` together, then restart the service. No client rebuild, database migration or weekly-floor reset is required. `test/dive-movement.test.mjs` exercises all nine routes with new and legacy floor records; the game browser fixture `--movement-only` checks two-client Mansion synchronization and pursuit.

### Rose-only Quarters entry and client text shadows

`dungeonPortals` offers Quarters only at Rose Court (6,4). Lantern and Clockwork no longer accept new Quarters entries, including legacy direct-lobby requests; their other pads retain their coordinates. Existing Quarters visits reconnect and return to their stored hall normally, preserving editions and progress. Deploy this service before the rebuilt client, whose world labels and Dive status use the HUD shadow color instead of black plates. No database migration or floor reset is needed. `test/rose-hall-access.test.mjs` covers exact rosters, forged entry and legacy visit recovery.

### Ordinary beverage supply pickups

All nine routes now split food-kind supply pickups evenly between meals and six existing ordinary drinks: water, milk, sippy juice, juice boxes, formula and Ghost Milk. Potion pools and pickup counts are unchanged. The game editor exposes beverage_pool in the Items tab for Dungeon Dive, Online Desert and Online Tundra; the six campaign Dives inherit the Quarters export. Re-export Quarters before campaign Dives, then both crossings. Deploy these four data files together and restart the service. Existing personal rolls/claims and maps remain intact; unrolled pickups use the new pools without a reset or client rebuild. test/dive-beverages.test.mjs exercises 9,000 deterministic supply rolls and existing receipts.

### Wandering district residents

Each monthly district now has four stationary residents and four additional named wanderers. resident_version upgrades append the new residents with an independent seed, preserving current layouts, stationary fixtures and visitor positions. district-residents.mjs moves residents on the shared service clock about once every three seconds within eight cells of home, leaving the east entrance clear. They pause within two cells of players, avoid walls/scenery/other NPCs and remain passable. Movement is persisted; empty districts do not wander or catch up after a restart. E/click conversations remain private native NPC dialogue, and player chat stays in the action log. Deploy service/content before the rebuilt client for walking sprites and pass-through input. No layout version increase, database migration or reset is required.

### Shared Dive battles and three-person parties

New clients negotiate `combat_version: 3` on entry. Snapshots advertise `diveCombatVersion: 3` and `partySupport`, and include private `partyInvitations`, a minimal `party` roster, and the current `encounter`. New Dive fights use persisted shared actors, stable enemy IDs, individual action deadlines and cycle tokens. Existing fights and solo arenas retain their older flow. Old clients cannot take over a party or shared encounter.

Party actions are `party_invite`, `party_accept`, `party_decline`, `party_leave`, `party_kick` and `party_disband`, using `member` or `invitation` IDs. Combat actions include `battle`, `cycle`, and `target`; needs acknowledgments and self item uses send scoped `patch` operations. Numeric changes apply as deltas and inventory splices verify the original changed entries. Receipts still make every command replay-safe; shared combat accepts valid actor-cycle commands independently of other actors' revisions.

Online door transfers update every member atomically. Campaign departure removes only its caller. Membership survives two minutes after the ordinary thirty-second presence lease expires; saved destinations follow group travel. Shared battles retain their original participants until settlement and preserve personal rewards, claims, item provenance and daily coin caps.

Run `node --test test/*.test.mjs`; `test/parties.test.mjs` covers reinforcement seeds/probabilities, all nine routes, invitations, atomic travel, ally healing, stale commands, large inventories/snapshots, reconnects and reset grace. Export `generation/combat_tuning.json` with the game's `python/export_online_combat.py`. The game-side `ONLINE_PARTIES_GUIDE.md` documents controls, tuning and rollout. Deploy compatible service/content before the new client; retain all databases and weekly editions.


## Character RPP

Multiplayer mage levels now increment authoritative `state.mageSpellPicks` once per level instead of automatically learning a spell. `mage_pick` redeems one for an eligible unknown shop spell and records a zero-RPP permanent unlock; normal receipt/revision checks prevent duplicate spending. RP-admin levels share this path. Existing known spells remain, without retroactive credits. Unspent stat points no longer block travel, encounters or party readiness; allocation remains unavailable during combat. Deploy this service before the GX client with stored-point controls and the centered MENU modal.

RPP: `/gm` now includes character-specific gifts and a purchase ledger (`GET /gm/rpp`, authenticated `rpp_gift` action). `rpp_buy` uses the existing character/controller revision and durable request receipt, plus `offer` and `rpp_cost`. Wallet, debit and unlock updates are atomic; gifts have independently replay-safe IDs. Startup adds three RPP tables without resetting data. Exported `magic_tree.rpp_shop` controls costs/classes/levels; `magic-balance.mjs` matches the client's mage ×0.5 physical, ×1.5 magic/fullness and ×2 MP multipliers. Purchased abilities are authoritative even when campaign imports or combat patches replace player data. Deploy service and combat-data before the matching GX client. Tests: `test/rpp.test.mjs`, `test/gm.test.mjs`, `test/combat.test.mjs`; game-side `RPP_GUIDE.md` documents the UI and browser fixture.

## Multicore runtime

`QUEST_COMPUTE_WORKERS=auto` uses up to six persistent CPU workers while leaving
two available cores of headroom (six workers on an eight-core VM). Explicit
values 0 through 32 are supported; 0 uses synchronous calculations. Restart
after changing `/etc/lidollquest/server.env`. The startup path prepares missing
weekly floors before listening; existing editions, claims and receipts remain.
No database reset or GameMaker rebuild is needed.

Workers generate seeded floors and calculate batches of pursuit paths. One
coordinator owns SQLite, timers, purchases and combat. Before applying paths it
rechecks edition, exact floor contents, player identities/positions and age
(at most one second), then uses fresh character/party state. Stale results wait
for another tick. Generation failures retry after a minute; pursuit failures
retry on later ticks. The pool has a 64-job waiting queue and a 60-second job
timeout. Crashed workers are replaced on demand. Shutdown cancels pending work
before closing the database. Do not run duplicate service instances against
one SQLite database for scaling.

HTTP actions now build one snapshot after purchase settlement; HTTP reads build
one snapshot as well. Availability checks no longer decode every dungeon floor.
Snapshot assembly, combat, monthly districts and database writes remain on the
coordinator. In `/gm`, compare request p95, event-loop delay, worker busy/queued
counts and memory. `worker.paths/generate` measure execution;
`worker.queue.*` measures waiting; `worker.roundtrip.*` includes dispatch through
delivery; `worker.stale.paths` counts discarded batches. `floor.read/decode/encode/write`
separates SQLite and JSON costs. Timings overlap and are not additive CPU usage.
Worker completed/failed counters are lifetime totals. Process CPU includes all
threads, with 100% representing one occupied core.

Run `node deploy/benchmark-compute.mjs --workers=0,1,2,4,6` off-peak for an isolated
synthetic comparison (in-memory databases, no real wallet or accounts). It measures
ten floor generations, forty pursuit batches, and forty empty-lobby HTTP reads.
Repeat on the VM and compare populated-zone load before selecting 2, 4 or 6;
the empty-lobby HTTP benchmark does not exercise roaming, disk writes or wallet
latency. Regression tests: `node --test test/*.test.mjs`, especially
`compute-pool.test.mjs`, `parallel-dive.test.mjs`, `service.test.mjs` and
`performance.test.mjs`.

## Market dumpsters

Every hub market now advertises a solid `dumpster` at (34,20), approached from (34,21). `item_discard` requires the normal controller, character revision and durable request ID, plus `fixture`, committed inventory `slot`, `item_id` and `item_instance` (empty for untracked items). It checks proximity and exact item identity, removes one carried item, and retires its sale provenance atomically. No coins are awarded; equipment, bank contents and quest items are excluded. Combat, pending needs and unsettled purchases block disposal. Deploy the service before the rebuilt client; no schema migration or database replacement is needed. The client advertises disposal only when the fixture is present and confirms each removal. Regression coverage: `node --test test/item-discard.test.mjs`.


Companion equipment: `companion_equip` takes inventory `slot`, `item_id`, and the private sheet `equipment_version`; `companion_unequip` takes equipment slot name instead. Both require the standard character revision, request ID and owner grant. Commands preserve the game lease, follow equipment rules, and create a new cloud version for offline cloud-backed characters. `test/companion-equipment.test.mjs` covers atomicity, save preservation and every hub/portal arrival. Permanent continence potions use ±200 internal units (20 percentage points). Temporary potions use continence_set 0 or 1000 for full continence/incontinence for 250 turns; the latest dose replaces the previous temporary potion.


## Live world administration

The GM panel includes Monsters, Zones and Generation Jobs. Content drafts,
published history, managed PNGs, generation checkpoints and regeneration receipts
live in `quest.sqlite`; exported JSON remains the baseline. Back up the complete
SQLite database safely (SQLite backup API, or stop the service first), including
WAL state if copying an active database. Never discard command/reward receipts.

Deploy the quest service, the Little Log `content/asset` gateway route, and game
clients advertising `content_version: 1` before publishing content. Older clients
must update before entering published encounters. All new GM actions reuse the
existing LiDollID gamemaster role, audit log and origin/TLS restrictions.

PixelLab uses the existing server `PIXELLAB_API_TOKEN` and optional
`PIXELLAB_PYTHON`. Admin generation spends provider credits directly; it never
uses player diamond billing. Include `server/gm-world-panel.js` and the `python`
worker directory in every release. Interrupted walking submissions require an
explicit retry; completed walking art is retained when portraits fail.

Whole-Dive regeneration waits for fights and unread defeat scenes, then moves
all visitors to safe entrances. It resets treasure/boss claims with a new map
identity; daily account-wide currency caps and historical receipts remain intact.
Manual hub monsters default to interaction-only and one-off placement. Automatic
aggression and respawning are explicit DM choices.

Run `node --test test/world-controls.test.mjs` for focused coverage and `npm test`
for the full suite. The game's `WORLD_ADMIN_GUIDE.md` describes authoring and rollout.
