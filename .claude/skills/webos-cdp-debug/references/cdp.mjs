// Minimal CDP client over Node's native WebSocket. Usage:
//   node cdp.mjs eval '<js expression>'         — evaluate in page, print result
//   node cdp.mjs shot <outfile.png>             — screenshot
//   node cdp.mjs key <DomKey> [count] [delayMs] — dispatch keydown/up (e.g. ArrowRight)
//   node cdp.mjs keyrepeat <DomKey> [count] [delayMs] — held-key auto-repeat (event.repeat:true)
//   node cdp.mjs waitFor '<expr>' [timeoutMs=8000] [intervalMs=150]
//        — poll a JS expression until truthy or timeout; prints elapsed ms +
//        final value. PREFER THIS over "sleep <guess>; eval <check>" for any
//        screen transition / async wait — no wasted fixed delay, no flaky
//        premature check on a slow one.
//   node cdp.mjs pressAndWait <DomKey> <count> <delay> '<wait-expr>' [timeoutMs] [intervalMs]
//        — dispatch key(s) then poll wait-expr, all in ONE process (collapses
//        the "key ...; sleep N; eval ..." 3-call pattern into 1 call).
//   node cdp.mjs type '<text>'                  — Input.insertText into a focused field
//        (use this, not a synthetic 'input' event dispatch — the app only
//        reacts to real input events, which insertText produces)
//   node cdp.mjs consolerepeat <key> <count> <delay> <captureMs>
//        — held-key repeat while capturing console.* output. Runtime.enable
//        replays the ENTIRE historical console buffer as a burst on attach,
//        so this marks a sentinel via Runtime.evaluate first and only keeps
//        lines logged after it — a plain capture is useless otherwise.
//   node cdp.mjs watch '<expr>' <durationMs> <intervalMs> [keySpec]
//        — poll-and-print an expression repeatedly (for watching a value
//        change over time, not for a single true/false wait — use waitFor
//        for that).
//   node cdp.mjs metrics                        — Performance.getMetrics
//   node cdp.mjs trace <outfile.json> <ms> [keySpec] — record a trace for <ms>,
//        optionally driving keys: e.g. "ArrowDown:6:250" = 6 presses, 250ms apart.
//        Analyze with analyze-trace.mjs / drill.mjs in this same directory.
const PORT = Number(process.env.CDP_PORT || 9223);
const HOST = process.env.CDP_HOST || "127.0.0.1";
const MATCH = process.env.CDP_MATCH || "";

