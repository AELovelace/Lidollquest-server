# lidoll.dev migration tonight: 10.1.1.23 → 10.1.1.24

Move the **gallery, omo-trainer, lidollquest-server and lidoll-auth** to Fedora
at **10.1.1.24**, using SSH user **aedith** on both servers. Keep the existing
reverse proxy at **10.1.1.20**. Public domains, TLS termination, account subjects,
auth signing keys, callback URLs and reward keys stay the same.

This is a host migration of the installed releases, not a deployment of the
latest Git branches. The scripts have been checked locally; they have **not**
been run against either server. The live inventory is the first execution gate.

## Commands

Run from a checkout of **this repository**, on Linux, WSL or Git Bash, with Bash,
Python 3, OpenSSH `ssh` and `scp`. Keep the `deploy/` and `python/` directories
together. You can also run from either Fedora machine: the controller still
connects to both hosts over SSH. The source and target need Python 3 already.

```bash
# 1. Read-only service inventory; also reports the approximate archive size.
bash deploy/migrate-lidoll-services.sh --mode inspect

# 2. Prepare the new Fedora server while the old services remain online.
bash deploy/migrate-lidoll-services.sh --mode prepare

# 3. During the maintenance window, after blocking traffic and external writers:
bash deploy/migrate-lidoll-services.sh --mode migrate --maintenance-confirmed
```

The script defaults to `aedith`, source `.23`, destination `.24`, and proxy `.20`.
SSH and sudo can prompt normally. Verify new SSH host fingerprints through a
trusted channel; host-key checks are enabled. `--non-interactive` requires SSH
keys and already-configured noninteractive sudo. The script never stores sudo
passwords. Use `--identity-file /path/to/key` if necessary. SCP's remote-to-remote
relay works most predictably with key authentication to both hosts.

`--zone auto` discovers the target interface's firewalld zone. Use `--zone
FedoraServer` or another actual zone to require a match. If another machine needs
direct API access, add its address with `--allow-client IP` on both prepare and
migrate runs. For example, a bot remaining on `.23` may need that explicit rule
and updated backend URLs. The default grants only the proxy inbound access.

## What moves

| Service | Runtime code | Persistent state | Configuration | Default port |
| --- | --- | --- | --- | --- |
| `lidoll-auth` | `/opt/lidoll/current` and its exact release | `/var/lib/lidoll/auth` | `/etc/lidoll/auth.env` | 4180 |
| `lidoll-tracker` | Same release as auth | `/var/lib/lidoll/tracker` | `/etc/lidoll/tracker.env` | 4173 |
| `lidollquest-server` | `/opt/lidollquest-server/current` and its exact release | `/var/lib/lidollquest-server` | `/etc/lidollquest/server.env` | 4191 |
| `lidoll-gallery` | `/opt/lidoll-gallery` | `/var/lib/lidoll-gallery` | `/etc/lidoll-gallery.env` | 8787 |

The archive includes full state trees, SQLite sidecars, auth `secrets.json` and
`clients.json`, gallery originals/previews, service units and supported drop-ins,
and the `/etc/lidoll` and `/etc/lidollquest` configuration directories. The tracker
includes **both `little-log.sqlite` and `market.sqlite`**, preserving wallet
balances and delivery receipts alongside the quest database's outbox and saves.
Actual configured ports are read from the source rather than assumed.

Release symlinks and targets move together. `node_modules` and `.git` are excluded;
the target rebuilds pinned production dependencies using `npm ci --omit=dev
--ignore-scripts`, under a separate unprivileged build account. It checks that
`sharp` and `openid-client` load. Node 24, Python Requests/Pillow and ffmpeg are
installed on the target. Existing package dependencies may be updated by DNF;
this does not perform a Fedora release upgrade.

The helper updates private bind addresses, tracker↔quest connectivity and the
auth identity backchannel. It retains public issuer/origin/client settings,
wallet reward keys, VAPID keys, integration tokens and provider credentials.
The production issuer documented in these repositories is
`https://auth.sadgirlsclub.wtf`; the script preserves and checks the actual issuer.
Do **not** run the issuer-migration tool, account initialization or key-generation
commands for this move.

