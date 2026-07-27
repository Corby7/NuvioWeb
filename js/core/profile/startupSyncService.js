import { AuthManager } from "../auth/authManager.js";
import { addonRepository } from "../../data/repository/addonRepository.js";
import { ProfileManager } from "./profileManager.js";
import { ProfileSyncService } from "./profileSyncService.js";
import { LibrarySyncService } from "./librarySyncService.js";
import { WatchProgressSyncService } from "./watchProgressSyncService.js";
import { SavedLibrarySyncService } from "./savedLibrarySyncService.js";
import { WatchedItemsSyncService } from "./watchedItemsSyncService.js";
import { PluginSyncService } from "./pluginSyncService.js";
import { ProfileSettingsSyncService } from "./profileSettingsSyncService.js";
import { TraktCredentialSyncService } from "./traktCredentialSyncService.js";
import { CollectionSyncService } from "./collectionSyncService.js";
import { HomeCatalogSettingsSyncService } from "./homeCatalogSettingsSyncService.js";
import { ThemeManager } from "../../ui/theme/themeManager.js";
import { I18n } from "../../i18n/index.js";

const SYNC_INTERVAL_MS = 120000;
const ADDON_PUSH_DEBOUNCE_MS = 1000;
const MAX_PULL_ATTEMPTS = 3;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeProfileId(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

async function collectKnownProfileIds(profiles = []) {
  const ids = [
    normalizeProfileId(ProfileManager.getActiveProfileId()),
    ...(Array.isArray(profiles) ? profiles : []).map((profile) =>
      normalizeProfileId(profile?.id ?? profile?.profileIndex)
    )
  ].filter(Boolean);

  if (ids.length <= 1) {
    const storedProfiles = await ProfileManager.getProfiles().catch(() => []);
    ids.push(
      ...storedProfiles
        .map((profile) => normalizeProfileId(profile?.id ?? profile?.profileIndex))
        .filter(Boolean)
    );
  }

  return Array.from(new Set(ids));
}

export const StartupSyncService = {
  started: false,
  intervalId: null,
  inFlight: false,
  profileScopedSyncEnabled: false,
  addonPushTimer: null,
  unsubscribeAddonChanges: null,
  // Set once a pull has actually landed remote state in the local stores.
  // Until then no push may run — the local stores are still seeded defaults.
  hasPulledSuccessfully: false,

  async start({ profileScopedSyncEnabled = false } = {}) {
    if (this.started) {
      if (profileScopedSyncEnabled) {
        this.profileScopedSyncEnabled = true;
      }
      return;
    }
    this.started = true;
    this.profileScopedSyncEnabled = Boolean(profileScopedSyncEnabled);
    this.hasPulledSuccessfully = false;

    this.unsubscribeAddonChanges = addonRepository.onInstalledAddonsChanged(() => {
      this.scheduleAddonPush();
    });

    // Install the periodic cycle before awaiting the first pull. A slow first
    // pull must not leave the session with no sync timer at all, and syncCycle
    // is already re-entrancy guarded by inFlight.
    this.intervalId = setInterval(() => {
      this.syncCycle();
    }, SYNC_INTERVAL_MS);

    this.inFlight = true;
    try {
      await this.syncPull({ includeProfileScoped: this.profileScopedSyncEnabled });
    } finally {
      this.inFlight = false;
    }
  },

  stop() {
    this.started = false;
    this.profileScopedSyncEnabled = false;
    this.hasPulledSuccessfully = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.addonPushTimer) {
      clearTimeout(this.addonPushTimer);
      this.addonPushTimer = null;
    }
    if (this.unsubscribeAddonChanges) {
      this.unsubscribeAddonChanges();
      this.unsubscribeAddonChanges = null;
    }
  },

  enableProfileScopedSync() {
    this.profileScopedSyncEnabled = true;
  },

  // Returns { ok, didApplyProfileSettings }. `ok` is the authoritative
  // "remote state was successfully read into the local stores" signal — the
  // push half of a cycle MUST be gated on it. Reporting only
  // didApplyProfileSettings (as this used to) made a total pull failure
  // indistinguishable from a clean pull that changed no settings, so the
  // following push shipped whatever the local stores happened to hold —
  // defaults on a fresh device — straight over good remote data.
  async syncPull({ includeProfileScoped = this.profileScopedSyncEnabled } = {}) {
    if (!AuthManager.isAuthenticated) {
      return { ok: false, didApplyProfileSettings: false };
    }
    let didApplyProfileSettings = false;
    for (let attempt = 1; attempt <= MAX_PULL_ATTEMPTS; attempt += 1) {
      try {
        const profiles = await ProfileSyncService.pull();
        const profileIds = await collectKnownProfileIds(profiles);
        for (const profileId of profileIds) {
          didApplyProfileSettings =
            (await ProfileSettingsSyncService.pull(profileId)) || didApplyProfileSettings;
        }
        if (didApplyProfileSettings) {
          await I18n.init();
          ThemeManager.apply();
          I18n.apply();
        }
        await TraktCredentialSyncService.pullFromRemote(ProfileManager.getActiveProfileId());
        if (!includeProfileScoped) {
          this.hasPulledSuccessfully = true;
          return { ok: true, didApplyProfileSettings };
        }
        await CollectionSyncService.pull();
        await HomeCatalogSettingsSyncService.pull();
        await PluginSyncService.pull();
        await LibrarySyncService.pull();
        await SavedLibrarySyncService.pull();
        await WatchedItemsSyncService.pull();
        await WatchProgressSyncService.pull();
        this.hasPulledSuccessfully = true;
        return { ok: true, didApplyProfileSettings };
      } catch (error) {
        console.warn(`Startup sync pull failed (attempt ${attempt}/${MAX_PULL_ATTEMPTS})`, error);
        if (attempt < MAX_PULL_ATTEMPTS) {
          await sleep(3000);
        }
      }
    }
    return { ok: false, didApplyProfileSettings };
  },

  async syncPush() {
    if (!AuthManager.isAuthenticated) {
      return;
    }
    try {
      await ProfileSyncService.push();
      await ProfileSettingsSyncService.push();
      await TraktCredentialSyncService.pushCurrentToRemote(ProfileManager.getActiveProfileId());
      await CollectionSyncService.push();
      await HomeCatalogSettingsSyncService.push();
      await PluginSyncService.push();
      await LibrarySyncService.push();
      await SavedLibrarySyncService.push();
      await WatchedItemsSyncService.push();
      await WatchProgressSyncService.push();
    } catch (error) {
      console.warn("Startup sync push failed", error);
    }
  },

  async syncCycle() {
    if (!this.started || this.inFlight) {
      return;
    }
    this.inFlight = true;
    try {
      const includeProfileScoped = this.profileScopedSyncEnabled;
      const { ok } = await this.syncPull({ includeProfileScoped });
      if (!ok) {
        // Never push on top of a failed pull: the local stores may still hold
        // pre-sync defaults, and the push services overwrite remote state
        // wholesale. Skip this cycle and retry the pull in SYNC_INTERVAL_MS.
        console.warn("Startup sync: skipping push because the pull did not succeed");
        return;
      }
      if (includeProfileScoped) {
        await this.syncPush();
      }
    } finally {
      this.inFlight = false;
    }
  },

  scheduleAddonPush() {
    if (!this.started || !this.profileScopedSyncEnabled) {
      return;
    }
    if (this.addonPushTimer) {
      clearTimeout(this.addonPushTimer);
    }
    this.addonPushTimer = setTimeout(async () => {
      this.addonPushTimer = null;
      if (!AuthManager.isAuthenticated) {
        return;
      }
      if (!this.hasPulledSuccessfully) {
        // The local addon list has never been reconciled with the server this
        // session, so it may still be the seeded defaults. Pushing it would
        // overwrite the real remote list with them.
        console.warn("Addon auto push skipped: no successful pull yet this session");
        return;
      }
      try {
        await LibrarySyncService.push();
      } catch (error) {
        console.warn("Addon auto push failed", error);
      }
    }, ADDON_PUSH_DEBOUNCE_MS);
  }
};
