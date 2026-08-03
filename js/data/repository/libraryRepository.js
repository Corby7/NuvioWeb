import { AuthManager } from "../../core/auth/authManager.js";
import { SavedLibrarySyncService } from "../../core/profile/savedLibrarySyncService.js";
import { ProfileManager } from "../../core/profile/profileManager.js";
import { LocalStore } from "../../core/storage/localStore.js";
import { savedLibraryRepository } from "./savedLibraryRepository.js";
import { metaRepository } from "./metaRepository.js";
import { TraktAuthService } from "./traktAuthService.js";
import { TraktLibrarySourceMode, TraktSettingsStore } from "../local/traktSettingsStore.js";

export const LibrarySourceMode = {
  LOCAL: "local",
  TRAKT: "trakt"
};

export const LibrarySortOptionKey = {
  DEFAULT: "default",
  ADDED_DESC: "added_desc",
  ADDED_ASC: "added_asc",
  TITLE_ASC: "title_asc",
  TITLE_DESC: "title_desc"
};

export const LibraryListPrivacy = {
  PRIVATE: "private",
  LINK: "link",
  FRIENDS: "friends",
  PUBLIC: "public"
};

export const LibraryListType = {
  WATCHLIST: "watchlist",
  PERSONAL: "personal"
};

const REMOTE_STORE_KEY = "libraryTraktState";
const WATCHLIST_KEY = "watchlist";
const PERSONAL_KEY_PREFIX = "personal:";
const REMOTE_LIST_LIMIT = 24;
const META_TIMEOUT_MS = 2200;
const META_BATCH_SIZE = 6;
const VALID_POSTER_SHAPES = new Set(["POSTER", "LANDSCAPE", "SQUARE"]);

// Cache for library metadata enrichment with 5-minute TTL
const enrichedLibraryMetaCache = new Map();
const ENRICHED_LIBRARY_META_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * @typedef {'local'|'trakt'} LibrarySourceModeValue
 */

/**
 * @typedef {'default'|'added_desc'|'added_asc'|'title_asc'|'title_desc'} LibrarySortOptionValue
 */

/**
 * @typedef {{ key: string, label: string }} LibraryTypeTab
 */

/**
 * @typedef {{ key: string, title: string, type: string, traktListId?: string|null, slug?: string|null, description?: string|null, privacy?: string|null, sortBy?: string|null, sortHow?: string|null }} LibraryListTab
 */

/**
 * @typedef {{ listedAt: number, traktRank: number|null }} LibraryEntryListMeta
 */

/**
 * @typedef {{ id: string, type: string, name: string, poster: string|null, background: string|null, description: string, releaseInfo: string, imdbRating: number|null, genres: string[], addonBaseUrl: string|null, listKeys: string[], listedAt: number, traktRank: number|null, listMeta: Record<string, LibraryEntryListMeta> }} LibraryEntry
 */

/**
 * @typedef {{ listMembership: Record<string, boolean> }} ListMembershipSnapshot
 */

/**
 * @typedef {{ desiredMembership: Record<string, boolean> }} ListMembershipChanges
 */

function isMissingResourceError(error) {
  if (!error) {
    return false;
  }
  if (error.status === 404) {
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

function withTimeout(promise, ms, fallbackValue) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallbackValue), ms);
    })
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

async function resolveProfileId() {
  const activeId = String(ProfileManager.getActiveProfileId() || "1");
  const direct = Number(activeId);
  if (Number.isFinite(direct) && direct > 0) {
    return Math.trunc(direct);
  }

  const profiles = await ProfileManager.getProfiles();
  const activeProfile = profiles.find(
    (profile) => String(profile.id || profile.profileIndex || "1") === activeId
  );
  const candidate = Number(activeProfile?.profileIndex || activeProfile?.id || 1);
  return Number.isFinite(candidate) && candidate > 0 ? Math.trunc(candidate) : 1;
}

