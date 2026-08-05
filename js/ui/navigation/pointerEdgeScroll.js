import { Router } from "./router.js";
import { Platform } from "../../platform/index.js";
import { FocusEngine } from "./focusEngine.js";
import {
  findScrollableAncestor,
  getMaxScrollLeft,
  getTransformTrackApi,
  isScrollableX,
  isScrollableY,
  readScrollLeft
} from "./pointerScrollTargets.js";

// ─── Magic-remote edge auto-scroll ──────────────────────────────────────────
// Resting the pointer near a screen edge scrolls the surface under it: the row
// the cursor sits on scrolls sideways near the left/right edges, and the
// screen's vertical scroller pans near the top/bottom edges. Speed ramps with
// how deep into the edge zone the cursor is, so a small nudge creeps and the
// outermost band flies.
//
// The pointer never moves during an edge scroll, so nothing re-hit-tests on
// its own: focus is re-resolved on a timer (below) rather than relying on
// mouseover, which browsers only dispatch reliably for native scrollers.

const EDGE_ZONE_X_RATIO = 0.075;
const EDGE_ZONE_X_MIN = 96;
const EDGE_ZONE_X_MAX = 180;
const EDGE_ZONE_Y_RATIO = 0.09;
const EDGE_ZONE_Y_MIN = 72;
const EDGE_ZONE_Y_MAX = 132;

// px/second at the inner lip of the zone → px/second at the very edge.
const MIN_SPEED_X = 220;
const MAX_SPEED_X = 2100;
const MIN_SPEED_Y = 200;
const MAX_SPEED_Y = 1700;

// A dropped frame must not teleport the surface.
const MAX_FRAME_DELTA_MS = 50;
// Scroller lookup is a hit test plus an ancestor walk with getComputedStyle —
// cheap, but not per-frame cheap. Re-resolve on a timer or a real move.
const RESOLVE_INTERVAL_MS = 220;
const RESOLVE_MOVE_PX = 24;
const REFOCUS_INTERVAL_MS = 110;
// Transform tracks stub offscreen cards behind an 80ms debounce that a
// continuous scroll resets forever; refresh the window ourselves with a
// speed-proportional lookahead so cards are unstubbed before they arrive.
const TRACK_WINDOW_REFRESH_MS = 200;
const TRACK_WINDOW_LOOKAHEAD_S = 1.2;
// Stop the rAF loop once both axes have been clamped this long — the cursor is
// parked at an edge with nowhere left to go. Any pointer move restarts it.
const IDLE_STOP_MS = 900;

const DISABLED_ROUTES = new Set(["player"]);
const DEFAULT_RAIL_WIDTH = 144;

function isFeatureEnabled() {
  // Magic remote is the target. Browser/desktop mice get it behind a flag so
  // the behaviour can be exercised on the dev server without turning ordinary
  // mouse travel into scrolling.
  if (Platform.isWebOS()) {
    return true;
  }
  if (globalThis.__NUVIO_POINTER_EDGE_SCROLL__) {
    return true;
  }
  try {
    return globalThis.localStorage?.getItem("nuvio.pointerEdgeScroll") === "1";
  } catch (_) {
    return false;
  }
}

