import { AuthManager } from "../auth/authManager.js";
import { addonRepository } from "../../data/repository/addonRepository.js";
import { SupabaseApi } from "../../data/remote/supabase/supabaseApi.js";
import { ProfileManager } from "./profileManager.js";

const ADDONS_TABLE = "addons";
const TABLE = "tv_addons";

// Records the outcome of the latest pull so the Addons screen can show a
// visible sync state on TV.
let lastPullStatus = { state: "idle", count: 0, error: null, at: 0 };

function recordPullStatus(state, { count = 0, error = null } = {}) {
  lastPullStatus = {
    state,
    count: Number(count) || 0,
    error: error ? String(error.message || error) : null,
    at: Date.now()
  };
}

function isMissingResourceError(error) {
  if (!error) {
    return false;
  }
  if (error.status === 404) {
    return true;
  }
  if (typeof error.code === "string" && (error.code === "PGRST205" || error.code === "PGRST202")) {
    return true;
  }
  const message = String(error.message || "");
  return (
    message.includes("PGRST205") ||
    message.includes("PGRST202") ||
    message.includes("Could not find the table") ||
    message.includes("Could not find the function")
  );
}

function isOnConflictConstraintError(error) {
  if (!error) {
    return false;
  }
  if (typeof error.code === "string" && error.code === "42P10") {
    return true;
  }
  const message = String(error.message || "");
  return (
    message.includes("42P10") ||
    message.includes("no unique or exclusion constraint matching the ON CONFLICT specification")
  );
}

async function resolveProfileId() {
  const activeId = String(ProfileManager.getActiveProfileId() || "1");
  const direct = Number(activeId);
  if (Number.isFinite(direct) && direct > 0) {
    return Math.trunc(direct);
  }

  const profiles = await ProfileManager.getProfiles();
  const activeProfile = profiles.find((profile) => String(profile.id) === activeId);
  const candidate = Number(activeProfile?.profileIndex || activeProfile?.id || 1);
  return Number.isFinite(candidate) && candidate > 0 ? Math.trunc(candidate) : 1;
}

async function resolveAddonProfileId() {
  const profileId = await resolveProfileId();
  if (profileId === 1) {
    return 1;
  }

  const profiles = await ProfileManager.getProfiles();
  const activeProfile = profiles.find((profile) => {
    const id = Number(profile?.profileIndex || profile?.id || 1);
    return Number.isFinite(id) && Math.trunc(id) === profileId;
  });
  const usesPrimaryAddons =
    typeof activeProfile?.usesPrimaryAddons === "boolean"
      ? activeProfile.usesPrimaryAddons
      : typeof activeProfile?.uses_primary_addons === "boolean"
        ? activeProfile.uses_primary_addons
        : true;

  return usesPrimaryAddons ? 1 : profileId;
}

function extractAddonUrls(rows = []) {
  return extractAddonEntries(rows)
    .map((entry) => entry.url)
    .filter(Boolean);
}

function extractAddonEntries(rows = []) {
  return (rows || [])
    .map((row) => ({
      url: row?.url || row?.base_url || null,
      displayName:
        row?.display_name ||
        row?.displayName ||
        row?.custom_name ||
        row?.customName ||
        row?.alias ||
        row?.name ||
        null,
      name: row?.name || null
    }))
    .filter((entry) => entry.url);
}

function applyPulledAddons(rows = []) {
  const entries = extractAddonEntries(rows);
  const urls = entries.map((entry) => entry.url).filter(Boolean);
  const currentNames = addonRepository.getAddonDisplayNameOverrides();
  addonRepository.setAddonDisplayNameOverrides(
    entries.map((entry) => {
      const cleanUrl = addonRepository.canonicalizeUrl(entry.url);
      return {
        url: entry.url,
        name: entry.displayName || entry.name || currentNames[cleanUrl] || ""
      };
    }),
    { replace: true }
  );
  return urls;
}

// A read that succeeds but yields nothing is not authoritative. PostgREST
// answers 200 [] both for a table that is genuinely empty and for one whose
// rows RLS filtered out, and setAddonOrder/setAddonDisplayNameOverrides replace
// wholesale with no empty guard of their own - so applying [] silently wipes
// the local addon list and every custom name. Mirror of the empty-list guard in
// push(): return null instead, and let the caller try the next source.
async function applyPulledAddonsIfPresent(rows) {
  if (!extractAddonEntries(rows).length) {
    return null;
  }
  const urls = applyPulledAddons(rows);
  if (!urls.length) {
    return null;
  }
  await addonRepository.setAddonOrder(urls, { silent: true });
  return urls;
}

