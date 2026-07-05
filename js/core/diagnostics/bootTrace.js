// Boot phase timing marks. Always on: a handful of console.info lines per
// launch is free, and having them in TV logs (ares-inspect / simulator
// console) is the only practical way to see which startup phase is slow on
// device. Times are ms since the page's time origin.

export function bootMark(label) {
  try {
    console.info(`[boot] +${Math.round(performance.now())}ms ${label}`);
  } catch (_) {
    // Timing must never break startup.
  }
}
