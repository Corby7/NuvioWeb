const _pending = new Map();
let _flushScheduled = false;

function _flush() {
  _flushScheduled = false;
  for (const [key, serialized] of _pending) {
    try {
      localStorage.setItem(key, serialized);
    } catch (e) {
      console.error("LocalStore flush error:", e);
    }
  }
  _pending.clear();
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
      if (!_flushScheduled) {
        _flushScheduled = true;
        queueMicrotask(_flush);
      }
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
