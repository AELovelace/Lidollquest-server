# LiDollQuest server

A standalone Node 24 service for **two online zones**:

| Hub | Zone | Fight rule |
| --- | --- | --- |
| Honeydew Village | Lantern Court | Recover some HP between rounds |
| LittleBig City | Clockwork Coliseum | Every third enemy turn hits harder |

Each zone has a shared lobby with synchronized avatars and chat. Arena runs are
individual, eight-round progressive fights: attack, guard or heal; bank after a
win or accept a random handicap and continue. Defeat/forfeit loses the unbanked
pot. Round eight automatically banks it. Each cleared round adds `5 × round`
coins to the pot. Banking is capped at **250 coins per account per UTC day** across
all characters/zones; runs can still be played after the cap. New runs have a
one-minute entry cooldown per character.

The server owns arena HP, equipment strength, healing charges, enemies, randomness,
rounds and rewards. All characters start an arena run with the same loadout; local
campaign stats, items, saves and mods cannot affect a shared-currency award.
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
fields, including caller-selected rewards or stats, are rejected.

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

The sample unit uses `/opt/lidollquest-server/current`, `/etc/lidollquest/server.env`,
`/var/lib/lidollquest-server`, port **4191**, and `/usr/bin/node-24`. Adjust paths
and bind addresses to the actual host. Create a dedicated system user and install
the checkout and unit before starting it:

```sh
sudo useradd --system --home-dir /var/lib/lidollquest-server --shell /usr/sbin/nologin lidollquest-server
sudo install -d -m 0750 -o root -g lidollquest-server /etc/lidollquest
sudo install -m 0640 -o root -g lidollquest-server deploy/server.env.example /etc/lidollquest/server.env
sudo install -m 0644 deploy/lidollquest-server.service /etc/systemd/system/lidollquest-server.service
```

Edit the environment file with the correct wallet address. In the updated tracker
checkout, provision a matching **server-only** key for client `lidollquest`:

```sh
sudo /usr/bin/node-24 scripts/configure-reward-authority.mjs \
  --tracker-env /etc/lidoll/tracker.env \
  --bot-env /etc/lidollquest/server.env \
  --client lidollquest
```

The shared provisioning helper calls its second destination `--bot-env`; it also
works for this service's `LIDOLLCOIN_REWARD_KEY`. It preserves the existing
MommyBot key, ownership and mode, and prints no keys.

Add `LIDOLLQUEST_API_URL=http://127.0.0.1:4191/` to the tracker environment, or the
actual private service address. Deploy the matching tracker auth/security changes
and gateway, restart the tracker, then enable this unit:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now lidollquest-server
sudo systemctl status lidollquest-server --no-pager
```

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
