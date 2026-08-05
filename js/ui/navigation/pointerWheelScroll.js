import { Router } from "./router.js";
import { FocusEngine } from "./focusEngine.js";
import {
  findScrollableAncestor,
  getMaxScrollLeft,
  getTransformTrackApi,
  readScrollLeft
} from "./pointerScrollTargets.js";

// ─── Trackpad / wheel horizontal row scrolling ──────────────────────────────
// A two-finger sideways swipe (or shift+wheel) over a row scrolls it.
//
// Native `overflow-x` scrollers — the detail episode rails, the settings panes —
// already do this themselves and are left alone. The modern home rows do not:
// they are `overflow-x: clip` and move by translating `.home-track-inner`, so
// deltaX over one would otherwise fall through to the page (and, on macOS, to
// Chromium's overscroll back-navigation). Those rows are driven by hand here.

const DISABLED_ROUTES = new Set(["player"]);

// Wheel deltas come in three units. The line/page figures only have to be in
// the right ballpark — a mouse wheel over a row is a coarse gesture either way.
const LINE_HEIGHT_PX = 40;
const PAGE_WIDTH_PX = 400;

// Below this a "horizontal" swipe is really the noise on a vertical one.
const MIN_HORIZONTAL_PX = 0.5;

// Content slides under a stationary cursor, so hover focus has to be pulled
// forward by hand — the same problem the edge scroller has.
const REFOCUS_INTERVAL_MS = 90;
// Transform tracks stub offscreen cards behind an 80ms debounce that a
// continuous gesture keeps resetting; refresh the window with a lookahead so
// cards are unstubbed before they arrive.
const TRACK_WINDOW_REFRESH_MS = 120;
const TRACK_WINDOW_LOOKAHEAD_PX = 900;

function normalizeDelta(value, deltaMode, pageSize) {
  const raw = Number(value || 0);
  if (!Number.isFinite(raw) || raw === 0) {
    return 0;
  }
  if (deltaMode === 1) {
    return raw * LINE_HEIGHT_PX;
  }
  if (deltaMode === 2) {
    return raw * pageSize;
  }
  return raw;
}

function isTransformTrack(node) {
  const transformApi = getTransformTrackApi(node);
  return Boolean(transformApi) && transformApi.getTrackMaxScroll(node) > 2;
}

export const PointerWheelScroll = {
  started: false,
  lastRefocusAt: 0,
  lastWindowRefreshAt: 0,

  init() {
    if (this.started) {
      return;
    }
    this.started = true;
    this.boundHandleWheel = (event) => this.handleWheel(event);
    // Not passive: a handled gesture is preventDefault-ed so it cannot leak
    // into the shell's history swipe.
    document.addEventListener("wheel", this.boundHandleWheel, { passive: false });
  },

  handleWheel(event) {
    if (!event || event.defaultPrevented || event.ctrlKey) {
      return;
    }
    if (DISABLED_ROUTES.has(String(Router.current || ""))) {
      return;
    }

    const deltaX = normalizeDelta(event.deltaX, event.deltaMode, PAGE_WIDTH_PX);
    const deltaY = normalizeDelta(event.deltaY, event.deltaMode, PAGE_WIDTH_PX);
    // A wheel mouse has no X axis; shift+wheel is the long-standing stand-in.
    // Chromium already swaps the axes for shift+wheel on some platforms, hence
    // the deltaX-first order.
    const delta = deltaX || (event.shiftKey ? deltaY : 0);
    if (Math.abs(delta) < MIN_HORIZONTAL_PX) {
      return;
    }
    // A diagonal swipe belongs to whichever axis leads; vertical wins ties so
    // an ordinary scroll never sidesteps.
    if (!event.shiftKey && Math.abs(delta) <= Math.abs(deltaY)) {
      return;
    }

    const target = event.target instanceof HTMLElement ? event.target : null;
    if (!target) {
      return;
    }
    const track = findScrollableAncestor(target, isTransformTrack);
    if (!track) {
      return;
    }

    // Own the gesture even at the ends of the row: releasing it there is what
    // lets a swipe past the last card turn into a back navigation.
    event.preventDefault();

    const transformApi = getTransformTrackApi(track);
    const max = getMaxScrollLeft(track);
    const current = readScrollLeft(track);
    const next = Math.max(0, Math.min(max, current + delta));
    if (Math.round(next) === Math.round(current)) {
      return;
    }

    // Take the row over from any d-pad tween still flying on it.
    Router.getCurrentScreen()?.cancelScrollAnimation?.(track, "x");
    transformApi.applyTrackScrollLeft(track, Math.round(next));

    const now = performance.now();
    if (now - this.lastWindowRefreshAt > TRACK_WINDOW_REFRESH_MS) {
      this.lastWindowRefreshAt = now;
      transformApi.refreshTrackWindow?.(
        track,
        Math.max(0, Math.min(max, next + Math.sign(delta) * TRACK_WINDOW_LOOKAHEAD_PX))
      );
    }

    this.refocusUnderPointer(event.clientX, event.clientY, now);
  },

  // FocusEngine owns the same rules the hover path uses; go through it so the
  // screen's onPointerFocus hook fires exactly as it would on a real move.
  refocusUnderPointer(clientX, clientY, now) {
    if (now - this.lastRefocusAt < REFOCUS_INTERVAL_MS) {
      return;
    }
    this.lastRefocusAt = now;
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
      return;
    }
    const element = document.elementFromPoint(clientX, clientY);
    if (!element) {
      return;
    }
    const target = FocusEngine.getPointerFocusable({ target: element });
    if (!target || target.classList.contains("focused")) {
      return;
    }
    FocusEngine.focusPointerTarget(target, null);
  }
};
