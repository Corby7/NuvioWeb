import { AVATAR_PUBLIC_BASE_URL, SUPABASE_URL } from "../../../config.js";
import { SupabaseApi } from "./supabaseApi.js";
import { LocalStore } from "../../../core/storage/localStore.js";

const AVATAR_BUCKET = "avatars";
const CATALOG_CACHE_KEY = "avatarCatalogCache";
// The catalog is static content; a week-old copy is fine and means boots
// never wait on (or fail with) the network for avatars.
const CATALOG_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let cachedCatalog = null;
let refreshInFlight = null;

function avatarImageUrl(storagePath = "") {
  const normalizedPath = String(storagePath || "").trim().replace(/^\/+/, "");
  if (!normalizedPath) {
    return null;
  }
  const configuredBaseUrl = String(AVATAR_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (configuredBaseUrl) {
    return `${configuredBaseUrl}/${normalizedPath}`;
  }
  return `${String(SUPABASE_URL || "").replace(/\/+$/, "")}/storage/v1/object/public/${AVATAR_BUCKET}/${normalizedPath}`;
}

function mapAvatar(row = {}) {
  return {
    id: String(row.id || ""),
    displayName: String(row.display_name || row.displayName || "Avatar"),
    imageUrl: avatarImageUrl(row.storage_path || row.storagePath || ""),
    category: String(row.category || "all").trim().toLowerCase(),
    sortOrder: Number(row.sort_order || row.sortOrder || 0),
    bgColor: row.bg_color || row.bgColor || null
  };
}

function readPersistedCatalog() {
  const stored = LocalStore.get(CATALOG_CACHE_KEY, null);
  const rows = Array.isArray(stored?.catalog) ? stored.catalog : [];
  if (!rows.length) {
    return null;
  }
  return {
    catalog: rows.map((row) => mapAvatar(row)).filter((avatar) => avatar.id && avatar.imageUrl),
    stale: (Date.now() - Number(stored.savedAt || 0)) > CATALOG_CACHE_TTL_MS
  };
}

async function fetchCatalogFromNetwork() {
  const response = await SupabaseApi.rpc("get_avatar_catalog", {}, false);
  const rows = Array.isArray(response) ? response : [];
  const catalog = rows.map((row) => mapAvatar(row)).filter((avatar) => avatar.id && avatar.imageUrl);
  if (catalog.length) {
    cachedCatalog = catalog;
    LocalStore.set(CATALOG_CACHE_KEY, { savedAt: Date.now(), catalog: rows });
  }
  return catalog;
}

function refreshCatalogInBackground() {
  if (refreshInFlight) {
    return;
  }
  refreshInFlight = fetchCatalogFromNetwork()
    .catch(() => [])
    .finally(() => {
      refreshInFlight = null;
    });
}

export const AvatarRepository = {

  async getAvatarCatalog() {
    if (Array.isArray(cachedCatalog) && cachedCatalog.length) {
      return cachedCatalog;
    }

    // Serve the persisted copy immediately (refreshing behind the scenes if
    // it has gone stale) so avatars never block or fail with the network.
    const persisted = readPersistedCatalog();
    if (persisted?.catalog?.length) {
      cachedCatalog = persisted.catalog;
      if (persisted.stale) {
        refreshCatalogInBackground();
      }
      return cachedCatalog;
    }

    return fetchCatalogFromNetwork();
  },

  getAvatarImageUrl(avatarId, catalog = cachedCatalog || []) {
    const normalizedId = String(avatarId || "").trim();
    if (!normalizedId) {
      return null;
    }
    return catalog.find((avatar) => avatar.id === normalizedId)?.imageUrl || null;
  },

  invalidateCache() {
    cachedCatalog = null;
    LocalStore.remove(CATALOG_CACHE_KEY);
  }

};
