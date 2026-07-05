import { LocalStore } from "../../core/storage/localStore.js";
import { ProfileManager } from "../../core/profile/profileManager.js";

// Per-show subtitle preferences (language, delay, vertical offset). Keyed by
// profile + content id (the base meta id, so one record covers every episode
// of a series). These override the global player settings for that title and
// are written whenever the user changes subtitles inside the player.

const KEY = "subtitleItemPreferences";
const MAX_ENTRIES = 300;

function activeProfileId() {
  return String(ProfileManager.getActiveProfileId?.() ?? "1") || "1";
}

function entryKey(contentId, profileId = activeProfileId()) {
  const normalizedContentId = String(contentId || "").trim();
  return normalizedContentId ? `${profileId}::${normalizedContentId}` : "";
}

function readAll() {
  const value = LocalStore.get(KEY, {});
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeEntry(entry = {}) {
  const normalized = { updatedAt: Number(entry.updatedAt) || Date.now() };
  if (entry.languageKey != null) {
    const languageKey = String(entry.languageKey || "").trim();
    if (languageKey) {
      normalized.languageKey = languageKey;
    }
  }
  const delayMs = Number(entry.delayMs);
  if (Number.isFinite(delayMs) && entry.delayMs != null) {
    normalized.delayMs = Math.trunc(delayMs);
  }
  const verticalOffset = Number(entry.verticalOffset);
  if (Number.isFinite(verticalOffset) && entry.verticalOffset != null) {
    normalized.verticalOffset = Math.trunc(verticalOffset);
  }
  return normalized;
}

function pruneOldest(all) {
  const keys = Object.keys(all);
  if (keys.length <= MAX_ENTRIES) {
    return all;
  }
  keys
    .sort((left, right) => Number(all[left]?.updatedAt || 0) - Number(all[right]?.updatedAt || 0))
    .slice(0, keys.length - MAX_ENTRIES)
    .forEach((key) => {
      delete all[key];
    });
  return all;
}

export const SubtitleItemPreferencesStore = {

  get(contentId) {
    const key = entryKey(contentId);
    if (!key) {
      return null;
    }
    const entry = readAll()[key];
    return entry && typeof entry === "object" ? normalizeEntry(entry) : null;
  },

  set(contentId, partial = {}) {
    const key = entryKey(contentId);
    if (!key) {
      return null;
    }
    const all = readAll();
    const merged = normalizeEntry({
      ...(all[key] && typeof all[key] === "object" ? all[key] : {}),
      ...partial,
      updatedAt: Date.now()
    });
    all[key] = merged;
    LocalStore.set(KEY, pruneOldest(all));
    return merged;
  },

  remove(contentId) {
    const key = entryKey(contentId);
    if (!key) {
      return;
    }
    const all = readAll();
    if (Object.prototype.hasOwnProperty.call(all, key)) {
      delete all[key];
      LocalStore.set(KEY, all);
    }
  }

};