The gallery's first-install script still assumes `.23`. This migration bypasses
it and updates the copied nginx snippet. Use the gallery's environment-aware
update workflow afterward; review its first-install script before reusing it on
`.24`. Tracker deployment settings are updated to the new bind address and zone.
Git mirrors, deploy-user SSH keys and historic backup directories are not moved;
reprovision a read-only deploy key if future updates need one.

## Tonight's sequence

**Before the window — allow at least 60–90 minutes for preparation.**

1. Run `inspect` and review the manifest in `artifacts/migration-<run>/`.
   Nonstandard paths, users, units or inline systemd environment settings stop
   the script for review. Do not bypass a failure by pointing the archive at a
   broader directory. Confirm the live source contains all four expected services.
2. Verify Fedora `.24` has working SSH/sudo, correct time/NTP, outbound package
   and HTTPS access, and a configured/running firewalld that permits SSH. Keep
   SELinux enforcing. The script refuses an existing installation at its restore
   paths. It requires matching CPU architectures and available service ports.
3. Run `prepare`. It installs prerequisites and adds destination-specific firewall
   rules; it does not stop `.23` or start app copies on `.24`. Check source-based
   firewall zones or custom earlier-priority rules separately, if present.
4. Review archive size and free disk space. The old host keeps a root-owned frozen
   backup **plus** a private SCP staging copy; the new host needs an archive,
   restored files and dependency headroom. Staging uses disk-backed `/var/tmp`.
5. Choose a downtime window based on actual gallery size and transfer throughput.
   **All data is copied while stopped.** A 20 GiB gallery at an effective 50 MiB/s
   takes roughly seven minutes for one network transfer, before archive creation,
   source staging copy, checksums, restoration and npm installation. Slow links or
   large video collections can require much longer than 30 minutes. SCP relays
   through the controller; running it on a fast LAN machine avoids a slow remote
   workstation bottleneck. Use AC power and keep the terminal/network awake.
6. Record representative existing records: account identity, gallery collection
   and media counts, recent tracker entries, wallet balances, quest characters,
   bank items and cloud saves. Do not export private content into the runbook.
7. Save the active nginx configuration on `.20`; identify gallery, tracker, auth
   and any direct `/gm` upstreams. Pause deployment automation, timers and external
   callers such as MommyBot that write to these services. Do not rotate secrets
   or deploy new game/service features during the move.

**Maintenance window — migration plus verification.**

1. Put `/gallery/`, `/tracker/`, the public auth host and any direct quest/admin
   routes into maintenance on `.20`. Return a temporary **503**, not a successful
   empty response. Allow existing uploads to finish or explicitly stop them before
   freezing. Pause LAN callers too. Announce that gallery login, tracker sync and
   multiplayer will be unavailable. Offline PWA entries should remain on devices;
   do not ask users to clear browser storage.
2. Run `migrate --maintenance-confirmed`. This switch records that **you have
   completed that traffic pause**; the script cannot verify your proxy rules.
3. The script checks the target, then stops gallery → quest → tracker → auth.
   It disables the source services and installs persistent systemd condition
   files that block accidental starts, including after a reboot. It refuses to
   copy if another process still has a migrated data file open.
4. A single stopped archive is saved at
   `/var/backups/lidoll-migration/<run>/services.tar` on `.23`, then copied with
   `scp -3` to `.24`. The helper validates its SHA-256 and archive paths, restores
   to empty destinations, maps service ownership, restores SELinux labels,
   rebuilds dependencies and runs SQLite `integrity_check` on copied databases.
5. The new services start auth → tracker → quest → gallery. Local checks require
   the original discovery issuer, the expected unauthenticated tracker 401,
   quest `{"ok":true}` health and a gallery API response. These checks do not prove
   public sign-in, media codecs or wallet reward delivery.

**Proxy cutover — on `10.1.1.20`.**

1. Keep maintenance protection active while changing only the four relevant
   upstreams from `.23` to `.24`. Preserve their actual ports, path handling,
   forwarded headers, upload limits, streaming/range support and TLS settings.
   The auth virtual host is included even though its public name is on
   `sadgirlsclub.wtf`. No DNS change is needed because the proxy stays put.
2. From the proxy, check `.24:8787/gallery/api/sets`, `.24:4173/tracker/api/session`
   (expected 401) and auth discovery on `.24:4180`. Use the manifest's ports if
   customized. A loopback-only quest port remains reachable through the tracker;
   do not expose it just to test `/health` remotely.