export const LibrarySyncService = {
  getLastPullStatus() {
    return lastPullStatus;
  },

  async pull() {
    let readError = null;
    try {
      if (!AuthManager.isAuthenticated) {
        recordPullStatus("signed-out");
        return [];
      }
      const localUrls = addonRepository.getInstalledAddonUrls();
      const profileId = await resolveAddonProfileId();
      const ownerId = await AuthManager.getEffectiveUserId();

      try {
        const addonRows = await SupabaseApi.select(
          ADDONS_TABLE,
          `user_id=eq.${encodeURIComponent(ownerId)}&profile_id=eq.${profileId}&select=*&order=sort_order.asc`,
          true
        );
        const addonUrls = await applyPulledAddonsIfPresent(addonRows);
        if (addonUrls) {
          recordPullStatus("ok", { count: addonUrls.length });
          return addonUrls;
        }
      } catch (addonsTableError) {
        if (!isMissingResourceError(addonsTableError)) {
          readError = addonsTableError;
        }
        console.warn("Addon sync pull addons-table read failed", addonsTableError);
      }

      try {
        const rows = await SupabaseApi.select(
          TABLE,
          `owner_id=eq.${encodeURIComponent(ownerId)}&select=*&order=position.asc`,
          true
        );
        const urls = await applyPulledAddonsIfPresent(rows);
        if (urls) {
          recordPullStatus("ok", { count: urls.length });
          return urls;
        }
      } catch (tvTableError) {
        if (!isMissingResourceError(tvTableError)) {
          readError = tvTableError;
        }
        console.warn("Addon sync pull tv-table read failed", tvTableError);
      }

      // Reached whenever neither table produced entries - including when they
      // answered 200 [] rather than 404. On an RPC-backed deployment the tables
      // read empty by design and this is the only source that has the addons,
      // so gating it on both tables being *missing* meant it was never tried.
      try {
        const rpcRows = await SupabaseApi.rpc(
          "sync_pull_addons",
          { p_profile_id: profileId },
          true
        );
        const urls = await applyPulledAddonsIfPresent(rpcRows);
        if (urls) {
          recordPullStatus("ok", { count: urls.length });
          return urls;
        }
      } catch (rpcError) {
        if (!isMissingResourceError(rpcError)) {
          readError = rpcError;
        }
        console.warn("Addon sync pull RPC failed", rpcError);
      }

      if (readError) {
        recordPullStatus("error", { count: localUrls.length, error: readError });
      } else {
        recordPullStatus("ok", { count: localUrls.length });
      }
      if (localUrls.length) {
        return localUrls;
      }
      return [];
    } catch (error) {
      recordPullStatus("error", { error });
      console.warn("Library sync pull failed", error);
      return [];
    }
  },

  async push() {
    try {
      if (!AuthManager.isAuthenticated) {
        return false;
      }
      const profileId = await resolveAddonProfileId();
      const urls = addonRepository.getInstalledAddonUrls();

      // An empty local list is never a legitimate thing to publish: every push
      // path below replaces the remote list wholesale, so shipping [] deletes
      // the user's addons everywhere. getInstalledAddonUrls() also falls back
      // to DEFAULT_ADDON_URLS, so "empty" here really does mean "we have
      // nothing", not "the user removed everything". Matches the guard in
      // savedLibrarySyncService.push().
      if (!urls.length) {
        return true;
      }

      try {
        await SupabaseApi.rpc(
          "sync_push_addons",
          {
            p_profile_id: profileId,
            p_addons: urls.map((url, index) => ({
              url,
              sort_order: index,
              ...(addonRepository.getAddonDisplayNameOverride(url)
                ? { name: addonRepository.getAddonDisplayNameOverride(url) }
                : {})
            }))
          },
          true
        );
        return true;
      } catch (rpcError) {
        console.warn("Addon sync push RPC failed, falling back to legacy table", rpcError);
      }

      const ownerId = await AuthManager.getEffectiveUserId();
      try {
        // Build the replacement rows before clearing the remote ones: the
        // delete is only safe as the first half of a delete+upsert pair.
        const addonRows = urls.map((url, index) => {
          const name = addonRepository.getAddonDisplayNameOverride(url);
          return {
            user_id: ownerId,
            profile_id: profileId,
            url,
            sort_order: index,
            ...(name ? { name } : {})
          };
        });
        if (!addonRows.length) {
          return true;
        }
        await SupabaseApi.delete(
          ADDONS_TABLE,
          `user_id=eq.${encodeURIComponent(ownerId)}&profile_id=eq.${profileId}`,
          true
        );
        try {
          await SupabaseApi.upsert(ADDONS_TABLE, addonRows, "user_id,profile_id,url", true);
        } catch (upsertError) {
          if (!isOnConflictConstraintError(upsertError)) {
            throw upsertError;
          }
          await SupabaseApi.upsert(ADDONS_TABLE, addonRows, null, true);
        }
        return true;
      } catch (addonsTableError) {
        if (!isMissingResourceError(addonsTableError)) {
          console.warn("Addon sync push addons-table fallback failed", addonsTableError);
          return false;
        }
        console.warn(
          "Addon sync push addons-table missing, trying tv_addons fallback",
          addonsTableError
        );
      }

      const rows = urls.map((baseUrl, index) => ({
        owner_id: ownerId,
        base_url: baseUrl,
        position: index
      }));
      if (!rows.length) {
        return true;
      }
      try {
        await SupabaseApi.delete(TABLE, `owner_id=eq.${encodeURIComponent(ownerId)}`, true);
        await SupabaseApi.upsert(TABLE, rows, "owner_id,base_url", true);
        return true;
      } catch (tvTableError) {
        console.warn("Addon sync push tv_addons fallback failed", tvTableError);
        return false;
      }
    } catch (error) {
      console.warn("Library sync push failed", error);
      return false;
    }
  }
};
