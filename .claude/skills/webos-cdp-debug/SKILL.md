---
name: webos-cdp-debug
description: Attach to the LG C3 (or desktop Chrome) via raw Chrome DevTools Protocol to drive the Nuvio TV app, capture performance traces, and debug d-pad navigation/rendering bugs live on-device. Use for any "why is this laggy/janky/stuck on the TV" investigation, or whenever the chrome-devtools-mcp tools fail to attach.
---

# webOS CDP debug rig

Raw CDP driver for driving and profiling the Nuvio app on the LG C3 (webOS 25) or
desktop Chrome, without depending on `chrome-devtools-mcp` (which has a known
failure mode on this device — see Gotchas). Scripts live in `references/`.

## When to use this vs `chrome-devtools-mcp`

Try the MCP tools first — `list_pages`, `take_screenshot`, etc. If `list_pages` or
`Network.enable` fails/times out (common cause: a backgrounded YouTube page target
is also open), fall back to this skill's raw `cdp.mjs` script, which never touches
`Network.enable` and only needs the plain HTTP `/json/list` endpoint + a
WebSocket.

## Setup

1. Copy `references/cdp.mjs`, `references/analyze-trace.mjs`, `references/drill.mjs`
   into the session scratchpad (they need a writable dir for trace/screenshot
   output; running them in place also works if the skill directory is writable).
