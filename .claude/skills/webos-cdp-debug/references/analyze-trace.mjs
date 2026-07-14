// Summarize a trace captured by cdp.mjs trace. Usage:
//   node analyze-trace.mjs <trace.json>
import { readFileSync } from "node:fs";

const file = process.argv[2];
const data = JSON.parse(readFileSync(file, "utf8"));
const events = data.traceEvents;

// Find the renderer main thread (CrRendererMain metadata event) — don't
// hardcode pid/tid, they differ every relaunch.
const threadNames = new Map();
events.forEach((e) => {
  if (e.name === "thread_name" && e.ph === "M") {
    threadNames.set(`${e.pid}:${e.tid}`, e.args?.name || "");
  }
});
const mainThreads = [...threadNames.entries()].filter(([, name]) => name === "CrRendererMain").map(([key]) => key);
console.log("main thread (pid:tid):", mainThreads[0]);

const mainKey = mainThreads[0];
const [mainPid, mainTid] = mainKey.split(":").map(Number);

const mainEvents = events.filter((e) => e.pid === mainPid && e.tid === mainTid);

// Long tasks: RunTask / TaskQueueManager events with dur > 16ms (complete events ph=X)
const longTasks = mainEvents
  .filter((e) => e.ph === "X" && typeof e.dur === "number" && e.dur > 16000)
  .sort((a, b) => b.dur - a.dur);
console.log("\ntop long tasks on main thread (>16ms):");
longTasks.slice(0, 20).forEach((e) => {
  console.log(`  ${(e.dur / 1000).toFixed(1)}ms  ${e.name}  ts=${e.ts}`);
});
console.log("total long tasks:", longTasks.length, "sum:", (longTasks.reduce((s, e) => s + e.dur, 0) / 1000).toFixed(1), "ms");

// Style recalcs
const recalcs = mainEvents.filter((e) => e.name === "UpdateLayoutTree" && e.ph === "X");
console.log("\nUpdateLayoutTree (style recalc) count:", recalcs.length, "total:", (recalcs.reduce((s, e) => s + (e.dur || 0), 0) / 1000).toFixed(1), "ms");
recalcs.sort((a, b) => (b.dur || 0) - (a.dur || 0)).slice(0, 10).forEach((e) => {
  console.log(`  ${((e.dur || 0) / 1000).toFixed(1)}ms elements=${e.args?.beginData?.elementCount ?? e.args?.endData?.elementCount ?? "?"}`);
});

// Layout
const layouts = mainEvents.filter((e) => e.name === "Layout" && e.ph === "X");
console.log("\nLayout count:", layouts.length, "total:", (layouts.reduce((s, e) => s + (e.dur || 0), 0) / 1000).toFixed(1), "ms");

// Frame times: DrawFrame/DroppedFrame are INSTANT markers (ph:"I"), not
// complete events — do NOT filter by ph==="X" here, that silently drops every
// one of them and the fps calc below comes out 0/NaN. (Cost an hour once.)
const drawFrames = events.filter((e) => e.name === "DrawFrame").sort((a, b) => a.ts - b.ts);
const droppedFrames = events.filter((e) => e.name === "DroppedFrame");
console.log("\nDrawFrame count:", drawFrames.length, "DroppedFrame count:", droppedFrames.length);
if (drawFrames.length > 1) {
  const gaps = [];
  for (let i = 1; i < drawFrames.length; i++) {
    gaps.push((drawFrames[i].ts - drawFrames[i - 1].ts) / 1000);
  }
  gaps.sort((a, b) => b - a);
  console.log("worst frame gaps (ms):", gaps.slice(0, 15).map((g) => g.toFixed(1)));
  const avgFps = 1000 / (gaps.reduce((s, g) => s + g, 0) / gaps.length);
  console.log("avg fps approx:", avgFps.toFixed(1));
}

// Recalc style selector stats if present
const scriptEvents = mainEvents.filter((e) => e.name === "FunctionCall" || e.name === "EvaluateScript");
console.log("\nFunctionCall/EvaluateScript total:", (scriptEvents.reduce((s, e) => s + (e.dur || 0), 0) / 1000).toFixed(1), "ms count:", scriptEvents.length);

// Top event names by total duration (complete events only, exclude containers)
const byName = new Map();
mainEvents.filter((e) => e.ph === "X" && e.dur).forEach((e) => {
  byName.set(e.name, (byName.get(e.name) || 0) + e.dur);
});
console.log("\ntop event names by total self+child duration:");
[...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([name, dur]) => {
  console.log(`  ${(dur / 1000).toFixed(1)}ms  ${name}`);
});
