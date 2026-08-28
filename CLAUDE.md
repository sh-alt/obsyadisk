# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

ObsYaDisk — an Obsidian plugin that syncs a vault with Yandex.Disk over its REST API, with git-based version history built on isomorphic-git. Single-plugin repo (not a monorepo); `main.js` is a generated esbuild bundle, never edit it directly — edit `src/*.ts`.

## Commands

```bash
npm install
npm run dev       # esbuild watch-less dev build, inline sourcemaps, no type errors required
npm run build     # tsc -noEmit (type check) + production esbuild bundle (minified, no sourcemap)
```

There is no test suite and no lint script. `npm run build` (specifically the `tsc -noEmit -skipLibCheck` step) is the only automated correctness check — always run it after TypeScript changes.

To manually verify a change, build then copy `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/obsyadisk/` of a real Obsidian vault and reload the plugin (Obsidian must be restarted or the plugin disabled/re-enabled to pick up a new `main.js`).

## Architecture

Everything lives in `src/`, wired together from `src/main.ts` (the `Plugin` subclass — commands, ribbon icon, status bar, sync timer, OAuth protocol handler).

- **`sync-engine.ts`** — the sync algorithm. Compares local vs remote state per file using MD5 (Yandex's `md5` field vs. a local SparkMD5 hash), with an mtime shortcut that skips recomputing the local hash when `stat.mtime` hasn't changed since the last run. Produces a list of `SyncAction`s (`upload` / `download` / `delete-local` / `delete-remote` / `conflict`). Persists per-file state (`localHash`, `mtime`, `remoteHash`, `remoteMd5`, `lastSyncedHash`, `lastSyncedRemoteHash`) to `.obsyadisk-state.json` in the vault root via `loadState`/`saveState`. Supports cooperative abort (`abort()` / `isAbortRequested()` / `wasAborted()`) checked between file operations so a running sync can be stopped from the UI.
- **`yandex-disk-client.ts`** — thin REST client for the Yandex.Disk API. Uses Obsidian's `requestUrl` (not `fetch`) so it works from a sandboxed WebView on mobile without CORS issues.
- **`yandex-oauth.ts`** — OAuth 2.0 against `oauth.yandex.ru`. Desktop uses the authorization-code flow (`response_type=code` → POST to exchange for a token); mobile uses the implicit/token flow (`response_type=token`, token returned directly in the redirect) because mobile WebViews can't reliably do the code-exchange POST. Both flows redirect to the custom `obsidian://obsyadisk-auth` protocol, registered via `registerObsidianProtocolHandler` in `main.ts`. Ships a `BUNDLED_CLIENT_ID` so most users don't need to register their own Yandex OAuth app.
- **`git-versioning.ts`** — wraps isomorphic-git to auto-commit the vault after every sync. The private `GitFsAdapter` class maps the subset of the Node `fs.promises` API isomorphic-git needs onto Obsidian's `Vault.adapter` (works on both desktop and mobile, no real filesystem access needed). The repo lives in a hidden `.obsyadisk-git/` folder inside the vault. **Gotcha:** when writing binary data, `Uint8Array.buffer` alone returns the *entire* backing `ArrayBuffer` regardless of the view's offset/length — you must slice by `byteOffset`/`byteLength` or git objects/pack files get silently corrupted (see `writeFile` in `GitFsAdapter`).
- **`conflict-modal.ts`** / **`diff-modal.ts`** — UI for resolving sync conflicts (prefer-local / prefer-remote / view diff) and rendering split-view or unified diffs (via the `diff` package).
- **`version-history-modal.ts`** — browses the git log and restores a single file to a past version.
- **`settings-tab.ts`** — plugin settings UI; `types.ts` defines `ObsYaDiskSettings` and `DEFAULT_SETTINGS`.
- **`utils.ts`** — MD5 hashing (spark-md5), glob-style exclude-pattern matching, debounce, date formatting, path normalization.
- **`src/shims/fs-shim.ts`** — a no-op stub esbuild aliases `fs` to (see `esbuild.config.mjs`), since isomorphic-git imports Node's `fs` module even though the real filesystem access always goes through the injected `GitFsAdapter`, never through this shim.

### Path conventions

Yandex.Disk API resource paths come back prefixed with `disk:` (e.g. `disk:/ObsidianSync/note.md`) and use the configured `remoteFolderPath` as a base; `sync-engine.ts`'s `remotePath()`/`localPath()` convert between that and vault-relative paths (which never have a leading slash, per Obsidian's `Vault.adapter`). When stripping the remote base to recover a local path, guard against `..` path-traversal segments (see `localPath()`).

### Build target

esbuild bundles `src/main.ts` → `main.js` (CJS, ES2018, `platform: "browser"`). Obsidian/Electron/CodeMirror packages are `external`; most other Node builtins are excluded from the bundle except the ones isomorphic-git needs (`buffer`, `stream`, `process`, `events`, `util`, `path`, `crypto`, `assert`, `http`, `https`, `zlib`, `fs`), which get bundled/shimmed so the plugin also works on mobile (`isDesktopOnly: false` in `manifest.json`).

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
