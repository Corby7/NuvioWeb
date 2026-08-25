// Trakt returns image URLs without a scheme, e.g.
// "media.trakt.tv/images/movies/poster.jpg.webp". A browser resolves that as a
// path relative to the current document, so on a packaged TV build it becomes a
// file:// lookup and the poster silently fails to load. Restore the https
// scheme before the URL reaches an <img>.

const TRAKT_HOST_PATTERN = /^[a-z0-9.-]*trakt\.tv\//i;

// Returns the URL with an https scheme when it points at a Trakt host, leaving
// already-absolute or unrelated values untouched.
export function toTraktImageUrl(value) {
  const normalized = String(value || "").trim();
  if (/^https:\/\//i.test(normalized)) {
    return normalized;
  }
  if (/^http:\/\//i.test(normalized)) {
    return `https://${normalized.slice(normalized.indexOf("://") + 3)}`;
  }
  if (normalized.startsWith("//")) {
    return `https:${normalized}`;
  }
  if (TRAKT_HOST_PATTERN.test(normalized)) {
    return `https://${normalized}`;
  }
  return normalized;
}
