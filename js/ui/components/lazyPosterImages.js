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

function hydrateLazyPosterImage(img) {
  const src = img.getAttribute("data-lazy-src") || "";
  img.removeAttribute("data-lazy-src");
  if (src && img.getAttribute("src") !== src) {
    img.src = src;
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
    }, { root: null, rootMargin: LAZY_POSTER_ROOT_MARGIN, threshold: 0.01 });
  }
  scopes.forEach((scope) => host.__lazyPosterObserver.observe(scope));
}
