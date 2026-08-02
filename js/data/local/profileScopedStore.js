import { LocalStore } from "../../core/storage/localStore.js";
import { ProfileManager } from "../../core/profile/profileManager.js";

const PROFILE_SCOPED_VERSION = 1;
const PROFILES_KEY = "profiles";
const SETTINGS_SYNC_DEBOUNCE_MS = 1500;
const SETTINGS_SYNC_PENDING_KEY = "profileSettingsSyncPendingProfiles";
const HOME_CATALOG_SYNC_PENDING_KEY = "homeCatalogSyncPendingProfiles";

let pendingTokenCounter = 0;

const scheduledSettingsSyncTimers = new Map();
const settingsSyncInFlightByProfile = new Map();

function normalizeProfileId(profileId) {
  const raw = String(profileId ?? ProfileManager.getActiveProfileId() ?? "1").trim();
  return raw || "1";
}

function cloneValue(value) {
  if (value == null) {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}

function isProfileScopedEnvelope(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    value.__profileScoped === true &&
    Number(value.version || 0) === PROFILE_SCOPED_VERSION &&
    value.profiles &&
    typeof value.profiles === "object"
  );
}

function getKnownProfileIds() {
  const storedProfiles = LocalStore.get(PROFILES_KEY, null);
  const ids = Array.isArray(storedProfiles)
    ? storedProfiles
        .map((profile) => String(profile?.id || profile?.profileIndex || "").trim())
        .filter(Boolean)
    : [];
  if (!ids.includes("1")) {
    ids.unshift("1");
  }
  return Array.from(new Set(ids));
}

function createEmptyEnvelope() {
  return {
    __profileScoped: true,
    version: PROFILE_SCOPED_VERSION,
    profiles: {}
  };
}

function normalizeEnvelopeProfiles(profiles = {}, normalize) {
  const normalized = {};
  Object.entries(profiles || {}).forEach(([profileId, value]) => {
    const normalizedProfileId = normalizeProfileId(profileId);
    normalized[normalizedProfileId] = normalize(cloneValue(value) || {});
  });
  return normalized;
}

function readEnvelope(key, normalize) {
  const raw = LocalStore.get(key, null);
  if (isProfileScopedEnvelope(raw)) {
    const next = {
      ...raw,
      profiles: normalizeEnvelopeProfiles(raw.profiles, normalize)
    };
    if (JSON.stringify(next) !== JSON.stringify(raw)) {
      LocalStore.set(key, next);
    }
    return next;
  }

  if (raw == null) {
    return createEmptyEnvelope();
  }

  const profileIds = getKnownProfileIds();
  const normalizedLegacy = normalize(cloneValue(raw) || {});
  const migrated = createEmptyEnvelope();
  profileIds.forEach((profileId) => {
    migrated.profiles[profileId] = cloneValue(normalizedLegacy);
  });
  LocalStore.set(key, migrated);
  return migrated;
}

function persistEnvelope(key, envelope) {
  LocalStore.set(key, envelope);
}

