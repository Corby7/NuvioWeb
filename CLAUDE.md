# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

Personal fork (`Corby7/NuvioWeb`, branch `fable-improvements`) of `NuvioMedia/NuvioWeb` — a
web-based TV client for the Stremio addon ecosystem. Vanilla JS (no framework), bundled with
esbuild into a single `app.bundle.js`. Ships as browser app, Samsung Tizen `.wgt`, and LG
webOS `.ipk`.

**Primary target: LG C3, webOS 25 (Chromium ~120).** Perf decisions assume one modern device;
upstream supports legacy engines (Chromium 38+), this fork deliberately does not have to.

## Hard rules

- **Never `git commit` or push without explicit user approval.** Finish the work, verify,
  report the uncommitted diff, and ask.
- The dev server (`npm run serve`, port 4173) serves **`dist/`**, not source. Changes are
  invisible until `npm run build` completes.
- Don't take upstream code that fights the fork architecture (see below). When upstream and
  fork conflict, fork wins unless the user says otherwise.

## Commands

```bash
npm run build            # esbuild + babel + postcss → dist/  (must run to see changes)
npm run serve            # static server on :4173, serves dist/ (often already running)
npm run package:webos    # build + create .ipk
npm run install:webos    # ares-install to the TV
npm run logs:webos       # TV logs
npx eslint <files>       # upstream's flat config (eslint.config.mjs)
```

## Verification workflow (do all three — syntax checks miss runtime bugs)

1. `node --input-type=module --check < <file>` — syntax
2. `npx eslint <file>` and look at `no-undef` — catches spliced/undefined references.
   Known false positives: `__NUVIO_APP_VERSION__` (esbuild define in `scripts/build.mjs`),
   `qrcode` (global from `assets/libs/qrcode-generator.js` script tag in `index.html`).
3. `npm run build` — zero `▲ [WARNING]` expected; duplicate-object-key warnings mean a merge
   left two definitions and the later one silently wins.

Skip this for trivial, mechanically-obvious edits with no logic surface — swapping an SVG
icon path, a string constant, a single CSS declaration. Reserve full verification for changes
touching control flow, data handling, async code, or focus/nav.

## Layout

```
js/app.js                  boot: polyfills, platform detect, auth gate, StartupSyncService
js/ui/navigation/          router.js (lazy factories), focusEngine.js, screen.js (ScreenUtils)
js/ui/screens/<area>/      one dir per screen (home, detail, stream, player, settings, …)
js/ui/components/          sidebarNavigation, rootSidebarController, nuvioDialog, filterPicker
js/core/                   auth, profile sync services, player controller, storage, network
js/data/local/             *Store.js (localStorage-backed, profile-scoped)
js/data/repository/        content/addon/subtitle repositories
js/data/remote/supabase/   supabaseApi (RPC wrapper), auth
js/platform/               browser / webos / tizen adapters
css/components.css         nearly all styling (~17k lines); css/base.css, themes.css
scripts/build.mjs          bundler; defines __NUVIO_APP_VERSION__
local.properties           runtime env source (gitignored) — build generates dist/nuvio.env.js
                           from it via scripts/envProperties.mjs; if missing, build falls back
                           to local.example.properties (all-empty!) with only a console WARNING.
                           Root nuvio.env.js is legacy and no longer read by the build.
```

## Fork architecture — preserve these

- **Lazy-factory router** (`router.js`): screens load via `_lazyFactories` + `ROUTE_PRELOADS`.
  New routes need a factory entry there, not an eager import.
- **RootSidebarController** (`rootSidebarController.js`): persistent `#root-nav-sidebar` div in
  `renderAppShell.js`; screens `register()/unregister()` expand/collapse hooks. Screens use
  `nav-screen` / `nav-screen-body` wrapper classes. Upstream renders sidebars per-screen — don't
  reintroduce that.
- **Key handling**: `FocusEngine.handleKey` → `currentScreen.onKeyDown`. Screens drive their own
  pickers/dialogs. `NuvioDialog` owns its keys via capture-phase window listener.
  **Do not gate `handleKey` on `nuvio-modal-open`** — a stuck class kills all d-pad input
  (pointer paths may keep that guard). This regressed once already.
