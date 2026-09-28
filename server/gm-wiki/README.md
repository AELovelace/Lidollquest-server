# GM wiki source

Served by the existing game server at `/gm/wiki/`. Open **GM wiki / Quest creation guide** from the GM panel or Story Workshop. Articles live in `content/*.md`; `pages.json` controls ordering, titles, descriptions and navigation groups.

The browser fetches Markdown and renders it using the vendored Marked and DOMPurify scripts. There is no build-time Markdown-to-HTML conversion, CDN, or separate wiki process. The layout, logo, CSS, renderer and vendored libraries are adapted from the game's `web/wiki` player wiki. Vendor licenses are retained in `vendor/`.

## Editing

1. Edit the relevant Markdown file in UTF-8. Link chapters as `flags.md` or `flags.md#preview-and-isolated-overrides`; the renderer rewrites these into hash routes.
2. To add a chapter, add the file and its entry in `pages.json`. Keep `source` equal to the Markdown filename and `slug` equal to its filename without `.md`.
3. Use one H1 per article, then descriptive H2/H3 headings. Tables, ordered steps, lists, quotes and code blocks use ordinary Markdown.
4. Match labels and behavior to `gm-flow-editor.js`, canonical editors and server validators. Distinguish drafts, published records, live map actions, preview and isolated tests. Do not promise unsupported behavior.
5. Run `node --test test/gm-wiki.test.mjs`. In the game checkout, run `node python/tests/fixtures/gm_wiki_browser.mjs` for browser/search/mobile checks.
6. Restart the game server after editing deployed files: release assets are loaded once at startup.

The static handbook is readable before sign-in, like the GM panel shell, behind the same configured TLS/address/enable restrictions. It contains no live character data, credentials or staff records. All GM editing APIs retain staff authentication. The route uses a fixed asset allowlist; arbitrary repository files are not exposed.

The `server/` directory already belongs to the deployment package, so no separate upload step or Python/Node documentation service is required. Publication of playable flows remains controlled by `QUEST_FLOWS_ENABLED`; reading the wiki does not enable it.

## Tutorial pictures

The first-quest tutorial includes real editor captures in `assets/tutorial/`, referenced from ordinary Markdown as `![Meaningful alt text](../assets/tutorial/01-workspace.png "Caption")`. Register every served picture in `illustrations.json`; the route exposes only that allowlist. Screenshots enlarge in a keyboard-accessible dialog with actual-size and original-image controls. Keep essential steps in text too.

Regenerate pictures from the game checkout with `node python/tests/fixtures/gm_tutorial_screenshots.mjs`. This boots an ephemeral local server with synthetic tutorial records, uses the actual GM screens, and writes PNGs to the server checkout (`QUEST_SERVER_ROOT` can override its path). Yellow numbered outlines are documentation callouts placed over the browser UI before capture. No production content or account data is used. Inspect regenerated pictures and update captions if the controls change.

## GM assistant retrieval

The separate npc-rag GM service indexes this directory, including screenshot alt text and optional quoted captions. After updating docs, sync this folder to its `GM_WIKI_SOURCE`, stop only the GM service, run `python -m npc_rag gm-build-index`, then restart it. Keep the player wiki index separate. The game server validates AI references against `pages.json`, image references in these Markdown pages, and `illustrations.json`; restart the game server after source changes. Only the game server calls port 9093; browser clients use its authenticated `/gm/help/chat` proxy. See [Using the assistant](content/ai-help.md).
