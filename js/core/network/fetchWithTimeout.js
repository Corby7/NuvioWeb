// Bounded fetch. No request may hang forever: when a backend edge stalls
// (e.g. Cloudflare 522s take 15-30s to surface), an unbounded fetch holds up
// every caller in the chain - at boot that means a black screen.
export function fetchWithTimeout(url, init = {}, timeoutMs = 0) {
  const budget = Number(timeoutMs);
  if (!(budget > 0) || typeof AbortController !== "function" || init.signal) {
    return fetch(url, init);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch (_) {
      // Ignore abort failures.
    }
  }, budget);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
  });
}
