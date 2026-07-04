const _pending = new Map();
let _flushHandle = null;

function _flush() {
  _flushHandle = null;
  for (const [key, serialized] of _pending) {
    try {
      localStorage.setItem(key, serialized);
    } catch (e) {
      console.error("LocalStore flush error:", e);
    }
  }
  _pending.clear();
}

function _scheduleFlush() {
  if (_flushHandle !== null) {
    return;
  }
  // localStorage writes are synchronous disk I/O (slow on webOS flash). A microtask
  // would run before the next paint, blocking the very frame that triggered the
  // write — defer past the frame instead. setTimeout keeps webOS compatibility.
  _flushHandle = setTimeout(_flush, 0);
}

// Deferred writes must not be lost when the app is hidden or torn down.
if (typeof window !== "undefined") {
  const flushNow = () => {
    if (_flushHandle !== null) {
      clearTimeout(_flushHandle);
      _flush();
    }
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushNow();
  });
  window.addEventListener("pagehide", flushNow);
  window.addEventListener("beforeunload", flushNow);
}

export const LocalStore = {

  get(key, defaultValue = null) {
    if (_pending.has(key)) {
      try {
        return JSON.parse(_pending.get(key));
      } catch {
        return defaultValue;
      }
    }
    try {
      const value = localStorage.getItem(key);
      return value !== null ? JSON.parse(value) : defaultValue;
    } catch (e) {
      console.error("LocalStore get error:", e);
      return defaultValue;
    }
  },

  set(key, value) {
    try {
      _pending.set(key, JSON.stringify(value));
      _scheduleFlush();
    } catch (e) {
      console.error("LocalStore set error:", e);
    }
  },

  remove(key) {
    _pending.delete(key);
    localStorage.removeItem(key);
  },

  clear() {
    _pending.clear();
    localStorage.clear();
  }
};
