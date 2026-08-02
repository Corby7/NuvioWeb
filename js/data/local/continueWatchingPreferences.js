import { LocalStore } from "../../core/storage/localStore.js";
import { ProfileManager } from "../../core/profile/profileManager.js";

const KEY = "continueWatchingPreferences";
const VERSION = 1;
const MAX_REMOVED_KEYS = 500;

function activeProfileId() {
  return String(ProfileManager.getActiveProfileId() || "1");
}

function normalizeKey(value) {
  return String(value || "").trim();
}

// contentId -> epoch ms of the removal. Progress entries at or older than that
// stamp stay hidden; anything newer means the title was watched again, so the
// tombstone stops applying on its own.
function normalizeRemovedKeys(raw) {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const entries = [];
  Object.keys(raw).forEach((key) => {
    const normalizedKey = normalizeKey(key);
    const removedAt = Math.trunc(Number(raw[key]));
    if (normalizedKey && Number.isFinite(removedAt) && removedAt > 0) {
      entries.push([normalizedKey, removedAt]);
    }
  });
  entries.sort((left, right) => right[1] - left[1]);
  const normalized = {};
  entries.slice(0, MAX_REMOVED_KEYS).forEach(([key, removedAt]) => {
    normalized[key] = removedAt;
  });
  return normalized;
}

function normalizeState(raw = {}) {
  const dismissedNextUpKeys = Array.isArray(raw.dismissedNextUpKeys)
    ? raw.dismissedNextUpKeys.map(normalizeKey).filter(Boolean)
    : [];
  return {
    version: VERSION,
    dismissedNextUpKeys: Array.from(new Set(dismissedNextUpKeys)).slice(0, 1000),
    removedKeys: normalizeRemovedKeys(raw.removedKeys)
  };
}

function readAll() {
  const raw = LocalStore.get(KEY, {});
  return raw && typeof raw === "object" ? raw : {};
}

function writeAll(next) {
  LocalStore.set(KEY, next && typeof next === "object" ? next : {});
}

function readForProfile(profileId = activeProfileId()) {
  const all = readAll();
  return normalizeState(all[String(profileId || "1")] || {});
}

function writeForProfile(profileId, state) {
  const pid = String(profileId || "1");
  const all = readAll();
  all[pid] = normalizeState(state);
  writeAll(all);
  return all[pid];
}

export const ContinueWatchingPreferences = {
  getDismissedNextUpKeys(profileId = activeProfileId()) {
    return readForProfile(profileId).dismissedNextUpKeys;
  },

  addDismissedNextUpKey(key, profileId = activeProfileId()) {
    const normalizedKey = normalizeKey(key);
    if (!normalizedKey) {
      return readForProfile(profileId);
    }
    const current = readForProfile(profileId);
    return writeForProfile(profileId, {
      ...current,
      dismissedNextUpKeys: [
        normalizedKey,
        ...current.dismissedNextUpKeys.filter((entry) => entry !== normalizedKey)
      ]
    });
  },

  removeDismissedNextUpKeysForContent(contentId, profileId = activeProfileId()) {
    const normalizedContentId = normalizeKey(contentId);
    if (!normalizedContentId) {
      return readForProfile(profileId);
    }
    const current = readForProfile(profileId);
    return writeForProfile(profileId, {
      ...current,
      dismissedNextUpKeys: current.dismissedNextUpKeys.filter(
        (key) => !key.startsWith(`${normalizedContentId}|`)
      )
    });
  },

  getRemovedKeys(profileId = activeProfileId()) {
    return readForProfile(profileId).removedKeys;
  },

  // Trakt-sourced progress can't be deleted from here, and cloud rows can
  // survive a failed delete, so a removal is also recorded locally.
  addRemovedKey(contentId, removedAt = Date.now(), profileId = activeProfileId()) {
    const normalizedContentId = normalizeKey(contentId);
    if (!normalizedContentId) {
      return readForProfile(profileId);
    }
    const stamp = Math.trunc(Number(removedAt));
    const current = readForProfile(profileId);
    return writeForProfile(profileId, {
      ...current,
      removedKeys: {
        ...current.removedKeys,
        [normalizedContentId]: Number.isFinite(stamp) && stamp > 0 ? stamp : Date.now()
      }
    });
  },

  clearRemovedKey(contentId, profileId = activeProfileId()) {
    const normalizedContentId = normalizeKey(contentId);
    if (!normalizedContentId) {
      return readForProfile(profileId);
    }
    const current = readForProfile(profileId);
    if (!Object.prototype.hasOwnProperty.call(current.removedKeys, normalizedContentId)) {
      return current;
    }
    const nextRemovedKeys = { ...current.removedKeys };
    delete nextRemovedKeys[normalizedContentId];
    return writeForProfile(profileId, { ...current, removedKeys: nextRemovedKeys });
  }
};
