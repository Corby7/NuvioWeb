import { createProfileScopedStore } from "./profileScopedStore.js";

const KEY = "calendarShows";

// Two explicit lists rather than one membership flag: `added` are shows the
// user subscribed to from the detail screen (they contribute episodes even
// without a Trakt account), while `hidden` suppresses shows that would
// otherwise appear via Trakt's "my shows" calendar. remove() moves a show
// from added to hidden, so the two never overlap for the same id.
const DEFAULTS = {
  added: {},
  hidden: {}
};

function normalizeShowEntry(value = {}, fallbackId = "") {
  const id = String(value?.id || fallbackId || "").trim();
  if (!id) {
    return null;
  }
  return {
    id,
    name: String(value?.name || "").trim(),
    poster: value?.poster ? String(value.poster) : null,
    updatedAt: Number(value?.updatedAt || 0)
  };
}

function normalizeShowMap(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const map = {};
  Object.entries(source).forEach(([id, entry]) => {
    const normalized = normalizeShowEntry(entry, id);
    if (normalized) {
      map[normalized.id] = normalized;
    }
  });
  return map;
}

function normalizeCalendarShows(value = {}) {
  return {
    ...DEFAULTS,
    added: normalizeShowMap(value?.added),
    hidden: normalizeShowMap(value?.hidden)
  };
}

const store = createProfileScopedStore({
  key: KEY,
  normalize: normalizeCalendarShows
});

export const CalendarShowsStore = {
  getForProfile(profileId) {
    return store.getForProfile(profileId);
  },

  get() {
    return store.get();
  },

  setForProfile(profileId, partial, options = {}) {
    return store.setForProfile(profileId, partial, options);
  },

  set(partial, options = {}) {
    return store.set(partial, options);
  },

  isInCalendar(showId) {
    const id = String(showId || "").trim();
    if (!id) {
      return false;
    }
    return Boolean(this.get().added[id]);
  },

  add({ id, name = "", poster = null } = {}) {
    const showId = String(id || "").trim();
    if (!showId) {
      return;
    }
    const { added, hidden } = this.get();
    added[showId] = { id: showId, name: String(name || "").trim(), poster: poster || null, updatedAt: Date.now() };
    delete hidden[showId];
    this.set({ added, hidden });
  },

  remove({ id, name = "" } = {}) {
    const showId = String(id || "").trim();
    if (!showId) {
      return;
    }
    const { added, hidden } = this.get();
    const knownName = String(name || added[showId]?.name || "").trim();
    delete added[showId];
    hidden[showId] = { id: showId, name: knownName, poster: null, updatedAt: Date.now() };
    this.set({ added, hidden });
  },

  unhide(showId) {
    const id = String(showId || "").trim();
    if (!id) {
      return;
    }
    const { hidden } = this.get();
    if (!hidden[id]) {
      return;
    }
    delete hidden[id];
    this.set({ hidden });
  }
};
