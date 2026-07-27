const MAX_CONCURRENT = 6;
const TMDB_POSTER_RE = /\/image\.tmdb\.org\/t\/p\/(?:original|w\d+)\//;
const TVDB_ARTWORK_RE = /^(https?:\/\/artworks\.thetvdb\.com\/.+?)(?:_t)?(\.(?:jpe?g|png|webp))$/i;
const MARGIN_X = 600;
const MARGIN_Y = 200;
// Unload margins are much larger than load margins so images only churn when the
// user has really moved on, and the delay debounces fast fly-bys. Freeing decoded
// bitmaps matters on TVs: GPU memory fills over a long browse session and the
// compositor degrades.
const UNLOAD_MARGIN_X = 1800;
const UNLOAD_MARGIN_Y = 1600;
const UNLOAD_DELAY_MS = 4000;

let activeLoads = 0;
let loadGeneration = 0;
let loadsPaused = false;
const queue = [];
let observer = null;
let unloadObserver = null;
const unloadTimers = new WeakMap();

function isConnected(img) {
  // Node.isConnected not available before Chrome 51 (webOS 3 = Chrome 38)
  return typeof img.isConnected === "boolean" ? img.isConnected : document.body.contains(img);
}

function processQueue() {
  while (!loadsPaused && activeLoads < MAX_CONCURRENT && queue.length > 0) {
    const img = queue.shift();
    if (!isConnected(img)) continue;
    const src = img.dataset.posterSrc;
    if (!src) continue;
    activeLoads++;
    const gen = loadGeneration;
    const done = () => {
      if (loadGeneration === gen && activeLoads > 0) activeLoads--;
      processQueue();
    };
    img.onload = () => {
      img.classList.add("poster-loaded");
      done();
      watchForUnload(img);
    };
    img.onerror = done;
    img.src = src;
  }
}

// Pause decode work while it would compete with held-key navigation; queued
// entries are kept and drained on resume.
export function setPosterLoadsPaused(value) {
  const next = Boolean(value);
  if (next === loadsPaused) return;
  loadsPaused = next;
  if (!loadsPaused) processQueue();
}

function isNearViewport(img) {
  const rect = img.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return true; // layout not ready — load eagerly
  const vw = window.innerWidth || 1920;
  const vh = window.innerHeight || 1080;
  return rect.bottom >= -MARGIN_Y && rect.top <= vh + MARGIN_Y &&
         rect.right >= -MARGIN_X && rect.left <= vw + MARGIN_X;
}

function getObserver() {
  if (!observer && typeof IntersectionObserver !== "undefined") {
    observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        queue.push(entry.target);
      });
      processQueue();
    }, {
      rootMargin: `${MARGIN_Y}px ${MARGIN_X}px ${MARGIN_Y}px ${MARGIN_X}px`,
      threshold: 0
    });
  }
  return observer;
}

function getUnloadObserver() {
  if (!unloadObserver && typeof IntersectionObserver !== "undefined") {
    unloadObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const img = entry.target;
        if (entry.isIntersecting) {
          clearTimeout(unloadTimers.get(img));
          unloadTimers.delete(img);
          return;
        }
        clearTimeout(unloadTimers.get(img));
        unloadTimers.set(img, setTimeout(() => {
          unloadTimers.delete(img);
          unloadPoster(img);
        }, UNLOAD_DELAY_MS));
      });
    }, {
      rootMargin: `${UNLOAD_MARGIN_Y}px ${UNLOAD_MARGIN_X}px ${UNLOAD_MARGIN_Y}px ${UNLOAD_MARGIN_X}px`,
      threshold: 0
    });
  }
  return unloadObserver;
}

function watchForUnload(img) {
  const obs = getUnloadObserver();
  if (obs && img.dataset.posterSrc) {
    obs.observe(img);
  }
}

function unloadPoster(img) {
  unloadObserver?.unobserve(img);
  if (!isConnected(img) || !img.dataset.posterSrc) {
    return;
  }
  // Drop the decoded bitmap but keep data-poster-src; the load observer brings
  // it back (through the queue) when it approaches the viewport again.
  img.onload = null;
  img.onerror = null;
  img.removeAttribute("src");
  img.classList.remove("poster-loaded");
  getObserver()?.observe(img);
}

// Call before a full-page render to discard stale load state. Do NOT call
// from track pagination — that would break in-flight loads for other rows.
export function resetPosterLoader() {
  loadGeneration++;
  queue.length = 0;
  activeLoads = 0;
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (unloadObserver) {
    unloadObserver.disconnect();
    unloadObserver = null;
  }
}

export function observePosterImages(container) {
  const obs = getObserver();
  container.querySelectorAll("img[data-poster-src]").forEach((img) => {
    if (!obs || isNearViewport(img)) {
      queue.push(img);
    } else {
      obs.observe(img);
    }
  });
  processQueue();
}

export function unobservePosterImages(container) {
  container.querySelectorAll("img[data-poster-src]").forEach((img) => {
    observer?.unobserve(img);
    unloadObserver?.unobserve(img);
    clearTimeout(unloadTimers.get(img));
    unloadTimers.delete(img);
  });
}

export function optimizePosterUrl(url) {
  if (!url) return url;
  if (TMDB_POSTER_RE.test(url)) {
    return url.replace(TMDB_POSTER_RE, "/image.tmdb.org/t/p/w342/");
  }
  return url;
}

export function optimizeBackdropUrl(url) {
  if (!url) return url;
  if (TMDB_POSTER_RE.test(url)) {
    return url.replace(TMDB_POSTER_RE, "/image.tmdb.org/t/p/w1280/");
  }
  return url;
}

// Card-sized backdrop (expanded poster reveal, ~620px wide) — w1280 is the
// full-screen hero size; cards need w780. Raw addon URLs are often /original
// (measured 143ms single decodes + 60-80ms GPU uploads on the C3).
export function optimizeCardBackdropUrl(url) {
  if (!url) return url;
  if (TMDB_POSTER_RE.test(url)) {
    return url.replace(TMDB_POSTER_RE, "/image.tmdb.org/t/p/w780/");
  }
  const tvdb = TVDB_ARTWORK_RE.exec(url);
  if (tvdb) {
    // Already-thumbnailed URLs re-emit unchanged (the "_t" group is consumed
    // and re-added), so this stays idempotent.
    return `${tvdb[1]}_t${tvdb[2]}`;
  }
  return url;
}

// TheTVDB is the other big source of multi-megapixel card art, and it ignores
// the TMDB sizing scheme. It does serve a half-dimension thumbnail for any
// artwork by inserting "_t" before the extension (measured on-device:
// 1920x1080 -> 960x540, 1280x720 -> 640x360, 1.3MB -> 56KB). That is ample for
// the card backdrop, which renders into a 236x360 CSS box and sits at
// opacity 0 until the expanded reveal.
// Do NOT reuse "_t" for posters: those render at 442x678 device px (dpr 2) and
// go visibly soft at 340x500 — verified with 2x on-device captures.
// Not every asset is guaranteed a "_t", so callers must keep the original URL
// as an onerror fallback.
export function buildCardBackdropFallback(originalUrl, optimizedUrl) {
  if (!originalUrl || originalUrl === optimizedUrl) return "";
  return encodeURIComponent(originalUrl);
}

export function optimizeLogoUrl(url) {
  if (!url) return url;
  if (TMDB_POSTER_RE.test(url)) {
    return url.replace(TMDB_POSTER_RE, "/image.tmdb.org/t/p/w500/");
  }
  return url;
}