export const PointerEdgeScroll = {
  started: false,
  pointerX: 0,
  pointerY: 0,
  hasPointer: false,
  rafId: null,
  lastFrameAt: 0,

  resolvedAt: 0,
  resolvedX: 0,
  resolvedY: 0,
  resolvedRoute: "",
  hScroller: null,
  vScroller: null,

  // Float shadow positions: a 3.7px/frame step would otherwise be truncated to
  // 3px every frame and drift ~20% slow.
  hPos: 0,
  vPos: 0,
  lastMovedAt: 0,
  lastRefocusAt: 0,
  lastWindowRefreshAt: 0,
  railWidth: 0,

  init() {
    if (this.started || !isFeatureEnabled()) {
      return;
    }
    this.started = true;
    this.boundPointerMove = (event) => this.handlePointerMove(event);
    this.boundStop = () => this.stop();
    this.boundPointerOut = (event) => {
      // relatedTarget null on document means the pointer left the window.
      if (!event?.relatedTarget) {
        this.stop();
      }
    };
    this.boundCursorStateChange = (event) => {
      if (event?.detail?.visibility === false) {
        this.stop();
      }
    };

    document.addEventListener("mousemove", this.boundPointerMove, true);
    document.addEventListener("pointermove", this.boundPointerMove, true);
    document.addEventListener("mouseout", this.boundPointerOut, true);
    // Any key press means the user switched back to the d-pad — the pointer is
    // stale and must not keep driving the surface under it.
    document.addEventListener("keydown", this.boundStop, true);
    window.addEventListener("blur", this.boundStop);
    // webOS fires this when the magic remote cursor hides after inactivity.
    document.addEventListener("cursorStateChange", this.boundCursorStateChange, true);
  },

  getRailWidth() {
    if (this.railWidth) {
      return this.railWidth;
    }
    const raw = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--legacy-sidebar-rail-width")
    );
    this.railWidth = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RAIL_WIDTH;
    return this.railWidth;
  },

  // The rail zone belongs to RootSidebarController's hover-to-expand, and an
  // open sidebar owns the pointer outright.
  getLeftInset() {
    const sidebar = document.getElementById("root-nav-sidebar");
    if (!sidebar || sidebar.hidden) {
      return 0;
    }
    return this.getRailWidth();
  },

  isSuppressed() {
    if (DISABLED_ROUTES.has(String(Router.current || ""))) {
      return true;
    }
    return Boolean(
      document.querySelector(
        "#root-nav-sidebar .home-sidebar.expanded, #root-nav-sidebar .modern-sidebar-shell.expanded"
      )
    );
  },

  handlePointerMove(event) {
    const x = Number(event?.clientX);
    const y = Number(event?.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }
    if (this.hasPointer && x === this.pointerX && y === this.pointerY) {
      return;
    }
    this.pointerX = x;
    this.pointerY = y;
    this.hasPointer = true;
    this.lastMovedAt = Date.now();
    if (this.isInEdgeZone()) {
      this.start();
    } else if (this.rafId) {
      this.stop();
    }
  },

  getZones() {
    const vw = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 0);
    const vh = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 0);
    return {
      vw,
      vh,
      zoneX: Math.min(EDGE_ZONE_X_MAX, Math.max(EDGE_ZONE_X_MIN, vw * EDGE_ZONE_X_RATIO)),
      zoneY: Math.min(EDGE_ZONE_Y_MAX, Math.max(EDGE_ZONE_Y_MIN, vh * EDGE_ZONE_Y_RATIO)),
      leftInset: this.getLeftInset()
    };
  },

  isInEdgeZone() {
    if (!this.hasPointer) {
      return false;
    }
    const { vw, vh, zoneX, zoneY, leftInset } = this.getZones();
    const inLeft = this.pointerX >= leftInset && this.pointerX < leftInset + zoneX;
    const inRight = this.pointerX > vw - zoneX;
    const inTop = this.pointerY < zoneY;
    const inBottom = this.pointerY > vh - zoneY;
    return inLeft || inRight || inTop || inBottom;
  },

  start() {
    if (this.rafId || this.isSuppressed()) {
      return;
    }
    this.lastFrameAt = 0;
    this.resolvedAt = 0;
    this.hScroller = null;
    this.vScroller = null;
    this.rafId = requestAnimationFrame((now) => this.tick(now));
  },

  stop() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.hScroller = null;
    this.vScroller = null;
    this.resolvedAt = 0;
  },

  tick(now) {
    this.rafId = null;
    if (!this.hasPointer || !this.isInEdgeZone() || this.isSuppressed()) {
      this.stop();
      return;
    }

    const timestamp = Number.isFinite(now) ? now : performance.now();
    const deltaMs = this.lastFrameAt ? Math.min(MAX_FRAME_DELTA_MS, timestamp - this.lastFrameAt) : 0;
    this.lastFrameAt = timestamp;
    const deltaSeconds = Math.max(0, deltaMs) / 1000;

    this.resolveScrollers(timestamp);

    let moved = false;
    if (deltaSeconds > 0) {
      moved = this.stepHorizontal(deltaSeconds, timestamp) || moved;
      moved = this.stepVertical(deltaSeconds) || moved;
    }

    if (moved) {
      this.lastMovedAt = Date.now();
      this.refocusUnderPointer(timestamp);
    } else if (deltaSeconds > 0 && Date.now() - this.lastMovedAt > IDLE_STOP_MS) {
      // Both axes clamped at their limits — idle out instead of burning frames.
      this.stop();
      return;
    }

    this.rafId = requestAnimationFrame((next) => this.tick(next));
  },

  resolveScrollers(timestamp) {
    const route = String(Router.current || "");
    const movedFar =
      Math.abs(this.pointerX - this.resolvedX) > RESOLVE_MOVE_PX ||
      Math.abs(this.pointerY - this.resolvedY) > RESOLVE_MOVE_PX;
    const stale = timestamp - this.resolvedAt > RESOLVE_INTERVAL_MS;
    const detached =
      (this.hScroller && !this.hScroller.isConnected) || (this.vScroller && !this.vScroller.isConnected);
    if (this.resolvedAt && !movedFar && !stale && !detached && route === this.resolvedRoute) {
      return;
    }

    const previousH = this.hScroller;
    const previousV = this.vScroller;
    this.resolvedAt = timestamp;
    this.resolvedX = this.pointerX;
    this.resolvedY = this.pointerY;
    this.resolvedRoute = route;
    this.hScroller = this.findHorizontalScroller();
    this.vScroller = this.findVerticalScroller();

    if (this.hScroller && this.hScroller !== previousH) {
      this.adoptScroller(this.hScroller, "x");
    }
    if (this.vScroller && this.vScroller !== previousV) {
      this.adoptScroller(this.vScroller, "y");
    }
  },

  // Take over a container: kill any d-pad tween still flying on that axis and
  // seed the float shadow from where the container actually sits.
  adoptScroller(scroller, axis) {
    Router.getCurrentScreen()?.cancelScrollAnimation?.(scroller, axis);
    if (axis === "x") {
      this.hPos = readScrollLeft(scroller);
    } else {
      this.vPos = Number(scroller.scrollTop || 0);
    }
  },

  // Rows do not reach the viewport edge — `.home-main` pads 64px and the track
  // sits inside that — so a hit test at the cursor lands on the padding. Probe
  // inward along the same row band until a horizontal scroller turns up.
  findHorizontalScroller() {
    const { vw } = this.getZones();
    const probes = [this.pointerX, vw * 0.5, vw * 0.72, vw * 0.28];
    for (const probeX of probes) {
      const element = document.elementFromPoint(
        Math.max(0, Math.min(vw - 1, probeX)),
        this.pointerY
      );
      if (!element) {
        continue;
      }
      const scroller = findScrollableAncestor(element, isScrollableX);
      if (scroller) {
        return scroller;
      }
    }
    return null;
  },

  // The screen's vertical scroller does not always reach the edge the cursor is
  // parked at — modern home puts the hero above `.home-modern-rows-viewport`, so
  // a top-edge hit test lands outside the scroller entirely. Fall back to the
  // middle of the screen, where the primary scroller always sits.
  findVerticalScroller() {
    const { vw, vh } = this.getZones();
    const probes = [
      [this.pointerX, this.pointerY],
      [vw * 0.5, this.pointerY],
      [this.pointerX, vh * 0.5],
      [vw * 0.5, vh * 0.5]
    ];
    for (const [probeX, probeY] of probes) {
      const element = document.elementFromPoint(
        Math.max(0, Math.min(vw - 1, probeX)),
        Math.max(0, Math.min(vh - 1, probeY))
      );
      if (!element) {
        continue;
      }
      const scroller = findScrollableAncestor(element, isScrollableY);
      if (scroller) {
        return scroller;
      }
    }
    return null;
  },

  // 0 at the inner lip of the zone, 1 at the screen edge. Squared so the inner
  // half of the band stays slow and controllable.
  rampSpeed(depth, zone, minSpeed, maxSpeed) {
    const t = Math.max(0, Math.min(1, depth / zone));
    return minSpeed + (maxSpeed - minSpeed) * t * t;
  },

  stepHorizontal(deltaSeconds, timestamp) {
    const scroller = this.hScroller;
    if (!scroller?.isConnected) {
      return false;
    }
    const { vw, zoneX, leftInset } = this.getZones();
    let direction = 0;
    let depth = 0;
    if (this.pointerX > vw - zoneX) {
      direction = 1;
      depth = this.pointerX - (vw - zoneX);
    } else if (this.pointerX >= leftInset && this.pointerX < leftInset + zoneX) {
      direction = -1;
      depth = leftInset + zoneX - this.pointerX;
    }
    if (!direction) {
      return false;
    }

    const transformApi = getTransformTrackApi(scroller);
    const max = getMaxScrollLeft(scroller);
    if (max <= 0) {
      return false;
    }

    const current = readScrollLeft(scroller);
    // Resync when something else (d-pad, focus restore) moved the container.
    if (Math.abs(current - this.hPos) > 4) {
      this.hPos = current;
    }
    const speed = this.rampSpeed(depth, zoneX, MIN_SPEED_X, MAX_SPEED_X);
    const next = Math.max(0, Math.min(max, this.hPos + direction * speed * deltaSeconds));
    if (Math.round(next) === Math.round(current)) {
      this.hPos = next;
      return false;
    }
    this.hPos = next;

    if (transformApi) {
      transformApi.applyTrackScrollLeft(scroller, Math.round(next));
      if (timestamp - this.lastWindowRefreshAt > TRACK_WINDOW_REFRESH_MS) {
        this.lastWindowRefreshAt = timestamp;
        transformApi.refreshTrackWindow?.(
          scroller,
          Math.max(0, Math.min(max, next + direction * speed * TRACK_WINDOW_LOOKAHEAD_S))
        );
      }
    } else {
      scroller.scrollLeft = Math.round(next);
    }
    return true;
  },

  stepVertical(deltaSeconds) {
    const scroller = this.vScroller;
    if (!scroller?.isConnected) {
      return false;
    }
    const { vh, zoneY } = this.getZones();
    let direction = 0;
    let depth = 0;
    if (this.pointerY > vh - zoneY) {
      direction = 1;
      depth = this.pointerY - (vh - zoneY);
    } else if (this.pointerY < zoneY) {
      direction = -1;
      depth = zoneY - this.pointerY;
    }
    if (!direction) {
      return false;
    }

    const max = Math.max(0, (scroller.scrollHeight || 0) - (scroller.clientHeight || 0));
    if (max <= 0) {
      return false;
    }

    const current = Number(scroller.scrollTop || 0);
    if (Math.abs(current - this.vPos) > 4) {
      this.vPos = current;
    }
    const speed = this.rampSpeed(depth, zoneY, MIN_SPEED_Y, MAX_SPEED_Y);
    const next = Math.max(0, Math.min(max, this.vPos + direction * speed * deltaSeconds));
    if (Math.round(next) === Math.round(current)) {
      this.vPos = next;
      return false;
    }
    this.vPos = next;
    scroller.scrollTop = Math.round(next);
    return true;
  },

  // Content slides under a stationary cursor, so hover focus has to be pulled
  // forward by hand. FocusEngine owns the same rules the pointer path uses.
  refocusUnderPointer(timestamp) {
    if (timestamp - this.lastRefocusAt < REFOCUS_INTERVAL_MS) {
      return;
    }
    this.lastRefocusAt = timestamp;
    const element = document.elementFromPoint(this.pointerX, this.pointerY);
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
