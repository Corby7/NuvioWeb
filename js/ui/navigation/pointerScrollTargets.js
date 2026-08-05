import { Router } from "./router.js";

// Scroller resolution shared by the pointer transports (edge auto-scroll and
// wheel/trackpad scrolling): given a node under the cursor, find the surface a
// gesture on that axis should move, and read/write its position.
//
// Modern home rows are `overflow-x: clip` and move by translating their inner
// wrapper, so they have no scrollWidth/scrollLeft to touch — the owning screen
// holds the bookkeeping (HomeScreen's WeakMap) and is asked for it here.

const SCROLLABLE_OVERFLOW = /(auto|scroll|overlay)/;
const ANCESTOR_WALK_LIMIT = 14;

// Class-gated before the subtree query: this runs for every ancestor in the
// walk, and an unguarded querySelector on `.home-main` would scan the whole
// home DOM each time.
export function getTrackInner(node) {
  if (!node?.classList?.contains("home-track")) {
    return null;
  }
  return node.querySelector(".home-track-inner") || null;
}

export function getTransformTrackApi(track) {
  if (!getTrackInner(track)) {
    return null;
  }
  const screen = Router.getCurrentScreen();
  if (
    typeof screen?.applyTrackScrollLeft !== "function" ||
    typeof screen?.getTrackScrollLeft !== "function" ||
    typeof screen?.getTrackMaxScroll !== "function"
  ) {
    return null;
  }
  return screen;
}

export function isScrollableX(node) {
  if (!(node instanceof HTMLElement)) {
    return false;
  }
  const transformApi = getTransformTrackApi(node);
  if (transformApi) {
    return transformApi.getTrackMaxScroll(node) > 2;
  }
  if ((node.scrollWidth || 0) - (node.clientWidth || 0) <= 2) {
    return false;
  }
  return SCROLLABLE_OVERFLOW.test(getComputedStyle(node).overflowX);
}

export function isScrollableY(node) {
  if (!(node instanceof HTMLElement)) {
    return false;
  }
  if ((node.scrollHeight || 0) - (node.clientHeight || 0) <= 2) {
    return false;
  }
  return SCROLLABLE_OVERFLOW.test(getComputedStyle(node).overflowY);
}

export function findScrollableAncestor(start, predicate) {
  let node = start;
  let steps = 0;
  while (node instanceof HTMLElement && steps < ANCESTOR_WALK_LIMIT) {
    if (predicate(node)) {
      return node;
    }
    if (node.id === "app" || node === document.body) {
      return null;
    }
    node = node.parentElement;
    steps += 1;
  }
  return null;
}

export function readScrollLeft(scroller) {
  const transformApi = getTransformTrackApi(scroller);
  if (transformApi) {
    return Number(transformApi.getTrackScrollLeft(scroller) || 0);
  }
  return Number(scroller?.scrollLeft || 0);
}

export function getMaxScrollLeft(scroller) {
  const transformApi = getTransformTrackApi(scroller);
  if (transformApi) {
    return Math.max(0, Number(transformApi.getTrackMaxScroll(scroller) || 0));
  }
  return Math.max(0, (scroller?.scrollWidth || 0) - (scroller?.clientWidth || 0));
}