async function pageTarget() {
  const list = await (await fetch(`http://${HOST}:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page"
    && (MATCH
      ? (t.url.includes(MATCH) || (t.title || "").includes(MATCH) || (t.description || "").includes(MATCH))
      : t.url.startsWith("http")));
  if (!page) throw new Error("no page target: " + list.map((t) => `${t.type}:${t.url}`).join(", "));
  return page;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const events = [];
    const listeners = new Map();
    ws.onopen = () => resolve({
      send(method, params = {}, sessionId) {
        return new Promise((res, rej) => {
          const msgId = ++id;
          pending.set(msgId, { res, rej });
          ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
      },
      on(method, fn) { listeners.set(method, fn); },
      events,
      close() { ws.close(); }
    });
    ws.onerror = () => reject(new Error("ws error"));
    ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data);
      if (data.id && pending.has(data.id)) {
        const { res, rej } = pending.get(data.id);
        pending.delete(data.id);
        if (data.error) rej(new Error(data.error.message)); else res(data.result);
      } else if (data.method) {
        events.push(data);
        const fn = listeners.get(data.method);
        if (fn) fn(data.params);
      }
    };
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dispatchKey(cdp, key, code, keyCode, repeat = false) {
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base, ...(repeat ? { autoRepeat: true } : {}) });
  if (!repeat) {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }
}

const KEYS = {
  ArrowRight: ["ArrowRight", 39], ArrowLeft: ["ArrowLeft", 37],
  ArrowDown: ["ArrowDown", 40], ArrowUp: ["ArrowUp", 38],
  Enter: ["Enter", 13], Escape: ["Escape", 27], Backspace: ["Backspace", 8]
};

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const target = await pageTarget();
  const cdp = await connect(target.webSocketDebuggerUrl);

  if (cmd === "eval") {
    const r = await cdp.send("Runtime.evaluate", { expression: args[0], returnByValue: true, awaitPromise: true });
    console.log(JSON.stringify(r.result.value ?? r.result.description ?? r.result, null, 2));
  } else if (cmd === "shot") {
    const r = await cdp.send("Page.captureScreenshot", { format: "png" });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(args[0], Buffer.from(r.data, "base64"));
    console.log("saved", args[0]);
  } else if (cmd === "type") {
    await cdp.send("Input.insertText", { text: args[0] });
    console.log(`inserted text: ${args[0]}`);
  } else if (cmd === "key") {
    const [name, keyCode] = KEYS[args[0]] || [args[0], 0];
    const count = Number(args[1] || 1);
    const delay = Number(args[2] || 200);
    for (let i = 0; i < count; i++) { await dispatchKey(cdp, name, name, keyCode); await sleep(delay); }
    console.log(`dispatched ${args[0]} x${count}`);
  } else if (cmd === "waitFor") {
    // node cdp.mjs waitFor '<js-expression>' [timeoutMs=8000] [intervalMs=150]
    // Polls the expression until truthy or timeout. Prints elapsed ms + the
    // final value. Replaces "sleep <guess>; eval <check>" — no wasted fixed
    // delay, and no premature check on a slow transition.
    const [expr, timeoutMsArg, intervalMsArg] = args;
    const timeoutMs = Number(timeoutMsArg || 8000);
    const intervalMs = Number(intervalMsArg || 150);
    const start = Date.now();
    let value;
    while (Date.now() - start < timeoutMs) {
      const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      value = r.result.value;
      if (value) {
        console.log(`ok ${Date.now() - start}ms ${JSON.stringify(value)}`);
        cdp.close();
        return;
      }
      await sleep(intervalMs);
    }
    console.log(`timeout ${timeoutMs}ms last=${JSON.stringify(value)}`);
  } else if (cmd === "pressAndWait") {
    // node cdp.mjs pressAndWait <key> <count> <delay> '<wait-expr>' [timeoutMs=8000] [intervalMs=150]
    // Dispatches the key(s) then polls wait-expr in the SAME process — the
    // three-call "key ...; sleep N; eval ..." pattern collapses to one call,
    // and the wait ends the instant the condition is true instead of a fixed
    // guessed sleep.
    const [name, keyCode] = KEYS[args[0]] || [args[0], 0];
    const count = Number(args[1] || 1);
    const delay = Number(args[2] || 200);
    const expr = args[3];
    const timeoutMs = Number(args[4] || 8000);
    const intervalMs = Number(args[5] || 150);
    for (let i = 0; i < count; i++) { await dispatchKey(cdp, name, name, keyCode); await sleep(delay); }
    if (!expr) {
      console.log(`dispatched ${args[0]} x${count}`);
    } else {
      const start = Date.now();
      let value;
      while (Date.now() - start < timeoutMs) {
        const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
        value = r.result.value;
        if (value) {
          console.log(`ok ${Date.now() - start}ms ${JSON.stringify(value)}`);
          cdp.close();
          return;
        }
        await sleep(intervalMs);
      }
      console.log(`timeout ${timeoutMs}ms last=${JSON.stringify(value)}`);
    }
  } else if (cmd === "keyrepeat") {
    // Simulate OS-level held-key auto-repeat: N keydown(repeat:true) events, no
    // keyup between them, one keyup at the end. node cdp.mjs keyrepeat ArrowDown 14 100
    const [name, keyCode] = KEYS[args[0]] || [args[0], 0];
    const count = Number(args[1] || 1);
    const delay = Number(args[2] || 100);
    for (let i = 0; i < count; i++) {
      await dispatchKey(cdp, name, name, keyCode, i > 0);
      await sleep(delay);
    }
    const base = { key: name, code: name, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    console.log(`dispatched held ${args[0]} x${count}`);
  } else if (cmd === "consolerepeat") {
    // node cdp.mjs consolerepeat <key> <count> <delay> <captureMs>
    const [name, keyCode] = KEYS[args[0]] || [args[0], 0];
    const count = Number(args[1] || 1);
    const delay = Number(args[2] || 100);
    const captureMs = Number(args[3] || 2000);
    let seenSentinel = false;
    const sentinel = "___SENTINEL_" + Date.now() + "___";
    const lines = [];
    cdp.on("Runtime.consoleAPICalled", (p) => {
      const text = (p.args || []).map((a) => {
        if (a.type === "string") return a.value;
        if (a.value !== undefined) return JSON.stringify(a.value);
        if (a.preview) return JSON.stringify(a.preview.properties?.reduce((o, x) => (o[x.name] = x.value, o), {}));
        return a.description || "";
      }).join(" ");
      if (!seenSentinel) {
        if (text.includes(sentinel)) seenSentinel = true;
        return;
      }
      lines.push(text);
    });
    await cdp.send("Runtime.enable");
    // Runtime.enable replays the full historical console buffer as a burst of
    // consoleAPICalled events — mark a sentinel and only keep lines after it.
    await cdp.send("Runtime.evaluate", { expression: `console.warn(${JSON.stringify(sentinel)})` });
    for (let i = 0; i < count; i++) {
      await dispatchKey(cdp, name, name, keyCode, i > 0);
      await sleep(delay);
    }
    const base = { key: name, code: name, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(captureMs);
    console.log(lines.join("\n"));
  } else if (cmd === "watch") {
    // node cdp.mjs watch '<expr>' <durationMs> <intervalMs> [keySpec]
    const [expr, durMs, intMs, keySpec] = args;
    const duration = Number(durMs || 5000);
    const interval = Number(intMs || 200);
    const start = Date.now();
    if (keySpec) {
      const [k, kc] = KEYS[keySpec] || [keySpec, 0];
      dispatchKey(cdp, k, k, kc); // fire and forget, don't block the watch loop
    }
    while (Date.now() - start < duration) {
      const t = Date.now() - start;
      let val;
      try {
        const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: false });
        val = r.result.value ?? r.result.description;
      } catch (e) { val = "ERR:" + e.message; }
      console.log(`${t}ms\t${JSON.stringify(val)}`);
      await sleep(interval);
    }
  } else if (cmd === "metrics") {
    await cdp.send("Performance.enable");
    const r = await cdp.send("Performance.getMetrics");
    console.log(Object.fromEntries(r.metrics.map((m) => [m.name, m.value])));
  } else if (cmd === "trace") {
    const [outfile, msArg, keySpec] = args;
    const ms = Number(msArg || 3000);
    const chunks = [];
    let done;
    const finished = new Promise((r) => { done = r; });
    cdp.on("Tracing.dataCollected", (p) => chunks.push(...p.value));
    cdp.on("Tracing.tracingComplete", () => done());
    await cdp.send("Tracing.start", {
      transferMode: "ReportEvents",
      categories: [
        "devtools.timeline", "disabled-by-default-devtools.timeline",
        "disabled-by-default-devtools.timeline.frame", "v8.execute",
        "blink.user_timing", "loading", "disabled-by-default-lcp_critical_path_predictor",
        ...(process.env.CDP_EXTRA_CATS ? process.env.CDP_EXTRA_CATS.split(",") : [])
      ].join(",")
    });
    await sleep(300);
    if (keySpec) {
      const [k, cnt, dly] = keySpec.split(":");
      const [name, keyCode] = KEYS[k] || [k, 0];
      for (let i = 0; i < Number(cnt || 1); i++) { await dispatchKey(cdp, name, name, keyCode); await sleep(Number(dly || 250)); }
    }
    const elapsed = 300 + (keySpec ? (Number(keySpec.split(":")[1] || 1) * Number(keySpec.split(":")[2] || 250)) : 0);
    if (ms > elapsed) await sleep(ms - elapsed);
    await cdp.send("Tracing.end");
    await finished;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(outfile, JSON.stringify({ traceEvents: chunks }));
    console.log(`trace saved: ${outfile} (${chunks.length} events)`);
  } else {
    console.log("unknown cmd");
  }
  cdp.close();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
