// Warms the path between "the user is looking at something" and "picture on
// screen". Both halves of that path were already cached and idempotent — the
// addon fan-out behind streamRepository's run cache, the debrid unrestrict
// behind DirectDebridResolver's resolvedCache — they just never started until
// the stream screen had mounted. Running them from the detail screen means the
// stream screen attaches to work that is already finished.
//
// The two halves have very different costs, so they are gated differently:
// the fan-out is free (the run cache means those requests happen exactly once
// either way, just sooner), while the debrid resolve spends API quota and so
// stays behind the user's existing instant-playback preparation limit.

import { streamRepository } from "../../data/repository/streamRepository.js";
import { DirectDebridStreamPreparer } from "../debrid/directDebridStreamPreparer.js";

// Long enough that arrowing across an episode rail does not fan out on every
// card it passes, short enough that a deliberate pause has already started.
const FOCUS_DWELL_MS = 600;
// The primary target is known at first paint, but firing there would put the
// fan-out in competition with backdrop decode and metadata enrichment on the
// detail screen's critical path. This is still seconds ahead of the click.
const PRIMARY_DELAY_MS = 400;
// The top Continue Watching card is known before the home screen has finished
// loading its catalog rows, and those rows are what the user is looking at.
// Wait them out — this target is likely, but it is not imminent.
const BACKGROUND_DELAY_MS = 1500;
// Backstop behind the supersede logic: a user pogo-sticking between two
// episodes still cannot spray the addon fan-out.
const MAX_WARMS_PER_MINUTE = 12;
const WARMED_KEY_TTL_MS = 5 * 60 * 1000;
const WARMED_KEY_MAX_ENTRIES = 60;

const warmStarts = [];
const warmedKeys = new Map();

let pendingTimer = null;
let activeToken = 0;

// Mirrors streamRepository's run key so "already warmed" means the same target
// the stream screen will ask for, not merely the same title.
function warmKey(params = {}) {
  const videoId = String(params?.videoId || params?.itemId || "");
  if (!videoId) {
    return "";
  }
  return [
    String(params?.itemType || "movie").toLowerCase() || "movie",
    videoId,
    String(params?.itemId || ""),
    params?.season ?? "",
    params?.episode ?? ""
  ].join("|");
}

function isRecentlyWarmed(key) {
  const warmedAt = warmedKeys.get(key);
  if (warmedAt == null) {
    return false;
  }
  if (Date.now() - warmedAt > WARMED_KEY_TTL_MS) {
    warmedKeys.delete(key);
    return false;
  }
  return true;
}

function rememberWarmed(key) {
  warmedKeys.set(key, Date.now());
  while (warmedKeys.size > WARMED_KEY_MAX_ENTRIES) {
    const oldestKey = warmedKeys.keys().next().value;
    if (oldestKey == null) {
      break;
    }
    warmedKeys.delete(oldestKey);
  }
}

function consumeWarmBudget() {
  const now = Date.now();
  while (warmStarts.length && warmStarts[0] < now - 60 * 1000) {
    warmStarts.shift();
  }
  if (warmStarts.length >= MAX_WARMS_PER_MINUTE) {
    return false;
  }
  warmStarts.push(now);
  return true;
}

async function runWarm(params, token) {
  let run = null;
  try {
    run = streamRepository.ensureStreamRunForRoute(params);
  } catch (error) {
    console.warn("Play path warm failed to start", error);
    return;
  }
  if (!run) {
    return;
  }
  try {
    await run.promise;
  } catch (_) {
    // Fan-out failures are the stream screen's to report, not the warmer's.
  }
  // The screen that asked for this warm is gone; do not spend debrid quota on
  // something the user has navigated away from.
  if (token !== activeToken) {
    return;
  }
  const streams = run.orderedGroups().flatMap((group) => group?.streams || []);
  if (!streams.length) {
    return;
  }
  try {
    await DirectDebridStreamPreparer.prepare(streams, {
      season: params?.season == null ? null : Number(params.season),
      episode: params?.episode == null ? null : Number(params.episode)
    });
  } catch (error) {
    console.warn("Play path debrid warm failed", error);
  }
}

function schedule(params, delayMs) {
  const key = warmKey(params);
  if (!key) {
    return;
  }
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  if (isRecentlyWarmed(key)) {
    return;
  }
  const token = activeToken;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    if (token !== activeToken || isRecentlyWarmed(key) || !consumeWarmBudget()) {
      return;
    }
    rememberWarmed(key);
    void runWarm(params, token);
  }, Math.max(0, delayMs));
}

export const PlayPathWarmer = {
  // Landing on a movie detail screen, or resolving the episode the main Play
  // button will start, is intent on its own — it only waits out first paint.
  warmNow(params = {}) {
    schedule(params, PRIMARY_DELAY_MS);
  },

  // Focus-driven warming waits out the dwell so d-pad travel across a rail does
  // not fan out once per card.
  warmOnFocus(params = {}) {
    schedule(params, FOCUS_DWELL_MS);
  },

  // For targets that are likely but not imminent, on a screen that is still
  // doing work the user can see.
  warmBackground(params = {}) {
    schedule(params, BACKGROUND_DELAY_MS);
  },

  // Invalidates any in-flight warm as well as the pending one, so leaving a
  // screen stops the work it started.
  cancel() {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    activeToken += 1;
  }
};
