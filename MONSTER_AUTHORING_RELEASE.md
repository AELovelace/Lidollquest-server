# Monster authoring release

The Monsters tab now has a searchable library, a five-step creation wizard, and sections for existing monsters. The scene editor exposes shipped first/repeat/charm dialogue and aftermath variants, with page lists and branching previews. Editing stats retains inherited defaults; Restore default removes a scene override when the draft is saved/published.

## Upload and activate

1. Update the tracker from the supplied `little-log` archive using its normal deployment procedure and restart `lidoll-tracker`. Its shared browser/Windows proxy now permits bounded 1 MiB gameplay responses for longer authored scenes; other response limits remain unchanged. No tracker database migration or new settings are needed.
2. Extract the supplied server archive to a **new checkout directory** on the Fedora VM. It includes `server/`, `python/`, `deploy/`, tests, and this guide. Do not replace `/etc/lidollquest/server.env` or `/var/lib/lidollquest-server` with package contents.
3. From that extracted directory run `sudo bash deploy/fedora-deploy.sh`. The existing installer checks configuration, stops the service, backs up its data, activates a new release, and checks health. The database migration adds job metadata without removing drafts, revisions, artwork, or existing jobs.
4. Upload the matching browser `game.zip` using the normal game deployment process and distribute the Windows `game.zip`. Reload the GM page; start a draft and confirm its default scenes and artwork previews appear.
5. Confirm `journalctl -u lidollquest-server -n 60 --no-pager` contains no startup failure. Generation continues using the existing `PIXELLAB_API_TOKEN` and Python configuration. There are no new environment variables.

## Creation and generation

Use Basics → Combat → Artwork → Defeat scenes → Review. Save and continue persists each step. Existing monsters use the same sections without the wizard. Save draft does not publish; Publish explicitly activates future definitions. Add a published monster to a zone pool or place it through Zones separately.

Generate design saves the draft and queues only character design. Inspect south/north/east/west views, then approve animation and portrait generation. Generate another design to try a different candidate. Use this portrait and walking sprite assigns completed art to the draft. Maps display 32×32 pixels; larger previews are explicitly zoomed. Generation Jobs links back to each monster.

Failed stages retain successful earlier assets. Known provider jobs resume polling after restart. `needs_review` means the provider may have accepted a submission before its ID arrived: inspect provider usage before explicitly resubmitting. Cancellation stops further processing but cannot refund provider work already submitted. Admin generation uses provider credits, not player diamonds or sprite slots.

Browser unsaved recovery is stored in session storage and offered through Recover unsaved draft. It contains draft content, not credentials. Revision conflicts keep local edits intact; Reload server draft explicitly discards them. Saved drafts are durable on the server.

## API and storage

`/gm/content` adds `effective_defeat`, `default_defeat`, and `defeat_source` to monster entries. Shipped scenes come from `defeat-scenes.json`; compiled previews come from `monster-artwork.json`. Admin overrides remain in SQLite. Immutable default-scene revisions are also retained there: map monsters store a small reference, and combat pins the full scene at entry. Scene schema 2 contains first/repeat and optional charm groups, each with named dialogue/aftermath variant arrays. Old first/repeat scene objects remain supported. Pages retain stable IDs; numeric imported links are normalized. Monster content is capped at 256 KiB, 16 variants per phase, 64 pages per variant, and eight choices per page.

`art_generate` accepts `monster`, expected content `revision`, and `prompt`. `art_approve`, `art_retry`, and `art_cancel` use the job `id` and `job_revision`; uncertain retries also require `confirm_resubmit: true`. `art_assign` includes expected content `revision`, job revision, and a completed `portrait` asset ID. All use `/gm/action`, GM authentication, request IDs, and the existing audit/receipt transaction. Jobs expose their monster, design asset, approval status, and revision without the provider key or private reference payload.

Back up the **entire** `/var/lib/lidollquest-server` directory with the service stopped (or use SQLite's backup API). Managed PNG assets, generation checkpoints, commands, drafts, and publication history are stored in the existing database. Include its WAL/SHM when making a live filesystem copy; copying only the SQLite file during writes is insufficient. Protect the environment-file backup separately. Retain the deployment's pre-upgrade database backup if reverting to older code.

## Validation

Run `npm test` in the server checkout. In the game checkout run `node python/tests/fixtures/world_admin_browser.mjs`, `py -3.11 -B -m unittest python.tests.test_monster_authoring python.tests.test_private_sprite_worker python.tests.test_editor_smoke python.tests.test_dialogue_option_dead_ends`, and `powershell -ExecutionPolicy Bypass -File ps/Test-MonsterNative.ps1`. The admin test mocks PixelLab and spends no credits. The native test executes production loading/drawing functions and checks 36 frames, exactly 32×32 map pixels, and portrait rendering.

Refresh exports with `py -3.11 -B python/export_online_combat.py --server-root C:/Scripts/Lidollquest-server` after source edits. The desktop Battle Dialogues source selector edits legacy dialogue or shared variant templates. It never changes deployed online overrides.