- **Subtitle engine** (fork rework): `player/subtitleEngine.js` + `subtitleOverlay.js`, HTML
  render mode with a one-time migration flag (`subtitleRenderModeMigratedToHtml`),
  `subtitleDelayMs` is persisted (upstream keeps it session-only — keep fork behavior).
  `subtitleDialog.js` was deleted; don't resurrect it.
- **Boot resilience**: `app.js` `awaitBootSyncValue()` bounds all boot-time sync pulls (parallel
  `Promise.all`); `authManager` keeps the session on refresh 5xx/timeouts (only 4xx signs out);
  `httpClient` uses `fetchWithTimeout` (20s default, `timeoutMs` option). Never add short
  timeouts to Supabase RPCs — an aggressive 8s timeout once caused sync pulls to fail while the
  following push clobbered remote data.
- **Perf idioms**: deferred batched `localStorage` writes (`localStore.js` — flushes on
  visibilitychange/pagehide); `content-visibility: auto` + `contain-intrinsic-*` for row/card
  virtualization (home rows, episode cards) with a `.focused`/`:focus-within` exemption so focus
  rings aren't clipped — prefer this over JS windowing; episode thumbnails hydrate lazily via
  IntersectionObserver (`data-thumb` → `observeEpisodeThumbnails`); rails scroll via transforms
  and `scrollLeft` math in `metaDetailsScreen.getHorizontalTrackScrollLeft`.
- **TMDB images**: sized variants (`w500` posters, `w1280` backdrops, `w185` logos), never
  `/original`.

## Upstream relationship

- Remote `upstream` = `NuvioMedia/NuvioWeb`. Last merged: 0.3.8-beta (merge commit `c0a9919`).
- Upstream ran Prettier repo-wide, so `git diff`/cherry-picks are full of formatting noise —
  compare with `git diff -w` and count real changes before deciding merge direction.
- Fork-dominant files (ours wins, port upstream fixes by hand): `homeScreen.js`,
  `metaDetailsScreen.js`, `playerScreen.js`, `playerController.js`, `streamScreen.js`,
  `searchScreen.js`, `discoverScreen.js`, `libraryScreen.js`, `sidebarNavigation.js`,
  `router.js`, `screen.js`, `subtitleRepository.js`, `components.css`.
- Pre-merge fork reference point: commit `df71b44` (restore files from it with
  `git show df71b44:<path>` when a merge regression must be rolled back exactly).

## Sync / backend

- Backend is the Nuvio team's Supabase at `https://api.nuvio.tv` (configured in
  `local.properties`; the old `dpyhjjcoabcglfmgecug.supabase.co` project is dead — keyed
  requests 522). Current official values can be read from
  `https://web.nuvioapp.space/nuvio.env.js`. The local Supabase MCP points at a *different,
  empty* project — useless for inspecting app data.
- Sync: `StartupSyncService` pulls on auth + every 120s, then pushes. All services are
  RPC-blob-based (`sync_pull_*` / `sync_push_*`), keyed by profile id. Collections JSON flows
  through verbatim — new folder fields (e.g. `heroVideoUrl`, `heroBackdropUrl`, `titleLogoUrl`,
  `focusGifUrl`) only need `collectionsStore.normalizeFolder` support.
- Collection hero videos: muted, plays once (no loop) H.264 MP4 (yuv420p, faststart, no audio) mounted by
  `homeScreen.syncCollectionHeroMedia`. Assets live in `Corby7/nuvio-assets` on GitHub, served
  via jsDelivr (`https://cdn.jsdelivr.net/gh/Corby7/nuvio-assets@main/...`); pipeline script:
  `nuvio-assets/scripts/make-ident.sh`. Never use animated GIF for full-screen surfaces —
  no hardware decode path on TV.

## webOS specifics

- Native `<video>` H.264/HEVC is hardware-decoded; GIF/canvas work is CPU-bound — prefer video.
- Luna calls go through `WebOsLunaService`; media commands need the pipeline `mediaId`
  (`waitForNativeMediaId`). Audio-track switching must be confirmed
  (`requestConfirmedWebOsAudioTrackSelection`) — fire-and-forget `selectTrack` silently fails.
- App is packaged to run from `file://`; Supabase traffic can route through the native service
  proxy (`webosSupabaseProxy`). YouTube embeds reject `file://` origins (error 153) — an https
  `YOUTUBE_PROXY_URL` is preferred on TV.
- `package:webos` uses app name "Nuvio TV (Dev)" and `--no-minify` (deliberate local tweaks).
