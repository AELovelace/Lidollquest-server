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
