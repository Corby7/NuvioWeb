// Drill into the top N longest RunTask/Commit events in a trace and show
// their child event breakdown (what actually consumed the task's time) plus
// any JS call frames found inside. Usage:
//   node drill.mjs <trace.json> [topN=5]
import { readFileSync } from "node:fs";

const file = process.argv[2];
const events = JSON.parse(readFileSync(file, "utf8")).traceEvents;

// Auto-detect the renderer main thread instead of hardcoding pid/tid — these
// differ every relaunch, and a stale hardcoded value silently filters
// everything out (empty output, no error).
const threadNames = new Map();
events.forEach((e) => {
  if (e.name === "thread_name" && e.ph === "M") {
    threadNames.set(`${e.pid}:${e.tid}`, e.args?.name || "");
  }
});
const [mainPid, mainTid] = ([...threadNames.entries()].find(([, name]) => name === "CrRendererMain")?.[0] || "0:0")
  .split(":").map(Number);

const mainEvents = events.filter((e) => e.pid === mainPid && e.tid === mainTid && e.ph === "X" && e.dur);
mainEvents.sort((a, b) => a.ts - b.ts);

const topN = Number(process.argv[3] || 5);
const sorted = [...mainEvents].filter((e) => e.name === "RunTask" || e.name === "Commit").sort((a, b) => b.dur - a.dur).slice(0, topN);

for (const task of sorted) {
  console.log(`\n=== ${task.name} dur=${(task.dur / 1000).toFixed(1)}ms ts=${task.ts} ===`);
  const children = mainEvents.filter((e) => e.ts >= task.ts && e.ts + e.dur <= task.ts + task.dur && e !== task);
  const byName = new Map();
  children.forEach((e) => { byName.set(e.name, (byName.get(e.name) || 0) + e.dur); });
  [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([name, dur]) => {
    console.log(`   ${(dur / 1000).toFixed(1)}ms  ${name}`);
  });
  // Look for JS call frames (FunctionCall events carry args.data with
  // functionName/url — non-minified webOS dev builds give REAL function
  // names and line/col here, not just "anonymous").
  const calls = children.filter((e) => e.name === "FunctionCall" || e.name === "v8.compile" || e.name === "EvaluateScript");
  calls.sort((a, b) => b.dur - a.dur).slice(0, 8).forEach((e) => {
    console.log(`     fn: ${(e.dur / 1000).toFixed(1)}ms ${JSON.stringify(e.args?.data?.functionName || e.args?.data || {})}`.slice(0, 200));
  });
}