async function resolveRemoteStoreKey() {
  const profileId = await resolveProfileId();
  let ownerId = "guest";
  if (AuthManager.isAuthenticated) {
    try {
      ownerId = String(await AuthManager.getEffectiveUserId());
    } catch (error) {
      ownerId = "guest";
    }
  }
  return `${REMOTE_STORE_KEY}:${ownerId}:${profileId}`;
}

const WATCHLIST_STALE_MS = 2 * 60 * 1000;

function createEmptyRemoteState() {
  return {
    nextListId: 1,
    watchlist: [],
    lists: [],
    listItems: {},
    lastRefreshedAt: 0
  };
}

function cloneState(state) {
  return {
    nextListId: Number(state?.nextListId || 1),
    watchlist: Array.isArray(state?.watchlist)
      ? state.watchlist.map((entry) => ({ ...entry }))
      : [],
    lists: Array.isArray(state?.lists) ? state.lists.map((entry) => ({ ...entry })) : [],
    listItems: Object.fromEntries(
      Object.entries(state?.listItems || {}).map(([key, value]) => [
        key,
        Array.isArray(value) ? value.map((item) => ({ ...item })) : []
      ])
    ),
    lastRefreshedAt: Number(state?.lastRefreshedAt || 0)
  };
}

async function readRemoteState() {
  const key = await resolveRemoteStoreKey();
  const stored = LocalStore.get(key, null);
  return cloneState(stored || createEmptyRemoteState());
}

async function writeRemoteState(state) {
  const key = await resolveRemoteStoreKey();
  LocalStore.set(key, cloneState(state));
}