2. Find the device endpoint:
   - **LG C3 (direct, preferred)**: the TV exposes a full CDP endpoint at
     `http://<tv-ip>:9998` (port confirmed working previously at
     `192.168.1.100:9998` — reconfirm with the user if the TV's IP changed).
     Includes a browser-level `webSocketDebuggerUrl`.
   - **Fallback**: `ares-inspect -d lgc3 --app space.nuvio.webos --open` opens a
     local proxy (page targets only). Find its port via `lsof -i -P | grep node`.
   - **Desktop**: launch Chrome with `--remote-debugging-port=9223
     --user-data-dir=<scratch-dir>`, use the app's "Continue without account"
     guest path if auth-gated.
3. If the app isn't in the target list (`curl http://<host>:<port>/json/list`),
   it's not running — `ares-launch -d lgc3 space.nuvio.webos` to start it, then
   wait a few seconds and re-check.
4. All commands take `CDP_HOST`, `CDP_PORT`, `CDP_MATCH` (a substring to find the
   right page target, e.g. `nuvio` — otherwise it may grab a stray YouTube tab).

```bash
CDP_HOST=192.168.1.100 CDP_PORT=9998 CDP_MATCH=nuvio node cdp.mjs shot out.png
CDP_HOST=192.168.1.100 CDP_PORT=9998 CDP_MATCH=nuvio node cdp.mjs eval "document.title"
```

## Driving the app

- **Prefer `waitFor`/`pressAndWait` over `key ...; sleep <guess>; eval <check>`.**
  The sleep-then-check pattern either checks too early (flaky on a slow
  transition) or pads every call with dead time (too late). `waitFor`/
  `pressAndWait` poll every ~150ms and return the instant the condition is
  true, in one process instead of three. Reserve a plain `sleep` for cases
  with no observable DOM condition to poll (rare).
- `key <Key> [count] [delayMs]` dispatches **discrete** press/release pairs —
  `event.repeat` is always `false`. This is what a real user *rapidly tapping*
  a button produces, and it's a genuinely different code path from a held key
  in apps that have a fast-scroll/fast-path optimization gated on
  `event.repeat` (this app's home screen does — see cdp-perf-debug-rig memory).
- `keyrepeat <Key> [count] [delayMs]` simulates a **held** key: `autoRepeat:
  true` on the CDP call produces `event.repeat === true` in the page, matching
  real OS-level key-repeat. Use this specifically when a bug might depend on
  `event.repeat` — don't assume fast taps and a held key exercise the same code.
- `type '<text>'` uses `Input.insertText`, not a synthetic DOM `input` event —
  the app only reacts to real input, a plain `dispatchEvent(new Event("input"))`
  silently does nothing.

## Performance tracing workflow

1. Get the app into the state you want to profile (navigate there first).
2. `trace out.json <durationMs> [keySpec]` — e.g. `trace t.json 3500
   "ArrowDown:14:100"` records a trace while driving 14 ArrowDown presses
   100ms apart. `keySpec` uses discrete taps (see above) — for a held-key
   variant, drive the trace's duration manually and issue a separate
   `keyrepeat` call, or extend the script.
3. `node analyze-trace.mjs out.json` — auto-detects the `CrRendererMain`
   thread, prints long tasks (>16ms), style recalc / layout cost, DrawFrame/
   DroppedFrame counts and worst frame gaps, approx average fps, and the top
   event names by total duration. Start here for the overall picture.
4. `node drill.mjs out.json [topN=5]` — breaks down the N longest
   `RunTask`/`Commit` events into their child event costs, and surfaces any
   `FunctionCall` events with real function names/line/col (the webOS dev
   build is **not minified** — `app.bundle.js:<line>:<col>` combined with
   `awk 'NR==<line>' dist/app.bundle.js | cut -c<col-100>-<col+300>` reliably
   identifies the actual source function, turning "what code is this" into a
   one-shot answer instead of guesswork).
5. For a genuinely mysterious value (not visible in static code, and drill.mjs
   isn't enough), patch a DOM primitive directly on the live page and read
   `Error().stack` at the moment it fires — e.g. wrap `HTMLImageElement.
   prototype.setAttribute` or override an `Element.prototype.innerHTML`
   setter via `Object.defineProperty`, filtered to the class/attribute you
   care about. This has repeatedly resolved bugs that pure code-reading missed
   (see cdp-perf-debug-rig memory for worked examples: hero backdrop/logo
   desync, `this.rows`-vs-DOM index mismatches).

## Gotchas (each cost real time to discover — don't re-learn them)

- **`Runtime.enable` replays the ENTIRE historical console buffer** as a burst
  of `consoleAPICalled` events on every attach, not just new messages. A
  naive "enable then capture" script is useless for isolating one event from
  session noise. Mark a sentinel via `Runtime.evaluate` (e.g.
  `console.warn(SENTINEL)`) immediately after enabling, and only keep lines
  logged after it. `cdp.mjs consolerepeat` already does this correctly.
- **`DrawFrame`/`DroppedFrame` trace events are instant markers (`ph:"I"`),
  not complete events (`ph:"X"`)** — filtering by `ph==="X"` silently drops
  every one of them and any fps calculation built on that filter comes out
  `0`/`NaN` with no error. `analyze-trace.mjs` here is already fixed; don't
  reintroduce the `ph==="X"` filter on these two event names.
- **`chrome-devtools-mcp`'s `list_pages`/`Network.enable` can time out** when a
  backgrounded YouTube page target is also open on the device. Raw `cdp.mjs`
  against the nuvio page target directly (never touches `Network.enable`)
  works regardless.
- **Only one debugger client per page target** — attaching a second one (e.g.
  opening the browser's own inspector, or a second `ares-inspect`) kicks
  whoever was already attached.
- **The device can go fully unreachable** (ping timeout, not just CDP) if the
  TV goes to sleep/standby after being idle. Nothing to do but wait for the
  user to confirm it's back on — don't loop retrying indefinitely.
- **`ares-push`/`ares-shell`** (which would let you push a single changed file
  instead of a full rebuild-package-install-launch cycle) report "not
  supported by current profile (`<tv>`)" on this device. Unlocking them means
  `ares-config -p <profile>`, a device-wide CLI config change with unclear
  side effects on the existing devmode pairing — flag this to the user rather
  than trying it unprompted. The full cycle (`npm run build` ~5s →
  `package:webos` → `ares-install -d lgc3 <ipk>` → `ares-launch -d lgc3
  space.nuvio.webos`, ~30-40s total) remains the only available path to get
  new JS onto the real TV; batch multiple source edits into one cycle rather
  than rebuilding per edit.
- **A fresh `ares-launch` does NOT reload the JS context if the app is already
  running** — it just resumes/refocuses the existing webview. Any
  `window.__foo` globals or monkey-patches from a previous test survive. Use
  `node cdp.mjs eval "location.reload()"` for a genuinely clean JS context
  when a test needs one (e.g. verifying a bug isn't an artifact of earlier
  instrumentation).
- **Screenshot-based verification can lag reality** — `Page.captureScreenshot`
  can return a stale/mid-transition frame right after a navigation; a
  `waitFor` on a real DOM condition is more reliable than "sleep then
  screenshot".

## Project-specific context

See the `cdp-perf-debug-rig` memory entry for this project's accumulated
findings (specific fps numbers, specific bugs found/fixed, specific line
numbers) — this skill is the reusable *tooling and technique*, that memory is
the *history*.