3. Run `sudo nginx -t`, then `sudo systemctl reload nginx`. Test public URLs using
   an operator-only maintenance exception, then remove maintenance protection and
   repeat the public checks. Nginx validates configuration with `-t` and applies
   reloads gracefully. [Nginx command documentation](https://nginx.org/en/docs/switches.html).
4. Resume outside integrations after updating any private URLs that still point
   to `.23` or to their former localhost neighbors. Preserve each matching token.

## Acceptance checks

- Existing auth login and a fresh login resolve the same account; gallery and
  tracker callbacks work. Verify an existing session if available, but allow
  expired sessions to reauthenticate normally.
- Gallery public collections/previews load; play and seek a video. An authenticated
  full-size image/download and one small test upload work. Confirm ownership and
  the prior media/collection counts. Remove only the test upload afterward.
- Tracker shows recent records and original wallet balances. Submit one known
  test record, then reconnect an offline PWA and verify its queued write appears
  once. Check profile/post media and push delivery if enabled.
- Game sign-in restores an existing character and cloud save; movement, chat,
  inventory/bank and one controlled reward transaction work. Confirm no duplicate
  payout or unexpected balance change. Private sprite collections remain present;
  do not buy a paid generation merely to test migration.
- Check `/gm` via its usual route and account, including trusted proxy/IP rules.
  Verify any bot/companion integrations that remain on another host.
- On `.24`, inspect `systemctl status` and recent journals for all four units.
  On `.23`, confirm all four remain inactive and disabled. Watch errors, disk,
  authentication and wallet behavior for 30–60 minutes before declaring success.

## Failure and rollback

The controller records its last phase and both private staging paths in
`artifacts/migration-<run>/state.json`. It **does not restart the old services
automatically**. Read the phase and remote markers before retrying. A partially
restored target is intentionally rejected by a fresh migration invocation.

**Before `target-start-attempted`:** verify no destination app has actually run.
Keep maintenance active and stop/disable any destination app units that were
installed. The source data remains the authoritative copy. On `.23`, remove
only the four `90-lidoll-migration-fence.conf` files created by this run, run
`systemctl daemon-reload`, restore each unit's original enabled state from the
manifest, and start auth → tracker → quest → gallery. Keep/revert proxy upstreams
to `.23`, verify health, then reopen traffic. Keep the partial target isolated for
inspection instead of deleting its data reflexively.

**At or after `target-start-attempted`:** treat `.24` as potentially changed even
if public traffic never opened. Background outbox delivery can change the wallet.
Pause traffic and external callers, stop all new services, and preserve a fresh
coordinated backup of **all four current data trees**. Prefer repairing `.24`.
If returning to `.23`, carry the complete latest state back under maintenance,
preserving the frozen pre-migration copy separately, then restore `.23` network
settings and service ownership. Never simply restart its old databases or restore
only `market.sqlite`/`quest.sqlite`: that can lose or duplicate economic history.
Accepting loss of post-migration activity requires an explicit recovery decision.

After successful cutover, retain the old frozen backup and stopped installation
for at least 48 hours and take a separate off-host backup of `.24`. Retire old
hosts/backups according to your retention policy. The private staging copies
contain authentication keys and personal data: use the **exact** paths in the run
record to remove those directories from each host once recovery no longer needs
them; keep the root-owned frozen backup. Never use a broad cleanup wildcard.

SQLite WAL files can contain committed data absent from the main database file.
The migration therefore copies entire stopped data directories; an ad hoc live
copy of a `.sqlite` file is not a substitute. [SQLite WAL documentation](https://www.sqlite.org/wal.html).

## Local validation

```bash
bash -n deploy/migrate-lidoll-services.sh
bash deploy/migrate-lidoll-services.sh --help
python3 python/test_lidoll_migration.py
python3 python/test_lidoll_migration_controller.py
```

The Python suite uses temporary files and mocked service commands. It covers
credential-preserving edits, duplicate settings, archive traversal/link/type
rejection, source-host identity, occupied target units, checksum failure before
extraction, source stop/fence ordering and refusal to start before a verified
restore. It does not replace running the source inventory and target preparation
against the actual hosts. The controller suite runs the actual Bash entry point
with fake SSH/SCP commands to check the default inspection, maintenance gate,
preparation failures and copy/restore/start order without contacting a server.
No migration has been executed by creating these files.