function makeTypeLabel(type) {
  const key = String(type || "")
    .trim()
    .toLowerCase();
  if (!key) {
    return "Unknown";
  }
  if (key === "movie") {
    return "Movie";
  }
  if (key === "series") {
    return "Series";
  }
  return key
    .replace(/[_-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

function normalizeSavedItem(item = {}) {
  return {
    contentId: String(item.contentId || item.itemId || item.id || ""),
    contentType: String(item.contentType || item.itemType || item.type || "movie"),
    title: String(item.title || item.name || item.contentId || item.itemId || "Untitled"),
    poster: item.poster || null,
    posterShape: normalizePosterShape(item.posterShape || item.poster_shape),
    background: item.background || null,
    description: item.description || "",
    releaseInfo: item.releaseInfo || "",
    imdbRating: item.imdbRating == null ? null : Number(item.imdbRating),
    genres: Array.isArray(item.genres) ? item.genres : [],
    addonBaseUrl: item.addonBaseUrl || null,
    updatedAt: Number(item.updatedAt || item.listedAt || Date.now())
  };
}

function normalizePosterShape(value) {
  const shape = String(value || "").trim().toUpperCase();
  return VALID_POSTER_SHAPES.has(shape) ? shape : "POSTER";
}

function toSavedItemFromTraktWatchlist(entry) {
  if (!entry) return null;
  const tmdbId = entry.tmdbId;
  const itemId = tmdbId
    ? `tmdb:${tmdbId}`
    : entry.traktId
      ? `trakt:${entry.traktId}`
      : entry.imdbId
        ? `imdb:${entry.imdbId}`
        : null;
  if (!itemId) return null;
  const listedAtMs = entry.addedAt ? new Date(entry.addedAt).getTime() : Date.now();
  return {
    itemType: entry.type === "show" ? "series" : entry.type || "movie",
    itemId,
    imdbId: entry.imdbId || null,
    title: entry.title || "",
    year: entry.year || null,
    posterUrl: "",
    updatedAt: listedAtMs,
    listedAt: listedAtMs
  };
}

function getLibraryItemContentType(item) {
  return String(item.contentType || item.itemType || item.type || "movie");
}

function getLibraryItemContentId(item) {
  return String(item.contentId || item.itemId || item.id || "");
}

function extractImdbId(rawId) {
  const candidate = String(rawId || "").trim().split(":")[0];
  return /^tt\d+$/i.test(candidate) ? candidate : null;
}

async function syncWatchlistToTrakt(item, isAdding) {
  const imdbId = extractImdbId(getLibraryItemContentId(item));
  if (!imdbId) {
    return;
  }
  const traktItem = {
    type: getLibraryItemContentType(item),
    imdbId,
    title: item.title || item.name || ""
  };
  try {
    if (isAdding) {
      await TraktAuthService.addToWatchlist(traktItem);
    } else {
      await TraktAuthService.removeFromWatchlist(traktItem);
    }
  } catch (error) {
    console.warn("LibraryRepository watchlist trakt sync failed", error);
  }
}

// Trakt-backed home rows: fetched straight from Trakt rather than through the
// library's remote state, so they work regardless of which source the Library
// screen is set to and never write into that state machine.
const TRAKT_ROW_WATCHLIST = "watchlist";
const TRAKT_ROW_RECOMMENDATIONS = "recommendations";
const WATCHLIST_ROW_LIMIT = 500;
const RECOMMENDATIONS_ROW_PER_TYPE = 20;
// Artwork costs one meta lookup per item, so only the head of a row is hydrated
// before it goes up. The tail is virtualized off-screen anyway and fills in from
// a background pass.
const TRAKT_ROW_EAGER_HYDRATE = 24;
const TRAKT_ROW_CACHE_TTL_MS = 5 * 60 * 1000;
const traktRowCaches = new Map();
const traktRowCacheTokens = new Map();

function readTraktRowCache(rowId, profileId) {
  const cached = traktRowCaches.get(rowId);
  return cached && cached.profileId === profileId ? cached : null;
}

function invalidateTraktRowCaches(rowIds = [TRAKT_ROW_WATCHLIST, TRAKT_ROW_RECOMMENDATIONS]) {
  rowIds.forEach((rowId) => {
    traktRowCaches.delete(rowId);
    // Bumping the token also disowns any background artwork pass still running
    // for this row, so it cannot write its stale result back over a newer fetch.
    traktRowCacheTokens.set(rowId, (traktRowCacheTokens.get(rowId) || 0) + 1);
  });
}

function interleaveTraktEntries(left = [], right = []) {
  const merged = [];
  const longest = Math.max(left.length, right.length);
  for (let index = 0; index < longest; index += 1) {
    if (left[index]) {
      merged.push(left[index]);
    }
    if (right[index]) {
      merged.push(right[index]);
    }
  }
  return merged;
}

/**
 * Shared pipeline behind the Trakt home rows: cache check, then hydrate the head
 * of the list before resolving and the tail in the background.
 * @param {{rowId: string, limit: number, force?: boolean, onHydrated?: ((items: any[]) => void)|null, fetchEntries: () => Promise<any[]|null>}} options
 */
async function buildTraktRowItems({ rowId, limit, force = false, onHydrated = null, fetchEntries }) {
  const profileId = String(ProfileManager.getActiveProfileId() || "1");
  const cached = readTraktRowCache(rowId, profileId);
  if (!force && cached && Date.now() - cached.fetchedAt < TRAKT_ROW_CACHE_TTL_MS) {
    return cached.items.slice(0, limit);
  }

  const token = await TraktAuthService.getValidAccessToken().catch(() => null);
  if (!token) {
    invalidateTraktRowCaches([rowId]);
    return [];
  }

  const entries = await fetchEntries().catch((error) => {
    console.warn(`[LIB] Trakt ${rowId} row fetch failed`, error);
    return null;
  });
  if (!Array.isArray(entries)) {
    // A transient failure keeps the last good items rather than blanking a row
    // the user is looking at.
    return cached ? cached.items.slice(0, limit) : [];
  }

  const requestToken = (traktRowCacheTokens.get(rowId) || 0) + 1;
  traktRowCacheTokens.set(rowId, requestToken);
  const writeCache = (items) => {
    if (traktRowCacheTokens.get(rowId) !== requestToken) {
      return false;
    }
    traktRowCaches.set(rowId, { profileId, fetchedAt: Date.now(), items });
    return true;
  };

  const capped = entries.slice(0, limit);
  if (!capped.length) {
    writeCache([]);
    return [];
  }

  const head = await hydrateEntries(capped.slice(0, TRAKT_ROW_EAGER_HYDRATE));
  const tail = capped.slice(TRAKT_ROW_EAGER_HYDRATE);
  writeCache([...head, ...tail]);

  if (tail.length) {
    hydrateEntries(tail)
      .then((hydratedTail) => {
        const full = [...head, ...hydratedTail];
        if (writeCache(full) && typeof onHydrated === "function") {
          onHydrated(full);
        }
      })
      .catch((error) => {
        console.warn(`[LIB] Trakt ${rowId} row artwork pass failed`, error);
      });
  }

  return [...head, ...tail];
}

function toTraktRowEntry(entry) {
  if (!entry) {
    return null;
  }
  // IMDb id first: it is what Stremio meta addons index on, so it is the only id
  // form that both the artwork lookup below and the detail screen can resolve.
  const id =
    entry.imdbId ||
    (entry.tmdbId ? `tmdb:${entry.tmdbId}` : null) ||
    (entry.traktId ? `trakt:${entry.traktId}` : null);
  if (!id) {
    return null;
  }
  const listedAt = entry.addedAt ? new Date(entry.addedAt).getTime() : Date.now();
  return {
    id: String(id),
    type: entry.type === "show" ? "series" : String(entry.type || "movie"),
    name: String(entry.title || ""),
    poster: null,
    background: null,
    description: "",
    releaseInfo: entry.year ? String(entry.year) : "",
    genres: [],
    listKeys: [WATCHLIST_KEY],
    listedAt: Number.isFinite(listedAt) ? listedAt : Date.now(),
    listMeta: {}
  };
}

async function batchEnrichLibraryItems(items) {
  if (!items.length) return items;
  const now = Date.now();
  const results = [];
  for (const item of items) {
    const contentType = getLibraryItemContentType(item);
    const rawContentId = getLibraryItemContentId(item);
    if (!rawContentId) {
      results.push(item);
      continue;
    }
    const lookupId = item.imdbId || rawContentId;
    const cacheKey = `${contentType}:${lookupId}`;
    const cached = enrichedLibraryMetaCache.get(cacheKey);
    let meta = null;
    if (cached && now - cached.timestamp < ENRICHED_LIBRARY_META_CACHE_TTL_MS) {
      meta = cached.meta;
    } else {
      const canonicalType = contentType === "show" ? "series" : contentType;
      meta = await metaRepository.getMetaFromAllAddons(canonicalType, lookupId).catch(() => null);
      enrichedLibraryMetaCache.set(cacheKey, { meta, timestamp: now });
    }
    results.push(meta ? { ...item, enrichedMeta: meta } : item);
  }
  return results;
}

function toRemoteListItem(item = {}, extra = {}) {
  const normalized = normalizeSavedItem(item);
  return {
    ...normalized,
    listedAt: Number(extra.listedAt || normalized.updatedAt || Date.now()),
    traktRank: extra.traktRank == null ? null : Number(extra.traktRank)
  };
}

function mergeItemIntoMap(target, listKey, baseItem, listedAt, traktRank) {
  const key = `${baseItem.contentType}:${baseItem.contentId}`;
  const existing = target.get(key);
  const nextListMeta = {
    ...(existing?.listMeta || {}),
    [listKey]: {
      listedAt: Number(listedAt || Date.now()),
      traktRank: traktRank == null ? null : Number(traktRank)
    }
  };
  const nextListKeys = Array.from(new Set([...(existing?.listKeys || []), listKey]));
  target.set(key, {
    id: baseItem.contentId,
    type: baseItem.contentType,
    name: baseItem.title || existing?.name || baseItem.contentId,
    poster: baseItem.poster || existing?.poster || null,
    background: baseItem.background || existing?.background || null,
    description: baseItem.description || existing?.description || "",
    releaseInfo: baseItem.releaseInfo || existing?.releaseInfo || "",
    imdbRating:
      baseItem.imdbRating == null ? (existing?.imdbRating ?? null) : Number(baseItem.imdbRating),
    genres:
      Array.isArray(baseItem.genres) && baseItem.genres.length
        ? baseItem.genres
        : existing?.genres || [],
    addonBaseUrl: baseItem.addonBaseUrl || existing?.addonBaseUrl || null,
    listKeys: nextListKeys,
    listedAt: Number(listedAt || existing?.listedAt || Date.now()),
    traktRank: traktRank == null ? (existing?.traktRank ?? null) : Number(traktRank),
    listMeta: nextListMeta
  });
}

async function hydrateEntries(entries) {
  const nextEntries = entries.map((entry) => ({
    ...entry,
    listKeys: [...entry.listKeys],
    listMeta: { ...(entry.listMeta || {}) }
  }));

  for (let index = 0; index < nextEntries.length; index += META_BATCH_SIZE) {
    const batch = nextEntries.slice(index, index + META_BATCH_SIZE);
    await Promise.all(
      batch.map(async (entry) => {
        if (entry.poster && entry.name && entry.description) {
          return;
        }
        const result = await withTimeout(
          metaRepository.getMetaFromAllAddons(entry.type, entry.id),
          META_TIMEOUT_MS,
          { status: "error", message: "timeout" }
        );
        if (result?.status !== "success" || !result?.data) {
          return;
        }
        const meta = result.data;
        entry.name = entry.name || meta.name || entry.id;
        entry.poster = entry.poster || meta.poster || meta.background || null;
        entry.background = entry.background || meta.background || null;
        entry.description = entry.description || meta.description || "";
        entry.releaseInfo = entry.releaseInfo || meta.releaseInfo || "";
        entry.genres = entry.genres?.length
          ? entry.genres
          : Array.isArray(meta.genres)
            ? meta.genres
            : [];
      })
    );
  }

  return nextEntries;
}

function buildPersonalListTab(list = {}) {
  return {
    key: String(list.key || ""),
    title: String(list.title || "Untitled"),
    type: LibraryListType.PERSONAL,
    traktListId: String(list.traktListId || list.key || "").replace(PERSONAL_KEY_PREFIX, ""),
    slug: list.slug || null,
    description: list.description || null,
    privacy: list.privacy || LibraryListPrivacy.PRIVATE,
    sortBy: list.sortBy || null,
    sortHow: list.sortHow || null
  };
}

async function getRemotePersonalTabs() {
  const state = await readRemoteState();
  return state.lists.map((entry) => buildPersonalListTab(entry)).slice(0, REMOTE_LIST_LIMIT);
}

async function getLocalEntries() {
  const savedItems = await savedLibraryRepository.getAll(1000);
  const entriesMap = new Map();
  savedItems.forEach((item) => {
    const normalized = normalizeSavedItem(item);
    mergeItemIntoMap(entriesMap, "local", normalized, normalized.updatedAt, null);
  });
  return hydrateEntries(Array.from(entriesMap.values()));
}

async function getRemoteEntries() {
  const personalState = await readRemoteState();
  const entriesMap = new Map();

  personalState.watchlist.forEach((item, index) => {
    const normalized = normalizeSavedItem(item);
    mergeItemIntoMap(entriesMap, WATCHLIST_KEY, normalized, normalized.updatedAt, index);
  });

  personalState.lists.forEach((list) => {
    const listKey = String(list.key || "");
    const items = Array.isArray(personalState.listItems?.[listKey])
      ? personalState.listItems[listKey]
      : [];
    items.forEach((item, index) => {
      const normalized = normalizeSavedItem(item);
      mergeItemIntoMap(
        entriesMap,
        listKey,
        normalized,
        Number(item.listedAt || normalized.updatedAt || Date.now()),
        index
      );
    });
  });

  return hydrateEntries(Array.from(entriesMap.values()));
}

function membershipMapFromEntries(entries, listTabs) {
  const allKeys = listTabs.map((tab) => tab.key);
  return (item) => {
    const itemKey = `${item.itemType || item.type || "movie"}:${item.itemId || item.id || ""}`;
    const found = entries.find((entry) => `${entry.type}:${entry.id}` === itemKey);
    return {
      listMembership: Object.fromEntries(
        allKeys.map((key) => [key, Boolean(found?.listKeys?.includes(key))])
      )
    };
  };
}

function upsertPersonalItem(state, listKey, item) {
  const nextState = cloneState(state);
  const list = Array.isArray(nextState.listItems[listKey]) ? nextState.listItems[listKey] : [];
  const normalized = toRemoteListItem(item, { listedAt: Date.now() });
  nextState.listItems[listKey] = [
    normalized,
    ...list.filter(
      (entry) =>
        !(
          String(entry.contentId) === normalized.contentId &&
          String(entry.contentType) === normalized.contentType
        )
    )
  ];
  return nextState;
}

function removePersonalItem(state, listKey, item) {
  const nextState = cloneState(state);
  const current = Array.isArray(nextState.listItems[listKey]) ? nextState.listItems[listKey] : [];
  nextState.listItems[listKey] = current.filter((entry) => {
    return !(
      String(entry.contentId) === String(item.itemId || item.id || "") &&
      String(entry.contentType || "movie") === String(item.itemType || item.type || "movie")
    );
  });
  return nextState;
}

class LibraryRepository {
  async getSourceMode() {
    const selectedMode = TraktSettingsStore.get().librarySourceMode;
    if (selectedMode !== TraktLibrarySourceMode.TRAKT) {
      return LibrarySourceMode.LOCAL;
    }
    const traktToken = await TraktAuthService.getValidAccessToken().catch(() => null);
    if (!traktToken) {
      return LibrarySourceMode.LOCAL;
    }
    return LibrarySourceMode.TRAKT;
  }

  async getListTabs() {
    const sourceMode = await this.getSourceMode();
    if (sourceMode === LibrarySourceMode.LOCAL) {
      return [];
    }
    const personalTabs = await getRemotePersonalTabs();
    return [
      {
        key: WATCHLIST_KEY,
        title: "Watchlist",
        type: LibraryListType.WATCHLIST,
        traktListId: null,
        slug: null,
        description: null,
        privacy: null,
        sortBy: null,
        sortHow: null
      },
      ...personalTabs
    ];
  }

  async getItems() {
    const sourceMode = await this.getSourceMode();
    return sourceMode === LibrarySourceMode.TRAKT ? getRemoteEntries() : getLocalEntries();
  }

  // Adding or removing a watchlist item also changes what Trakt recommends
  // (both rows are fetched with ignore_watchlisted), so both caches go.
  invalidateWatchlistRowCache() {
    invalidateTraktRowCaches();
  }

  /**
   * Catalog-row-shaped view of the full Trakt watchlist for the home screen.
   * Returns [] when Trakt is not connected, which drops the row from home.
   * Resolves once the head of the list has artwork; `onHydrated` is called later
   * with the same list once the tail has it too.
   */
  getWatchlistRowItems({ limit = WATCHLIST_ROW_LIMIT, force = false, onHydrated = null } = {}) {
    return buildTraktRowItems({
      rowId: TRAKT_ROW_WATCHLIST,
      limit,
      force,
      onHydrated,
      fetchEntries: async () => {
        const fetched = await TraktAuthService.fetchWatchlist({ limit });
        if (!Array.isArray(fetched)) {
          return null;
        }
        // Trakt serves the watchlist in rank order; the row reads best newest-first.
        return fetched
          .map(toTraktRowEntry)
          .filter(Boolean)
          .sort((left, right) => right.listedAt - left.listedAt);
      }
    });
  }

  /**
   * Catalog-row-shaped view of Trakt's personalized recommendations, movies and
   * shows interleaved so the row is not all one type. Same contract as
   * getWatchlistRowItems.
   */
  getRecommendationsRowItems({
    limit = RECOMMENDATIONS_ROW_PER_TYPE * 2,
    force = false,
    onHydrated = null
  } = {}) {
    return buildTraktRowItems({
      rowId: TRAKT_ROW_RECOMMENDATIONS,
      limit,
      force,
      onHydrated,
      fetchEntries: async () => {
        const [movies, shows] = await Promise.all([
          TraktAuthService.fetchRecommendations({
            type: "movies",
            limit: RECOMMENDATIONS_ROW_PER_TYPE
          }),
          TraktAuthService.fetchRecommendations({
            type: "shows",
            limit: RECOMMENDATIONS_ROW_PER_TYPE
          })
        ]);
        // Trakt ranks each type on its own, so keep both rankings by taking them
        // in turn rather than concatenating one type after the other.
        return interleaveTraktEntries(
          (movies || []).map(toTraktRowEntry).filter(Boolean),
          (shows || []).map(toTraktRowEntry).filter(Boolean)
        );
      }
    });
  }

  async getMembershipSnapshot(item) {
    const sourceMode = await this.getSourceMode();
    if (sourceMode === LibrarySourceMode.LOCAL) {
      const exists = await savedLibraryRepository.isSaved(item.itemId || item.id || "");
      return { listMembership: { local: exists } };
    }
    const [entries, listTabs] = await Promise.all([this.getItems(), this.getListTabs()]);
    return membershipMapFromEntries(entries, listTabs)(item);
  }

  async applyMembershipChanges(item, changes) {
    const sourceMode = await this.getSourceMode();
    if (sourceMode === LibrarySourceMode.LOCAL) {
      const shouldSave = Object.values(changes?.desiredMembership || {}).some(Boolean);
      if (shouldSave) {
        await savedLibraryRepository.save(normalizeSavedItem(item));
      } else {
        await savedLibraryRepository.remove(item.itemId || item.id || "");
      }
      return;
    }

    const desiredMembership = changes?.desiredMembership || {};
    const currentSnapshot = await this.getMembershipSnapshot(item);
    let remoteState = await readRemoteState();

    for (const [listKey, desired] of Object.entries(desiredMembership)) {
      const before = currentSnapshot.listMembership?.[listKey] === true;
      const after = desired === true;
      if (before === after) {
        continue;
      }
      if (listKey === WATCHLIST_KEY) {
        await syncWatchlistToTrakt(item, after);
        this.invalidateWatchlistRowCache();
        remoteState.watchlist = after
          ? [
              toRemoteListItem(item, { listedAt: Date.now() }),
              ...(remoteState.watchlist || []).filter(
                (entry) =>
                  !(
                    String(entry.contentId) === String(item.itemId || item.id || "") &&
                    String(entry.contentType || "movie") ===
                      String(item.itemType || item.type || "movie")
                  )
              )
            ]
          : (remoteState.watchlist || []).filter(
              (entry) =>
                !(
                  String(entry.contentId) === String(item.itemId || item.id || "") &&
                  String(entry.contentType || "movie") ===
                    String(item.itemType || item.type || "movie")
                )
            );
        continue;
      }
      remoteState = after
        ? upsertPersonalItem(remoteState, listKey, item)
        : removePersonalItem(remoteState, listKey, item);
    }

    await writeRemoteState(remoteState);

    if (AuthManager.isAuthenticated) {
      try {
        await SavedLibrarySyncService.push();
      } catch (error) {
        console.warn("LibraryRepository applyMembershipChanges push failed", error);
      }
    }
  }

  async createPersonalList(name, description, privacy) {
    const state = await readRemoteState();
    const nextId = Number(state.nextListId || 1);
    const listKey = `${PERSONAL_KEY_PREFIX}${nextId}`;
    state.nextListId = nextId + 1;
    state.lists = [
      ...state.lists,
      {
        key: listKey,
        title: String(name || "Untitled"),
        description: description || null,
        privacy: privacy || LibraryListPrivacy.PRIVATE,
        traktListId: String(nextId)
      }
    ];
    state.listItems[listKey] = state.listItems[listKey] || [];
    await writeRemoteState(state);
    return listKey;
  }

  async updatePersonalList(listId, name, description, privacy) {
    const state = await readRemoteState();
    state.lists = state.lists.map((list) => {
      if (
        String(list.traktListId || list.key).replace(PERSONAL_KEY_PREFIX, "") !== String(listId)
      ) {
        return list;
      }
      return {
        ...list,
        title: String(name || list.title || "Untitled"),
        description: description || null,
        privacy: privacy || list.privacy || LibraryListPrivacy.PRIVATE
      };
    });
    await writeRemoteState(state);
  }

  async deletePersonalList(listId) {
    const state = await readRemoteState();
    const match = state.lists.find((list) => {
      return (
        String(list.traktListId || list.key).replace(PERSONAL_KEY_PREFIX, "") === String(listId)
      );
    });
    if (!match) {
      return;
    }
    state.lists = state.lists.filter((list) => list.key !== match.key);
    delete state.listItems[match.key];
    await writeRemoteState(state);
  }

  async reorderPersonalLists(orderedListIds = []) {
    const state = await readRemoteState();
    const byId = new Map(
      state.lists.map((list) => [
        String(list.traktListId || list.key).replace(PERSONAL_KEY_PREFIX, ""),
        list
      ])
    );
    const reordered = orderedListIds
      .map((id) => byId.get(String(id).replace(PERSONAL_KEY_PREFIX, "")))
      .filter(Boolean);
    const untouched = state.lists.filter(
      (list) => !reordered.some((entry) => entry.key === list.key)
    );
    state.lists = [...reordered, ...untouched];
    await writeRemoteState(state);
  }

  async refreshNow() {
    const sourceMode = await this.getSourceMode();
    if (sourceMode === LibrarySourceMode.TRAKT) {
      if (!TraktAuthService.isAuthenticated()) return false;
      try {
        const watchlistItems = await TraktAuthService.fetchWatchlist({
          limit: 200
        });
        const rawItems = watchlistItems.map(toSavedItemFromTraktWatchlist).filter(Boolean);
        const enrichedItems = await batchEnrichLibraryItems(rawItems);
        const state = await readRemoteState();
        state.watchlist = enrichedItems;
        state.lastRefreshedAt = Date.now();
        await writeRemoteState(state);
        return true;
      } catch (error) {
        console.warn("[LIB] Trakt watchlist fetch failed", error);
        return false;
      }
    }
    if (!AuthManager.isAuthenticated) {
      return false;
    }
    try {
      await SavedLibrarySyncService.pull();
      return true;
    } catch (error) {
      if (!isMissingResourceError(error)) {
        console.warn("LibraryRepository refreshNow failed", error);
      }
      return false;
    }
  }

  async ensureFresh() {
    const sourceMode = await this.getSourceMode();
    if (sourceMode !== LibrarySourceMode.TRAKT) {
      return false;
    }
    const state = await readRemoteState();
    if (Date.now() - Number(state.lastRefreshedAt || 0) < WATCHLIST_STALE_MS) {
      return false;
    }
    return this.refreshNow();
  }
}

export const libraryRepository = new LibraryRepository();
export const libraryTypeLabel = makeTypeLabel;