function readPendingSyncProfiles(storageKey) {
  const value = LocalStore.get(storageKey, {}) || {};
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

// The token changes on every mark so a push can tell "the local value I just
// shipped" from "the user edited again while my RPC was in flight" and refuse to
// clear the flag in the latter case.
function markPendingSyncProfile(storageKey, profileId) {
  const normalizedProfileId = normalizeProfileId(profileId);
  const pending = readPendingSyncProfiles(storageKey);
  pendingTokenCounter += 1;
  pending[normalizedProfileId] = `${Date.now()}:${pendingTokenCounter}`;
  LocalStore.set(storageKey, pending);
}

function clearPendingSyncProfile(storageKey, profileId, expectedToken = null) {
  const normalizedProfileId = normalizeProfileId(profileId);
  const pending = readPendingSyncProfiles(storageKey);
  if (!Object.prototype.hasOwnProperty.call(pending, normalizedProfileId)) {
    return;
  }
  if (expectedToken != null && pending[normalizedProfileId] !== expectedToken) {
    return;
  }
  delete pending[normalizedProfileId];
  LocalStore.set(storageKey, pending);
}

function pendingSyncProfileToken(storageKey, profileId) {
  const normalizedProfileId = normalizeProfileId(profileId);
  const pending = readPendingSyncProfiles(storageKey);
  return Object.prototype.hasOwnProperty.call(pending, normalizedProfileId)
    ? pending[normalizedProfileId]
    : null;
}

export function markProfileSettingsCloudSyncPending(profileId = null) {
  markPendingSyncProfile(SETTINGS_SYNC_PENDING_KEY, profileId);
}

export function clearProfileSettingsCloudSyncPending(profileId = null) {
  clearPendingSyncProfile(SETTINGS_SYNC_PENDING_KEY, profileId);
}

export function hasProfileSettingsCloudSyncPending(profileId = null) {
  return pendingSyncProfileToken(SETTINGS_SYNC_PENDING_KEY, profileId) != null;
}

// Home catalog order/visibility lives in its own remote blob with its own push
// path, so it needs its own persisted dirty flag: an in-memory one is lost when
// the app is closed (or when the initial pull failed and gated the push), and
// the next pull then applies the stale remote order over the local one.
export function markHomeCatalogCloudSyncPending(profileId = null) {
  markPendingSyncProfile(HOME_CATALOG_SYNC_PENDING_KEY, profileId);
}

export function clearHomeCatalogCloudSyncPending(profileId = null, expectedToken = null) {
  clearPendingSyncProfile(HOME_CATALOG_SYNC_PENDING_KEY, profileId, expectedToken);
}

export function homeCatalogCloudSyncPendingToken(profileId = null) {
  return pendingSyncProfileToken(HOME_CATALOG_SYNC_PENDING_KEY, profileId);
}

export function hasHomeCatalogCloudSyncPending(profileId = null) {
  return pendingSyncProfileToken(HOME_CATALOG_SYNC_PENDING_KEY, profileId) != null;
}

function ensureProfileValue(key, envelope, normalize, profileId) {
  const normalizedProfileId = normalizeProfileId(profileId);
  if (Object.prototype.hasOwnProperty.call(envelope.profiles, normalizedProfileId)) {
    return envelope.profiles[normalizedProfileId];
  }

  const primaryValue = envelope.profiles["1"];
  const seed = primaryValue != null ? cloneValue(primaryValue) : normalize({});
  envelope.profiles[normalizedProfileId] = normalize(seed || {});
  persistEnvelope(key, envelope);
  return envelope.profiles[normalizedProfileId];
}

export function queueProfileSettingsCloudSync(
  profileId = null,
  delayMs = SETTINGS_SYNC_DEBOUNCE_MS
) {
  const normalizedProfileId = normalizeProfileId(profileId);
  markProfileSettingsCloudSyncPending(normalizedProfileId);
  if (scheduledSettingsSyncTimers.has(normalizedProfileId)) {
    clearTimeout(scheduledSettingsSyncTimers.get(normalizedProfileId));
  }
  const timerId = setTimeout(() => {
    scheduledSettingsSyncTimers.delete(normalizedProfileId);
    const runPush = async () => {
      const activePush = settingsSyncInFlightByProfile.get(normalizedProfileId);
      if (activePush) {
        await activePush.catch(() => false);
      }
      const pushPromise = import("../../core/profile/profileSettingsSyncService.js")
        .then(({ ProfileSettingsSyncService }) =>
          ProfileSettingsSyncService.push(normalizedProfileId)
        )
        .catch((error) => {
          console.warn("Profile settings sync enqueue failed", error);
          return false;
        })
        .finally(() => {
          if (settingsSyncInFlightByProfile.get(normalizedProfileId) === pushPromise) {
            settingsSyncInFlightByProfile.delete(normalizedProfileId);
          }
        });
      settingsSyncInFlightByProfile.set(normalizedProfileId, pushPromise);
      await pushPromise;
    };
    void runPush();
  }, delayMs);
  scheduledSettingsSyncTimers.set(normalizedProfileId, timerId);
}

export function createProfileScopedStore({ key, normalize, merge }) {
  const mergeValues =
    typeof merge === "function"
      ? merge
      : (current, partial) => ({ ...(current || {}), ...(partial || {}) });

  return {
    getForProfile(profileId) {
      const envelope = readEnvelope(key, normalize);
      return cloneValue(ensureProfileValue(key, envelope, normalize, profileId));
    },

    get() {
      return this.getForProfile(normalizeProfileId());
    },

    replaceForProfile(profileId, nextValue, { silentSync = false } = {}) {
      const envelope = readEnvelope(key, normalize);
      const normalizedProfileId = normalizeProfileId(profileId);
      envelope.profiles[normalizedProfileId] = normalize(cloneValue(nextValue) || {});
      persistEnvelope(key, envelope);
      if (!silentSync) {
        queueProfileSettingsCloudSync(normalizedProfileId);
      }
      return cloneValue(envelope.profiles[normalizedProfileId]);
    },

    setForProfile(profileId, partial, { silentSync = false } = {}) {
      const current = this.getForProfile(profileId);
      return this.replaceForProfile(profileId, mergeValues(current, partial), { silentSync });
    },

    set(partial, options = {}) {
      return this.setForProfile(normalizeProfileId(options.profileId), partial, options);
    },

    clearProfile(profileId, { silentSync = false } = {}) {
      const envelope = readEnvelope(key, normalize);
      const normalizedProfileId = normalizeProfileId(profileId);
      delete envelope.profiles[normalizedProfileId];
      persistEnvelope(key, envelope);
      if (!silentSync) {
        queueProfileSettingsCloudSync(normalizedProfileId);
      }
    }
  };
}
