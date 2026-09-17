# LiDollQuest server

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

Both arena lobbies now lead to one shared Princess' Quarters pilot. The server
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

The arena has one opponent per round, no companions, and its existing recovery/handicap rules. Later rounds can cast enemy spells. Physical damage, MP, magic scaling, status effects, charm pressure/backfire, XP and level rewards follow campaign rules. Enemy-specific campaign story/defeat scripts and world quest progress are not invoked. Run npm test before deployment, then use the full-game browser fixture from the game checkout.
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

The hub catalog now offers Dungeon from Rose Court; Auto-Nursery, Regression School and Haunted Forest from Lantern Court; Haunted Mansion and Regression Research Hospital from Clockwork Coliseum. Existing Quarters, Desert and Tundra pads and route IDs remain. New route IDs are dungeon-weekly, nursery-weekly, school-weekly, forest-weekly, mansion-weekly and hospital-weekly, with corresponding dive-* zone IDs.

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
