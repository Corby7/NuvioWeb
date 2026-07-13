// Lazy hydration for poster <img data-lazy-src> nodes, mirroring the episode
// thumbnail idiom (metaDetailsScreen.observeEpisodeThumbnails) but for grids.
//
// Native loading="lazy" is not used because webOS Chromium's prefetch margin
// is too small for d-pad scrolling — rows became visible before their posters
// started fetching. This observer preloads several rows ahead instead.
//
// The observer watches the enclosing card (closest .focusable), not the <img>
// itself: grid cards use content-visibility auto, which skips layout of card
// contents while off-screen, so descendant geometry is unreliable — but the
// card element itself is always laid out via its contain-intrinsic-size.

const LAZY_POSTER_ROOT_MARGIN = "2000px 600px";

// rootMargin only expands the observer root's own rect — it does not loosen
// clipping by intermediate scroll containers. These grids all live inside an
// inner scroller (e.g. .library-main, height:100vh + overflow-y:auto), so with
// root:null every below-the-fold card clipped to a zero rect and the preload
// margin never did anything: posters only loaded once actually scrolled into
// view. The scroller itself must be the root for the margin to apply.
function isScrollableOverflow(value) {
  return value === "auto" || value === "scroll" || value === "overlay";
}

function resolveScrollRoot(node) {
  let current = node instanceof HTMLElement ? node.parentElement : null;
  while (current && current !== document.body) {
    const style = getComputedStyle(current);
    if (isScrollableOverflow(style.overflowY) || isScrollableOverflow(style.overflowX)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function hydrateLazyPosterImage(img) {
  const src = img.getAttribute("data-lazy-src") || "";
  if (!src) {
    img.removeAttribute("data-lazy-src");
    return;
  }
  // data-lazy-src stays on until the image finishes loading: CSS keeps the img
  // transparent while the attribute is present, so progressive JPEG decode
  // never paints half-finished frames over the skeleton. Removing it on load
  // fades the completed poster in. On error the attribute stays (img remains
  // transparent) and the markup's inline onerror handler hides the node.
  const reveal = () => {
    img.onload = null;
    img.removeAttribute("data-lazy-src");
  };
  if (img.getAttribute("src") !== src) {
    img.onload = reveal;
    img.src = src;
  }
  if (img.complete && img.naturalWidth > 0) {
    reveal();
  }
}

function hydrateLazyPostersWithin(scope) {
  if (!(scope instanceof HTMLElement)) {
    return;
  }
  if (scope.matches?.("img[data-lazy-src]")) {
    hydrateLazyPosterImage(scope);
    return;
  }
  scope.querySelectorAll("img[data-lazy-src]").forEach(hydrateLazyPosterImage);
}

export function observeLazyPosterImages(host, root) {
  if (!host || !root) {
    return;
  }
  const scopes = new Set();
  root.querySelectorAll("img[data-lazy-src]").forEach((img) => {
    scopes.add(img.closest(".focusable") || img.parentElement || img);
  });
  if (!scopes.size) {
    return;
  }
  if (typeof IntersectionObserver !== "function") {
    scopes.forEach(hydrateLazyPostersWithin);
    return;
  }
  const scrollRoot = resolveScrollRoot(scopes.values().next().value);
  // Full re-renders replace the scroller node; an observer cached against the
  // old (now detached) root would never fire again, so rebuild it.
  if (host.__lazyPosterObserver && host.__lazyPosterObserver.root !== scrollRoot) {
    host.__lazyPosterObserver.disconnect();
    host.__lazyPosterObserver = null;
  }
  if (!host.__lazyPosterObserver) {
    host.__lazyPosterObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) {
          return;
        }
        hydrateLazyPostersWithin(entry.target);
        try {
          host.__lazyPosterObserver.unobserve(entry.target);
        } catch (_) {
          // Ignore unobserve failures.
        }
      });
    }, { root: scrollRoot, rootMargin: LAZY_POSTER_ROOT_MARGIN, threshold: 0.01 });
  }
  scopes.forEach((scope) => host.__lazyPosterObserver.observe(scope));
}
