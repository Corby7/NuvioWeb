import { Router } from "../../navigation/router.js";
import { ScreenUtils } from "../../navigation/screen.js";
import { Environment } from "../../../platform/environment.js";
import { addonRepository } from "../../../data/repository/addonRepository.js";
import { catalogRepository } from "../../../data/repository/catalogRepository.js";
import { watchedItemsRepository } from "../../../data/repository/watchedItemsRepository.js";
import { CollectionsStore } from "../../../data/local/collectionsStore.js";
import { LayoutPreferences } from "../../../data/local/layoutPreferences.js";
import { TmdbService } from "../../../core/tmdb/tmdbService.js";
import { TmdbSettingsStore } from "../../../data/local/tmdbSettingsStore.js";
import { TmdbMetadataService } from "../../../core/tmdb/tmdbMetadataService.js";
import { TMDB_API_KEY, TRAKT_API_URL, TRAKT_CLIENT_ID } from "../../../config.js";
import { toTraktImageUrl } from "../../../core/trakt/traktImageUrl.js";
import {
  HomeScreen,
  buildModernHomeSizingStyle,
  buildModernHeroPresentation,
  createPosterCardMarkup,
  createSeeAllCardMarkup,
  escapeAttribute,
  escapeHtml,
  formatCatalogRowTitle,
  normalizeCollectionFolderItem,
  preloadImageSource,
  renderContinueWatchingSection
} from "../home/homeScreen.js";
import { renderModernHomeLayout } from "../home/modernHomeLayout.js";
import { optimizePosterUrl } from "../home/posterLoader.js";
import {
  buildWatchedTitleIdSet,
  isTitleItemWatched,
  renderTitleWatchedBadge
} from "../../components/watchedTitleBadge.js";

const TMDB_API_URL = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE_URL_BACKDROP = "https://image.tmdb.org/t/p/w1280";
const TMDB_IMAGE_BASE_URL_POSTER = "https://image.tmdb.org/t/p/w500";
const TMDB_PAGE_SIZE = 20;
const TRAKT_PAGE_SIZE = 50;
const STREAMING_NETWORK_PRESETS = new Map([
  ["netflix", { title: "Netflix", tmdbId: 213 }],
  ["hbo", { title: "HBO", tmdbId: 49 }],
  ["max", { title: "HBO", tmdbId: 49 }],
  ["disney", { title: "Disney+", tmdbId: 2739 }],
  ["disney+", { title: "Disney+", tmdbId: 2739 }],
  ["prime video", { title: "Prime Video", tmdbId: 1024 }],
  ["amazon prime video", { title: "Prime Video", tmdbId: 1024 }],
  ["hulu", { title: "Hulu", tmdbId: 453 }],
  ["apple tv", { title: "Apple TV+", tmdbId: 2552 }],
  ["apple tv+", { title: "Apple TV+", tmdbId: 2552 }],
  ["paramount+", { title: "Paramount+", tmdbId: 4330 }],
  ["paramount plus", { title: "Paramount+", tmdbId: 4330 }],
  ["starz", { title: "Starz", tmdbId: 318 }]
]);

function isBackEvent(event) {
  return Environment.isBackEvent(event);
}

function escapeFolderHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function toImageUrl(path, baseUrl = TMDB_IMAGE_BASE_URL_BACKDROP) {
  if (!path) {
    return "";
  }
  return /^https?:\/\//i.test(String(path)) ? String(path) : `${baseUrl}${path}`;
}

function buildPlaceholderPosterDataUrl() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="750" viewBox="0 0 500 750"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1f2430" stop-opacity="0.92"/><stop offset="1" stop-color="#1f2430" stop-opacity="0.98"/></linearGradient></defs><rect width="500" height="750" fill="url(#g)"/><circle cx="250" cy="375" r="46" fill="none" stroke="#9ca3af" stroke-opacity="0.28" stroke-width="4"/><circle cx="250" cy="375" r="42" fill="#ffffff" fill-opacity="0.92" stroke="#9ca3af" stroke-opacity="0.18" stroke-width="3"/><path d="M240 352 L240 398 L278 375 Z" fill="#1f2430" fill-opacity="0.8"/></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function normalizeItem(item = {}, fallbackType = "movie") {
  const source = item && typeof item === "object" ? item : {};
  const type = String(source.type || source.apiType || fallbackType).toLowerCase() === "tv" ? "series" : String(source.type || source.apiType || fallbackType || "movie").toLowerCase();
  const runtimeValue = source.runtimeMinutes ?? source.runtime ?? source.durationMinutes ?? source.duration_minutes ?? 0;
  return {
    ...source,
    id: String(source.id || "").trim(),
    type,
    apiType: type,
    name: firstNonEmpty(source.name, source.title, source.id),
    poster: firstNonEmpty(source.poster, source.thumbnail, source.background, source.backdrop, source.backdropUrl, source.landscapePoster),
    landscapePoster: firstNonEmpty(source.landscapePoster, source.backdrop, source.backdropUrl, source.background),
    backdrop: firstNonEmpty(source.backdrop, source.backdropUrl, source.background, source.landscapePoster),
    background: firstNonEmpty(source.background, source.backdrop, source.backdropUrl, source.landscapePoster, source.poster),
    releaseInfo: firstNonEmpty(source.releaseInfo, source.released, source.releaseDate, source.release_date, source.year),
    released: firstNonEmpty(source.released, source.releaseDate, source.release_date),
    releaseDate: firstNonEmpty(source.releaseDate, source.release_date, source.released),
    logo: firstNonEmpty(source.logo),
    description: firstNonEmpty(source.description, source.overview, source.plot),
    genres: Array.isArray(source.genres) ? source.genres.filter(Boolean) : [],
    runtimeMinutes: Number(runtimeValue) || runtimeValue || 0,
    imdbRating: source.imdbRating ?? source.imdb_rating ?? source.rating ?? null,
    rating: source.rating ?? source.imdbRating ?? source.imdb_rating ?? null,
    ageRating: firstNonEmpty(source.ageRating, source.age_rating),
    status: firstNonEmpty(source.status),
    language: firstNonEmpty(source.language),
    country: firstNonEmpty(source.country),
    tmdbId: firstNonEmpty(source.tmdbId, String(source.id || "").replace(/^tmdb:/i, ""))
  };
}

function buildHeroDisplay(item = null) {
  const normalized = normalizeItem(item || null);
  if (!normalized?.id) {
    return null;
  }
  const typeLabel = normalized.type === "series" ? "Series" : "Movie";
  const year = firstNonEmpty(normalized.releaseInfo);
  return {
    title: normalized.name || "Untitled",
    description: firstNonEmpty(normalized.description) || " ",
    logo: firstNonEmpty(normalized.logo),
    backdrop: firstNonEmpty(normalized.background, normalized.poster),
    meta: [typeLabel, year].filter(Boolean)
  };
}

function buildFolderHeroSeed(folder = null) {
  if (!folder) {
    return null;
  }
  return {
    id: `folder:${String(folder.id || "")}`,
    type: "series",
    name: firstNonEmpty(folder.title, "Collection"),
    poster: firstNonEmpty(folder.coverImageUrl),
    background: firstNonEmpty(folder.heroBackdropUrl, folder.coverImageUrl),
    logo: firstNonEmpty(folder.titleLogoUrl),
    description: "",
    releaseInfo: ""
  };
}

function sourceType(source = {}) {
  const mediaType = String(source.mediaType || "").toUpperCase();
  if (mediaType === "TV" || mediaType === "SERIES") {
    return "series";
  }
  const rawType = String(source.type || source.apiType || "movie").toLowerCase();
  return rawType === "tv" ? "series" : rawType;
}

function buildFolderSourceRows(tabs = []) {
  return tabs
    .filter((tab) => !tab.isAllTab)
    .map((tab, index) => {
      const sourceTabIndex = tabs.indexOf(tab);
      const type = sourceType(tab.source || {});
      return {
        homeCatalogKey: tab.key || `folder_source_${index}`,
        folderTabIndex: sourceTabIndex >= 0 ? sourceTabIndex : index,
        addonId: tab.source?.addonId || tab.source?.provider || "collection",
        addonBaseUrl: tab.source?.addonBaseUrl || "",
        addonName: tab.source?.addonName || tab.source?.provider || "Collection",
        catalogId: tab.source?.catalogId || tab.source?.tmdbId || tab.source?.traktListId || tab.key || `source_${index}`,
        catalogName: tab.label || tab.source?.catalogName || tab.source?.title || "Collection",
        type,
        result: {
          status: tab.loading ? "loading" : (tab.error ? "error" : "success"),
          data: {
            items: Array.isArray(tab.items) ? tab.items : []
          }
        },
        // A source that failed has no items, and the modern layout drops itemless rows —
        // which turned a folder whose addon is missing into a hero and nothing else, with
        // the reason ("Addon not found") never reaching the screen or the console. The
        // tabbed-grid path already prints tab.error; this carries it into follow layout.
        rowErrorMessage: !tab.loading && tab.error ? String(tab.error) : "",
        suppressPosterText: true
      };
    });
}

function normalizePresetKey(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function buildFallbackStreamingSources(folder = {}) {
  const key = normalizePresetKey(folder.title || folder.name || "");
  const preset = STREAMING_NETWORK_PRESETS.get(key);
  if (!preset?.tmdbId) {
    return [];
  }
  return [
    {
      provider: "tmdb",
      tmdbSourceType: "NETWORK",
      title: `${preset.title} Popular`,
      tmdbId: preset.tmdbId,
      mediaType: "TV",
      sortBy: "popularity.desc",
      filters: {}
    },
    {
      provider: "tmdb",
      tmdbSourceType: "NETWORK",
      title: `${preset.title} Recent`,
      tmdbId: preset.tmdbId,
      mediaType: "TV",
      sortBy: "first_air_date.desc",
      filters: {}
    }
  ];
}

function groupNodesByOffsetTop(nodes = []) {
  const grouped = [];
  nodes.forEach((node) => {
    const top = Math.round(node.offsetTop);
    const bucket = grouped.find((entry) => Math.abs(entry.top - top) <= 6);
    if (bucket) {
      bucket.nodes.push(node);
      return;
    }
    grouped.push({ top, nodes: [node] });
  });
  grouped.sort((left, right) => left.top - right.top);
  return grouped.map((entry) => entry.nodes);
}

function roundRobinMerge(lists = []) {
  const result = [];
  const seen = new Set();
  const maxSize = lists.reduce((max, list) => Math.max(max, Array.isArray(list) ? list.length : 0), 0);
  for (let index = 0; index < maxSize; index += 1) {
    lists.forEach((list) => {
      const item = list?.[index];
      const key = `${item?.type || item?.apiType || "movie"}:${item?.id || ""}`;
      if (!item?.id || seen.has(key)) {
        return;
      }
      seen.add(key);
      result.push(item);
    });
  }
  return result;
}

function buildAddonTabLabel(source = {}, addons = []) {
  const addon = findAddonForSource(source, addons);
  const catalog = addon?.catalogs?.find((entry) => String(entry?.id || "") === String(source.catalogId || "") && String(entry?.apiType || "") === String(source.type || "")) || null;
  const baseName = firstNonEmpty(catalog?.name, source.catalogName, source.title, source.catalogId || source.type || "Catalog");
  return source.genre ? `${baseName} · ${source.genre}` : baseName;
}

function sameAddonUrl(left = "", right = "") {
  const leftUrl = String(left || "").trim();
  const rightUrl = String(right || "").trim();
  if (!leftUrl || !rightUrl) {
    return false;
  }
  return addonRepository.canonicalizeUrl(leftUrl) === addonRepository.canonicalizeUrl(rightUrl);
}

function findAddonForSource(source = {}, addons = []) {
  return addons.find((entry) => String(entry?.id || "") === String(source.addonId || ""))
    || addons.find((entry) => sameAddonUrl(entry?.baseUrl, source.addonBaseUrl))
    || null;
}

// Addon-backed labels sharpen once the manifests arrive (catalog display name);
// without them this still yields the source's own catalog/title text, which is
// good enough to paint with.
function buildFolderTabLabel(source = {}, addons = []) {
  if (source.provider === "tmdb") {
    return buildTmdbTabLabel(source);
  }
  if (source.provider === "trakt") {
    return buildTraktTabLabel(source);
  }
  return buildAddonTabLabel(source, addons);
}

function buildTmdbTabLabel(source = {}) {
  return firstNonEmpty(source.title, source.tmdbSourceType || "TMDB");
}

function buildTraktTabLabel(source = {}) {
  return firstNonEmpty(source.title, `List ${source.traktListId || ""}`);
}

function stableSourceValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => stableSourceValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((accumulator, key) => {
        accumulator[key] = stableSourceValue(value[key]);
        return accumulator;
      }, {});
  }
  return value ?? null;
}

function buildFolderSourceKey(source = {}, index = 0) {
  const provider = String(source.provider || "addon").toLowerCase();
  const signature = {
    provider,
    index,
    addonId: source.addonId || "",
    catalogId: source.catalogId || "",
    type: source.type || source.apiType || "",
    genre: source.genre || "",
    tmdbSourceType: source.tmdbSourceType || "",
    tmdbId: source.tmdbId ?? "",
    mediaType: source.mediaType || "",
    title: source.title || "",
    sortBy: source.sortBy || "",
    filters: stableSourceValue(source.filters || {})
  };
  return `${provider}:${index}:${JSON.stringify(stableSourceValue(signature))}`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(String(payload?.message || payload?.error || response.statusText || "Request failed"));
  }
  return { response, payload };
}

async function fetchAddonSourceItems(source = {}, page = 1) {
  const addons = await addonRepository.getInstalledAddons();
  const addon = findAddonForSource(source, addons);
  const addonBaseUrl = firstNonEmpty(addon?.baseUrl, source.addonBaseUrl);
  if (!addonBaseUrl) {
    throw new Error("Addon not found");
  }
  const extraArgs = source.genre ? { genre: source.genre } : {};
  const result = await catalogRepository.getCatalog({
    addonBaseUrl,
    addonId: firstNonEmpty(addon?.id, source.addonId, addonBaseUrl),
    addonName: firstNonEmpty(addon?.displayName, addon?.name, source.addonName, "Addon"),
    catalogId: source.catalogId,
    catalogName: buildAddonTabLabel(source, addons),
    type: source.type,
    skip: Math.max(0, (page - 1) * 100),
    extraArgs,
    supportsSkip: true
  });
  if (result?.status !== "success") {
    throw new Error(String(result?.message || "Could not load catalog"));
  }
  return {
    items: (result.data?.items || []).map((item) => normalizeItem(item, source.type)).filter((item) => item.id),
    hasMore: Boolean(result.data?.hasMore),
    page
  };
}

function getTmdbApiKey() {
  const settings = TmdbSettingsStore.get();
  return settings.enabled ? String(TMDB_API_KEY || "").trim() : "";
}

function getTmdbLanguage() {
  return String(TmdbSettingsStore.get().language || "en-US").trim() || "en-US";
}

function setTmdbDiscoverParam(params, key, value) {
  if (value == null || value === "") {
    return;
  }
  params.set(key, String(value));
}

function applyTmdbDiscoverFilters(params, filters = {}, mediaType = "movie") {
  const isTv = String(mediaType || "").toLowerCase() === "tv";
  setTmdbDiscoverParam(params, "with_genres", filters.withGenres);
  setTmdbDiscoverParam(params, isTv ? "first_air_date.gte" : "primary_release_date.gte", filters.releaseDateGte);
  setTmdbDiscoverParam(params, isTv ? "first_air_date.lte" : "primary_release_date.lte", filters.releaseDateLte);
  setTmdbDiscoverParam(params, "vote_average.gte", filters.voteAverageGte);
  setTmdbDiscoverParam(params, "vote_average.lte", filters.voteAverageLte);
  setTmdbDiscoverParam(params, "vote_count.gte", filters.voteCountGte);
  setTmdbDiscoverParam(params, "with_original_language", filters.withOriginalLanguage);
  setTmdbDiscoverParam(params, "with_origin_country", filters.withOriginCountry);
  setTmdbDiscoverParam(params, "with_keywords", filters.withKeywords);
  setTmdbDiscoverParam(params, "with_companies", filters.withCompanies);
  if (isTv) {
    setTmdbDiscoverParam(params, "with_networks", filters.withNetworks);
  }
  if (Number.isFinite(Number(filters.year)) && Number(filters.year) > 0) {
    params.set(isTv ? "first_air_date_year" : "year", String(Math.trunc(Number(filters.year))));
  }
  if (filters.withWatchProviders) {
    setTmdbDiscoverParam(params, "watch_region", filters.watchRegion || "US");
    setTmdbDiscoverParam(params, "with_watch_providers", filters.withWatchProviders);
    setTmdbDiscoverParam(params, "with_watch_monetization_types", "flatrate|free|ads|rent|buy");
  }
}

function mapTmdbListItem(item = {}, mediaType = "movie") {
  const type = mediaType === "tv" ? "series" : "movie";
  const title = firstNonEmpty(item.title, item.name, item.original_title, item.original_name);
  if (!item?.id || !title) {
    return null;
  }
  const posterUrl = toImageUrl(item.poster_path || item.posterPath, TMDB_IMAGE_BASE_URL_POSTER);
  const backdropUrl = toImageUrl(item.backdrop_path || item.backdropPath, TMDB_IMAGE_BASE_URL_BACKDROP);
  return normalizeItem({
    id: `tmdb:${item.id}`,
    type,
    name: title,
    poster: firstNonEmpty(posterUrl, backdropUrl, buildPlaceholderPosterDataUrl()),
    landscapePoster: backdropUrl,
    background: backdropUrl,
    description: firstNonEmpty(item.overview, item.description),
    releaseInfo: String(item.release_date || item.first_air_date || "").slice(0, 4),
    released: item.release_date || item.first_air_date || "",
    releaseDate: item.release_date || item.first_air_date || "",
    rating: typeof item.vote_average === "number" ? item.vote_average : null,
    imdbRating: typeof item.vote_average === "number" ? item.vote_average : null,
    tmdbId: String(item.id)
  }, type);
}

function hasTmdbItemId(item = {}) {
  const rawId = firstNonEmpty(item.tmdbId, item.id);
  const normalized = rawId.replace(/^tmdb:/i, "").trim();
  return /^\d+$/.test(normalized) || /^tt\d+$/i.test(normalized);
}

function buildEnrichedTmdbItem(baseItem = {}, enriched = {}, settings = {}) {
  const useArtwork = settings.useArtwork !== false;
  const useBasicInfo = settings.useBasicInfo !== false;
  return normalizeItem({
    ...baseItem,
    name: useBasicInfo ? firstNonEmpty(enriched.localizedTitle, baseItem.name) : baseItem.name,
    description: useBasicInfo ? firstNonEmpty(enriched.description, baseItem.description) : baseItem.description,
    // Fill gaps only — the base item's own art (from the folder's catalog
    // listing) wins when present, so a later per-title TMDB fetch can't
    // swap in different-looking art moments after the hero first rendered.
    background: useArtwork ? firstNonEmpty(baseItem.background, enriched.backdrop) : baseItem.background,
    backdrop: useArtwork ? firstNonEmpty(baseItem.backdrop, enriched.backdrop) : baseItem.backdrop,
    landscapePoster: useArtwork ? firstNonEmpty(baseItem.landscapePoster, enriched.backdrop) : baseItem.landscapePoster,
    poster: useArtwork ? firstNonEmpty(baseItem.poster, enriched.poster) : baseItem.poster,
    logo: useArtwork ? firstNonEmpty(baseItem.logo, enriched.logo) : baseItem.logo,
    genres: useBasicInfo && Array.isArray(enriched.genres) && enriched.genres.length ? enriched.genres : baseItem.genres,
    releaseInfo: useBasicInfo ? firstNonEmpty(enriched.releaseInfo, baseItem.releaseInfo) : baseItem.releaseInfo,
    released: useBasicInfo ? firstNonEmpty(enriched.released, baseItem.released) : baseItem.released,
    releaseDate: useBasicInfo ? firstNonEmpty(enriched.released, baseItem.releaseDate) : baseItem.releaseDate,
    runtime: useBasicInfo ? firstNonEmpty(enriched.runtime, baseItem.runtime) : baseItem.runtime,
    rating: useBasicInfo ? (enriched.rating ?? baseItem.rating) : baseItem.rating,
    imdbRating: useBasicInfo ? (enriched.rating ?? baseItem.imdbRating) : baseItem.imdbRating,
    language: useBasicInfo ? firstNonEmpty(enriched.language, baseItem.language) : baseItem.language,
    country: useBasicInfo ? firstNonEmpty(enriched.country, baseItem.country) : baseItem.country
  }, baseItem.type || baseItem.apiType || "movie");
}

async function fetchTmdbSourceItems(source = {}, page = 1) {
  const apiKey = getTmdbApiKey();
  if (!apiKey) {
    throw new Error("TMDB is not configured");
  }
  const language = getTmdbLanguage();
  const type = String(source.tmdbSourceType || "").toUpperCase();
  const mediaType = type === "NETWORK" || String(source.mediaType || "MOVIE").toUpperCase() === "TV" ? "tv" : "movie";
  if (type === "COLLECTION") {
    const items = await TmdbMetadataService.fetchMovieCollection({
      collectionId: source.tmdbId,
      language
    });
    return {
      items: items.map((item) => normalizeItem(item, "movie")).filter((item) => item.id),
      hasMore: false,
      page: 1
    };
  }
  if (type === "LIST") {
    const url = `${TMDB_API_URL}/list/${encodeURIComponent(String(source.tmdbId || ""))}?api_key=${encodeURIComponent(apiKey)}&language=${encodeURIComponent(language)}&page=${encodeURIComponent(String(page))}`;
    const { payload } = await fetchJson(url);
    return {
      items: (Array.isArray(payload?.items) ? payload.items : []).map((item) => mapTmdbListItem(item, String(item?.media_type || mediaType))).filter(Boolean),
      hasMore: Number(payload?.page || page) < Number(payload?.total_pages || page),
      page: Number(payload?.page || page)
    };
  }
  if (type === "PERSON" || type === "DIRECTOR") {
    const url = `${TMDB_API_URL}/person/${encodeURIComponent(String(source.tmdbId || ""))}/combined_credits?api_key=${encodeURIComponent(apiKey)}&language=${encodeURIComponent(language)}`;
    const { payload } = await fetchJson(url);
    const sourceItems = type === "DIRECTOR"
      ? (Array.isArray(payload?.crew) ? payload.crew.filter((entry) => String(entry?.job || "").toLowerCase() === "director") : [])
      : (Array.isArray(payload?.cast) ? payload.cast : []);
    return {
      items: sourceItems.map((item) => mapTmdbListItem(item, String(item?.media_type || mediaType))).filter(Boolean),
      hasMore: false,
      page: 1
    };
  }
  const params = new URLSearchParams({
    api_key: apiKey,
    language,
    page: String(page),
    sort_by: String(source.sortBy || (mediaType === "tv" ? "first_air_date.desc" : "popularity.desc"))
  });
  const filters = source.filters && typeof source.filters === "object" ? source.filters : {};
  applyTmdbDiscoverFilters(params, filters, mediaType);
  if (type === "COMPANY" && source.tmdbId) {
    params.set("with_companies", String(source.tmdbId));
  }
  if (type === "NETWORK" && source.tmdbId) {
    params.set("with_networks", String(source.tmdbId));
    params.set("first_air_date.lte", filters.releaseDateLte || new Date().toISOString().slice(0, 10));
    params.set("with_status", "0|3|4");
  }
  const url = `${TMDB_API_URL}/discover/${mediaType}?${params.toString()}`;
  const { payload } = await fetchJson(url);
  return {
    items: (Array.isArray(payload?.results) ? payload.results : []).map((item) => mapTmdbListItem(item, mediaType)).filter(Boolean),
    hasMore: Number(payload?.page || page) < Number(payload?.total_pages || page),
    page: Number(payload?.page || page)
  };
}

function buildTraktHeaders() {
  const clientId = String(TRAKT_CLIENT_ID || "").trim();
  if (!clientId) {
    throw new Error("Trakt is not configured");
  }
  return {
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    "trakt-api-key": clientId
  };
}

function mapTraktEntity(entity = {}, type = "movie") {
  const ids = entity?.ids || {};
  const title = firstNonEmpty(entity?.title, entity?.name);
  if (!title) {
    return null;
  }
  const id = firstNonEmpty(ids?.imdb, ids?.slug ? `${type}:${ids.slug}` : "", ids?.trakt ? `trakt:${ids.trakt}` : "");
  if (!id) {
    return null;
  }
  const normalizedType = type === "show" ? "series" : "movie";
  return normalizeItem({
    id,
    type: normalizedType,
    name: title,
    // Trakt list artwork comes back scheme-less ("media.trakt.tv/..."), which a
    // packaged file:// build resolves as a local path — every poster 404s.
    poster: toTraktImageUrl(firstNonEmpty(entity?.images?.poster?.[0], entity?.images?.poster, entity?.images?.posters?.[0])),
    background: toTraktImageUrl(firstNonEmpty(entity?.images?.fanart?.[0], entity?.images?.background, entity?.images?.backdrop?.[0])),
    releaseInfo: String(entity?.year || entity?.released || entity?.first_aired || "").slice(0, 4),
    logo: toTraktImageUrl(firstNonEmpty(entity?.images?.logo?.[0]))
  }, normalizedType);
}

async function fetchTraktSourceItems(source = {}, page = 1) {
  const mediaType = String(source.mediaType || "MOVIE").toUpperCase() === "TV" ? "show" : "movie";
  const url = new URL(`${String(TRAKT_API_URL || "https://api.trakt.tv").replace(/\/+$/, "")}/lists/${encodeURIComponent(String(source.traktListId || ""))}/items/${mediaType}`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("limit", String(TRAKT_PAGE_SIZE));
  url.searchParams.set("sort_by", String(source.sortBy || "rank"));
  url.searchParams.set("sort_how", String(source.sortHow || "asc"));
  const response = await fetch(url.toString(), { headers: buildTraktHeaders() });
  const payload = await response.json().catch(() => []);
  if (!response.ok) {
    throw new Error(String(payload?.message || payload?.error || response.statusText || "Could not load Trakt list"));
  }
  const pageCount = Number(response.headers.get("X-Pagination-Page-Count") || page);
  const items = (Array.isArray(payload) ? payload : []).map((entry) => {
    return mediaType === "show"
      ? mapTraktEntity(entry?.show || null, "show")
      : mapTraktEntity(entry?.movie || null, "movie");
  }).filter(Boolean);
  return {
    items,
    hasMore: page < pageCount && items.length > 0,
    page
  };
}

async function fetchSourceItems(source = {}, page = 1) {
  const provider = String(source.provider || "addon").toLowerCase();
  if (provider === "tmdb") {
    return fetchTmdbSourceItems(source, page);
  }
  if (provider === "trakt") {
    return fetchTraktSourceItems(source, page);
  }
  return fetchAddonSourceItems(source, page);
}

export const FolderDetailScreen = {
  getRouteStateKey(params = {}) {
    const collectionId = String(params?.collectionId || "").trim();
    const folderId = String(params?.folderId || "").trim();
    if (!collectionId || !folderId) {
      return null;
    }
    return `folderDetail:${collectionId}:${folderId}`;
  },

  captureRouteState() {
    const shell = this.container?.querySelector(".seeall-shell");
    const active =
      document.activeElement instanceof HTMLElement &&
      this.container?.contains(document.activeElement)
        ? document.activeElement
        : null;
    const focused =
      (active?.classList?.contains("focusable") ? active : null) ||
      this.container?.querySelector(".focusable.focused") ||
      active;
    const focusedSection = focused?.closest?.("[data-row-key]") || null;
    const trackScrollStates = Object.fromEntries(
      Array.from(this.container?.querySelectorAll(".folder-row-track[data-row-key]") || [])
        .map((track) => [String(track.dataset.rowKey || ""), Number(track.scrollLeft || 0)])
        .filter(([key]) => key)
    );
    return {
      params: this.params ? { ...this.params } : {},
      selectedTabIndex: Number(this.selectedTabIndex || 0),
      lastFocusedKey: String(this.lastFocusedKey || ""),
      focusedItemId: String(focused?.dataset?.itemId || ""),
      focusedItemType: String(focused?.dataset?.itemType || ""),
      focusedRowKey: String(
        focusedSection?.dataset?.rowKey ||
          focused?.closest?.("[data-track-row-key]")?.dataset?.trackRowKey ||
          ""
      ),
      savedScrollTop: Number(shell?.scrollTop ?? this.savedScrollTop ?? 0),
      trackScrollStates,
      tabs: Array.isArray(this.tabs)
        ? this.tabs.map((tab) => ({
            ...tab,
            restoreNeedsReload: Boolean(tab.loading),
            loading: false
          }))
        : [],
      heroItem: this.heroItem ? { ...this.heroItem } : null,
      followLayoutFocusState: this.useHomeFollowLayout
        ? HomeScreen.captureCurrentFocusState.call(this)
        : null
    };
  },

  hydrateFromRouteState(restoredState = null, params = {}) {
    const snapshot = restoredState && typeof restoredState === "object" ? restoredState : null;
    if (
      !snapshot?.params ||
      this.getRouteStateKey(snapshot.params) !== this.getRouteStateKey(params)
    ) {
      return false;
    }
    this.selectedTabIndex = Math.max(0, Number(snapshot.selectedTabIndex || 0));
    this.lastFocusedKey = String(snapshot.lastFocusedKey || "tab:0");
    this.restoredFocusedItem = snapshot.focusedItemId
      ? {
          itemId: String(snapshot.focusedItemId),
          itemType: String(snapshot.focusedItemType || ""),
          rowKey: String(snapshot.focusedRowKey || "")
        }
      : null;
    this.savedScrollTop = Math.max(0, Number(snapshot.savedScrollTop || 0));
    this.restoredTrackScrollStates = snapshot.trackScrollStates || {};
    this.restoredFollowLayoutFocusState = snapshot.followLayoutFocusState || null;
    if (snapshot.heroItem?.id) {
      this.heroItem = { ...snapshot.heroItem };
    }

    const restoredTabs = new Map(
      (Array.isArray(snapshot.tabs) ? snapshot.tabs : [])
        .filter((tab) => tab?.key)
        .map((tab) => [String(tab.key), tab])
    );
    this.tabs = this.tabs.map((tab) => {
      const restored = restoredTabs.get(String(tab.key || ""));
      return restored
        ? {
            ...tab,
            items: Array.isArray(restored.items) ? [...restored.items] : [],
            hasMore: Boolean(restored.hasMore),
            page: Math.max(1, Number(restored.page || 1)),
            loading: false,
            error: String(restored.error || ""),
            restoreNeedsReload: Boolean(restored.restoreNeedsReload)
          }
        : tab;
    });
    this.sourceTabs = this.tabs.filter((tab) => !tab.isAllTab);
    this.selectedTabIndex = Math.min(
      this.selectedTabIndex,
      Math.max(0, this.tabs.length - 1)
    );
    return true;
  },

  async mount(params = {}, navigationContext = {}) {
    this.container = document.getElementById("folderDetail");
    ScreenUtils.show(this.container);
    // Reset in BOTH mount and cleanup — the fade class lives on the persistent
    // container, so a leftover one would mount the next visit fully transparent,
    // and a stuck exitBackPending flag would swallow every key press.
    this.clearExitFade();
    this.params = params || {};
    this.layoutPrefs = LayoutPreferences.get();
    this.collection = CollectionsStore.get().find((entry) => String(entry?.id || "") === String(this.params.collectionId || "")) || null;
    this.folder = this.collection?.folders?.find((entry) => String(entry?.id || "") === String(this.params.folderId || "")) || null;
    this.selectedTabIndex = 0;
    this.lastFocusedKey = "tab:0";
    this.savedScrollTop = 0;
    this.restoredTrackScrollStates = {};
    this.restoredFollowLayoutFocusState = null;
    this.restoredFocusedItem = null;
    this.navModel = { rows: [] };
    this.tabs = [];
    const preferredHomeLayout = String(this.layoutPrefs?.homeLayout || "classic").toLowerCase();
    this.viewMode = String(this.collection?.viewMode || "TABBED_GRID").toUpperCase();
    this.useHomeFollowLayout = this.viewMode === "FOLLOW_LAYOUT" || preferredHomeLayout === "modern";
    this.folderRouteEnterPending = true;
    this.heroItem = null;

    if (!this.collection || !this.folder) {
      this.container.innerHTML = `<div class="nav-screen seeall-shell"><div class="nav-screen-body"><div class="seeall-empty">Collection folder not found.</div></div></div>`;
      return;
    }

    this.heroItem = normalizeCollectionFolderItem({
      ...(this.folder || {}),
      collectionId: this.collection.id,
      collectionTitle: this.collection.title
    }, this.collection) || buildFolderHeroSeed(this.folder);
    if (this.useHomeFollowLayout) {
      this.layoutMode = "modern";
      this.layoutPrefs = {
        ...this.layoutPrefs,
        homeLayout: "modern",
        heroSectionEnabled: true
      };
      this.continueWatchingDisplay = [];
      this.continueWatchingLoading = false;
      this.heroCandidates = [this.heroItem].filter(Boolean);
      this.heroIndex = 0;
      this.rows = [];
      HomeScreen.ensureDelegatedEventsBound.call(this);
    }

    // The hero is fully known from the folder itself, so it must not wait on the
    // addon manifests / watched list — awaiting those first left the (already
    // shown) container blank until the slowest manifest fetch resolved, which
    // read as "the backdrop takes ages to appear". Paint first, hydrate after.
    this.watchedTitleIds = new Set();
    const folderSources = Array.isArray(this.folder.sources) && this.folder.sources.length
      ? this.folder.sources
      : buildFallbackStreamingSources(this.folder);
    const sourceTabs = folderSources.map((source, index) => ({
      key: buildFolderSourceKey(source, index),
      label: buildFolderTabLabel(source, []),
      source,
      items: [],
      hasMore: false,
      page: 1,
      loading: false,
      error: ""
    }));
    this.sourceTabs = sourceTabs;
    this.tabs = (this.collection.showAllTab !== false && sourceTabs.length > 1)
      ? [{ key: "all", label: "All", isAllTab: true, items: [], hasMore: false, page: 1, loading: true, error: "" }, ...sourceTabs]
      : sourceTabs;

    const restored = this.hydrateFromRouteState(
      navigationContext?.restoredState,
      this.params
    );
    this.render();
    const sourceOffset = this.tabs[0]?.isAllTab ? 1 : 0;
    const tabsToLoad = restored
      ? this.tabs
          .map((tab, index) => ({ tab, index }))
          .filter(({ tab }) => !tab.isAllTab && tab.restoreNeedsReload)
          .map(({ index }) => index)
      : sourceTabs.map((_, index) => index + sourceOffset);
    await Promise.all([
      this.hydrateFolderChrome(),
      ...tabsToLoad.map((index) => this.loadTab(index, { append: false }))
    ]);
  },

  // Addon manifests (tab labels) and the watched list (card badges) are chrome —
  // they refine what is already on screen, so they load alongside the tabs and
  // only trigger a repaint when they actually change something.
  async hydrateFolderChrome() {
    const mountToken = String(this.getRouteStateKey(this.params) || "");
    const [addons, watchedItems] = await Promise.all([
      addonRepository.getInstalledAddons().catch(() => []),
      watchedItemsRepository.getAll(5000).catch(() => [])
    ]);
    if (String(this.getRouteStateKey(this.params) || "") !== mountToken) {
      return;
    }
    const watchedTitleIds = buildWatchedTitleIdSet(watchedItems);
    const relabelled = this.tabs.map((tab) => {
      if (tab.isAllTab || !tab.source) {
        return tab;
      }
      const label = buildFolderTabLabel(tab.source, addons);
      return label === tab.label ? tab : { ...tab, label };
    });
    const labelsChanged = relabelled.some((tab, index) => tab !== this.tabs[index]);
    this.tabs = relabelled;
    this.sourceTabs = this.tabs.filter((tab) => !tab.isAllTab);
    this.watchedTitleIds = watchedTitleIds;
    if (!labelsChanged && !watchedTitleIds.size) {
      return;
    }
    if (this.useHomeFollowLayout) {
      this.scheduleFollowLayoutRender();
    } else {
      this.render();
    }
  },

  rebuildAllTab() {
    if (!this.tabs[0]?.isAllTab) {
      return;
    }
    const sourceTabs = this.tabs.slice(1);
    this.tabs[0] = {
      ...this.tabs[0],
      items: roundRobinMerge(sourceTabs.map((tab) => tab.items || [])),
      hasMore: sourceTabs.some((tab) => tab.hasMore),
      loading: sourceTabs.some((tab) => tab.loading),
      error: ""
    };
  },

  // Follow-layout rows are only shown once they have items (renderModernHomeLayout
  // skips empty rows), so the "loading:true" flip has nothing to paint — rendering
  // it anyway tore down and rebuilt the whole hero+rows DOM (fresh backdrop/logo
  // images, scrollTop reset to 0) once per tab, and again per tab once its fetch
  // resolved. With several source tabs firing via Promise.all that was ~10+ full
  // re-renders in under a second: hero backdrop/logo desync and scroll resets
  // while browsing a collection. Skip the no-op pre-fetch render and coalesce the
  // post-fetch renders that land close together into one.
  scheduleFollowLayoutRender() {
    if (this._followLayoutRenderTimer) {
      return;
    }
    this._followLayoutRenderTimer = setTimeout(() => {
      this._followLayoutRenderTimer = null;
      this.render();
    }, 80);
  },

  async loadTab(tabIndex, { append = false } = {}) {
    const tab = this.tabs[tabIndex];
    if (!tab || tab.isAllTab || tab.loading) {
      return;
    }
    this.tabs[tabIndex] = { ...tab, loading: true, error: "" };
    this.rebuildAllTab();
    if (!this.useHomeFollowLayout) {
      this.render();
    }
    try {
      const nextPage = append ? Math.max(1, Number(tab.page || 1) + 1) : 1;
      const result = await fetchSourceItems(tab.source, nextPage);
      const existing = append ? (this.tabs[tabIndex].items || []) : [];
      const seen = new Set(existing.map((item) => `${item.type}:${item.id}`));
      const incoming = (result.items || []).filter((item) => {
        const key = `${item.type}:${item.id}`;
        if (!item.id || seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
      this.tabs[tabIndex] = {
        ...this.tabs[tabIndex],
        items: append ? [...existing, ...incoming] : incoming,
        hasMore: Boolean(result.hasMore && incoming.length),
        page: Number(result.page || nextPage),
        loading: false,
        error: ""
      };
      if (!this.heroItem) {
        this.heroItem = this.tabs[tabIndex].items[0] || null;
      }
    } catch (error) {
      this.tabs[tabIndex] = {
        ...this.tabs[tabIndex],
        loading: false,
        error: String(error?.message || "Could not load source")
      };
    }
    this.rebuildAllTab();
    if (this.useHomeFollowLayout) {
      this.scheduleFollowLayoutRender();
    } else {
      this.render();
    }
  },

  getSelectedTab() {
    return this.tabs[this.selectedTabIndex] || null;
  },

  buildNavigationModel() {
    if (this.useHomeFollowLayout) {
      return HomeScreen.buildNavigationModel.call(this);
    }
    const rows = [];
    if (this.viewMode === "TABBED_GRID") {
      const tabNodes = Array.from(this.container?.querySelectorAll(".folder-detail-tab.focusable") || []);
      if (tabNodes.length) {
        rows.push(tabNodes);
      }
      const cardNodes = Array.from(this.container?.querySelectorAll(".seeall-card.focusable") || []);
      groupNodesByOffsetTop(cardNodes).forEach((rowNodes) => {
        if (rowNodes.length) {
          rows.push(rowNodes);
        }
      });
    } else {
      const rowTracks = Array.from(this.container?.querySelectorAll(".folder-row-track") || []);
      rowTracks.forEach((track) => {
        const cards = Array.from(track.querySelectorAll(".seeall-card.focusable"));
        if (cards.length) {
          rows.push(cards);
        }
      });
    }
    rows.forEach((rowNodes, rowIndex) => {
      rowNodes.forEach((node, colIndex) => {
        node.dataset.navRow = String(rowIndex);
        node.dataset.navCol = String(colIndex);
      });
    });
    this.navModel = { rows };
  },

  focusNode(target) {
    if (this.useHomeFollowLayout && arguments.length > 1) {
      return HomeScreen.focusNode.call(this, ...arguments);
    }
    if (!target) {
      return false;
    }
    this.container?.querySelectorAll(".focusable.focused").forEach((node) => {
      if (node !== target) {
        node.classList.remove("focused");
      }
    });
    target.classList.add("focused");
    target.focus();
    if (String(target.dataset.action || "") === "openDetail") {
      const item = normalizeItem({
        id: target.dataset.itemId || "",
        type: target.dataset.itemType || "movie",
        name: target.dataset.itemTitle || "Untitled",
        poster: target.querySelector(".seeall-card-poster-image")?.getAttribute("src") || "",
        background: target.dataset.backdropSrc || target.querySelector(".seeall-card-poster-image")?.getAttribute("src") || "",
        logo: target.dataset.logoSrc || "",
        releaseInfo: target.dataset.releaseInfo || "",
        description: target.dataset.description || ""
      });
      if (item?.id) {
        this.heroItem = item;
        this.applyHeroToDom();
      }
    }
    const shell = this.container?.querySelector(".seeall-shell");
    const rowTrack = target.closest(".folder-row-track");
    if (rowTrack instanceof HTMLElement) {
      const left = target.offsetLeft;
      const right = left + target.offsetWidth;
      if (left < rowTrack.scrollLeft + 40) {
        rowTrack.scrollLeft = Math.max(0, left - 40);
      } else if (right > rowTrack.scrollLeft + rowTrack.clientWidth - 40) {
        rowTrack.scrollLeft = right - rowTrack.clientWidth + 40;
      }
    }
    if (shell && (target.closest(".seeall-grid") || target.closest(".folder-detail-rows"))) {
      const top = target.offsetTop;
      const bottom = top + target.offsetHeight;
      if (top < shell.scrollTop + 100) {
        shell.scrollTop = Math.max(0, top - 100);
      } else if (bottom > shell.scrollTop + shell.clientHeight - 100) {
        shell.scrollTop = bottom - shell.clientHeight + 100;
      }
      this.savedScrollTop = shell.scrollTop;
    }
    this.lastFocusedKey = String(target.dataset.focusKey || this.lastFocusedKey || "");
    return true;
  },

  applyHeroToDom() {
    if (this.useHomeFollowLayout) {
      return HomeScreen.applyHeroToDom.call(this);
    }
    const hero = buildHeroDisplay(this.heroItem);
    if (!hero) {
      return;
    }
    const root = this.container;
    const backdrop = root?.querySelector?.(".folder-follow-hero-backdrop");
    const logo = root?.querySelector?.(".folder-follow-hero-logo");
    const title = root?.querySelector?.(".folder-follow-hero-title");
    const meta = root?.querySelector?.(".folder-follow-hero-meta");
    const description = root?.querySelector?.(".folder-follow-hero-description");
    if (backdrop) {
      if (hero.backdrop) {
        backdrop.setAttribute("src", hero.backdrop);
      } else {
        backdrop.removeAttribute("src");
      }
    }
    if (logo) {
      if (hero.logo) {
        logo.setAttribute("src", hero.logo);
        logo.removeAttribute("hidden");
      } else {
        logo.setAttribute("hidden", "hidden");
      }
    }
    if (title) {
      title.textContent = hero.title || "Untitled";
      title.classList.toggle("is-hidden", Boolean(hero.logo));
    }
    if (meta) {
      meta.textContent = hero.meta.join("  •  ");
    }
    if (description) {
      description.textContent = hero.description || " ";
    }
  },

  restoreFocus() {
    if (this.useHomeFollowLayout) {
      const current = this.container?.querySelector(".home-main .focusable.focused") || null;
      if (current) {
        return;
      }
      const identityTarget = this.findRestoredFocusedItem();
      if (identityTarget) {
        HomeScreen.setFocusedNode.call(this, identityTarget);
        this.lastMainFocus = identityTarget;
        HomeScreen.rememberMainRowFocus.call(this, identityTarget);
        HomeScreen.ensureTrackHorizontalVisibility.call(this, identityTarget);
        HomeScreen.scheduleModernHeroUpdate.call(this, identityTarget);
        HomeScreen.scheduleFocusedPosterFlow.call(this, identityTarget);
        this.restoredFocusedItem = null;
        this.restoredFollowLayoutFocusState = null;
        return;
      }
      if (
        this.restoredFollowLayoutFocusState &&
        HomeScreen.restoreFocusState.call(this, this.restoredFollowLayoutFocusState)
      ) {
        this.restoredFollowLayoutFocusState = null;
        return;
      }
      ScreenUtils.setInitialFocus(this.container, HomeScreen.getInitialFocusSelector.call(this));
      const target = this.container?.querySelector(".home-main .focusable.focused") || null;
      if (target) {
        this.lastMainFocus = target;
        HomeScreen.scheduleModernHeroUpdate.call(this, target);
        HomeScreen.scheduleFocusedPosterFlow.call(this, target);
      }
      return;
    }
    const target = this.findRestoredFocusedItem()
      || (this.lastFocusedKey
      ? this.container?.querySelector(`.focusable[data-focus-key="${this.lastFocusedKey}"]`)
      : null)
      || this.container?.querySelector(".folder-detail-tab.focusable")
      || this.container?.querySelector(".seeall-card.focusable")
      || null;
    if (!target) {
      return;
    }
    const shell = this.container?.querySelector(".seeall-shell");
    if (shell) {
      shell.scrollTop = Number(this.savedScrollTop || 0);
    }
    Object.entries(this.restoredTrackScrollStates || {}).forEach(([rowKey, scrollLeft]) => {
      const track = Array.from(
        this.container?.querySelectorAll(".folder-row-track[data-row-key]") || []
      ).find((node) => String(node.dataset.rowKey || "") === String(rowKey));
      if (track) {
        track.scrollLeft = Number(scrollLeft || 0);
      }
    });
    this.focusNode(target);
    this.restoredFocusedItem = null;
    if (shell) {
      shell.scrollTop = Number(this.savedScrollTop || 0);
    }
  },

  findRestoredFocusedItem() {
    const descriptor = this.restoredFocusedItem;
    if (!descriptor?.itemId || !this.container) {
      return null;
    }
    const candidates = Array.from(
      this.container.querySelectorAll(".focusable[data-item-id]")
    ).filter(
      (node) =>
        String(node.dataset.itemId || "") === descriptor.itemId &&
        (!descriptor.itemType ||
          String(node.dataset.itemType || "") === descriptor.itemType)
    );
    if (!candidates.length) {
      return null;
    }
    if (descriptor.rowKey) {
      const sameRow = candidates.find(
        (node) =>
          String(node.closest("[data-row-key]")?.dataset?.rowKey || "") ===
          descriptor.rowKey
      );
      if (sameRow) {
        return sameRow;
      }
    }
    return candidates[0];
  },

  render() {
    if (this.useHomeFollowLayout) {
      this.renderFollowLayout();
      return;
    }
    const enterClass = this.folderRouteEnterPending ? " nuvio-route-fade-enter" : "";
    this.folderRouteEnterPending = false;
    const sourceRows = this.viewMode === "TABBED_GRID"
      ? (this.sourceTabs || [])
      : this.tabs.filter((tab) => !tab.isAllTab);
    const heroDisplay = buildHeroDisplay(this.heroItem) || buildHeroDisplay(buildFolderHeroSeed(this.folder));
    const selectedTab = this.getSelectedTab();
    const items = selectedTab?.items || [];
    const cards = items.length
      ? items.map((item, index) => `
          <article class="seeall-card focusable"
                   data-action="openDetail"
                   data-item-id="${escapeHtml(item.id || "")}" 
                   data-item-type="${escapeHtml(item.type || "movie")}" 
                   data-item-title="${escapeHtml(item.name || "Untitled")}" 
                   data-focus-key="item:${escapeHtml(item.id || index)}"
                   data-item-index="${index}">
            <div class="seeall-card-poster-wrap">
              ${item.poster
                ? `<img class="seeall-card-poster-image" src="${escapeHtml(optimizePosterUrl(item.poster))}" alt="${escapeHtml(item.name || "content")}" loading="lazy" decoding="async" />`
                : `<div class="seeall-card-poster placeholder"></div>`}
              ${isTitleItemWatched(item, this.watchedTitleIds) ? renderTitleWatchedBadge() : ""}
            </div>
            ${this.layoutPrefs?.posterLabelsEnabled !== false ? `
              <div class="seeall-card-title">${escapeHtml(item.name || "Untitled")}</div>
              <div class="seeall-card-year">${escapeHtml(item.releaseInfo || "")}</div>
            ` : ""}
          </article>
        `).join("")
      : `<div class="seeall-empty">${escapeFolderHtml(selectedTab?.error || "No items available.")}</div>`;

    const rowsMarkup = sourceRows.map((tab, index) => {
      const mediaTypeLabel =
        sourceType(tab.source || {}) === "series" ? "Series" : "Movie";
      const rowTitle = tab.label !== mediaTypeLabel ? `${tab.label} - ${mediaTypeLabel}` : tab.label;
      const rowCards = (tab.items || []).map((item, itemIndex) => `
        <article class="seeall-card focusable"
                 data-action="openDetail"
                 data-item-id="${escapeHtml(item.id || "")}" 
                 data-item-type="${escapeHtml(item.type || "movie")}" 
                 data-item-title="${escapeHtml(item.name || "Untitled")}" 
                 data-backdrop-src="${escapeHtml(item.background || item.poster || "")}" 
                 data-logo-src="${escapeHtml(item.logo || "")}" 
                 data-release-info="${escapeHtml(item.releaseInfo || "")}" 
                 data-description="${escapeHtml(item.description || "")}" 
                 data-focus-key="row:${index}:item:${escapeHtml(item.id || itemIndex)}"
                 data-item-index="${itemIndex}">
          <div class="seeall-card-poster-wrap">
            ${item.poster
              ? `<img class="seeall-card-poster-image" src="${escapeHtml(optimizePosterUrl(item.poster))}" alt="${escapeHtml(item.name || "content")}" loading="lazy" decoding="async" />`
              : `<div class="seeall-card-poster placeholder"></div>`}
            ${isTitleItemWatched(item, this.watchedTitleIds) ? renderTitleWatchedBadge() : ""}
          </div>
          ${this.layoutPrefs?.posterLabelsEnabled !== false ? `
            <div class="seeall-card-title">${escapeHtml(item.name || "Untitled")}</div>
            <div class="seeall-card-year">${escapeHtml(item.releaseInfo || "")}</div>
          ` : ""}
        </article>
      `).join("");
      const loading = tab.loading ? '<div class="seeall-loading folder-row-loading">Loading...</div>' : '';
      const error = tab.error && !tab.loading ? `<div class="seeall-empty">${escapeHtml(tab.error)}</div>` : '';
      return `
        <section class="folder-detail-row">
          <h2 class="folder-detail-row-title">${escapeHtml(rowTitle)}</h2>
          <div class="folder-row-track" data-row-key="${escapeHtml(tab.key)}">
            ${rowCards}
          </div>
          ${error}
          ${loading}
        </section>
      `;
    }).join("");

    this.container.innerHTML = this.viewMode === "TABBED_GRID"
      ? `
          <div class="nav-screen seeall-shell folder-detail-shell${enterClass}">
            <div class="nav-screen-body">
              <header class="seeall-header folder-detail-header">
                <div class="folder-detail-eyebrow">${escapeHtml(this.collection?.title || "Collection")}</div>
                <h2 class="seeall-title">${escapeHtml(this.folder?.title || "Folder")}</h2>
                ${this.tabs.length > 1 ? `
                  <div class="folder-detail-tabs">
                    ${this.tabs.map((tab, index) => `
                      <button type="button"
                              class="folder-detail-tab focusable${index === this.selectedTabIndex ? " is-selected" : ""}"
                              data-action="selectTab"
                              data-tab-index="${index}"
                              data-focus-key="tab:${index}">${escapeHtml(tab.label || "Tab")}</button>
                    `).join("")}
                  </div>
                ` : ""}
              </header>
              <section class="seeall-grid">
                ${cards}
              </section>
              ${selectedTab?.loading ? '<div class="seeall-loading">Loading...</div>' : ''}
            </div>
          </div>
        `
      : `
          <div class="nav-screen seeall-shell folder-detail-shell folder-detail-follow-layout">
            <div class="nav-screen-body">
              <section class="folder-follow-hero">
                <div class="folder-follow-hero-media">
                  <img class="folder-follow-hero-backdrop" src="${escapeHtml(heroDisplay?.backdrop || "")}" alt="" />
                </div>
                <div class="folder-follow-hero-copy">
                  <img class="folder-follow-hero-logo" src="${escapeHtml(heroDisplay?.logo || "")}" alt=""${heroDisplay?.logo ? "" : ' hidden="hidden"'} />
                  <h1 class="folder-follow-hero-title${heroDisplay?.logo ? " is-hidden" : ""}">${escapeHtml(heroDisplay?.title || this.folder?.title || "")}</h1>
                  <div class="folder-follow-hero-meta">${escapeHtml((heroDisplay?.meta || []).join("  •  "))}</div>
                  <p class="folder-follow-hero-description">${escapeHtml(heroDisplay?.description || " ")}</p>
                </div>
              </section>
              <section class="folder-detail-rows">
                ${rowsMarkup}
              </section>
            </div>
          </div>
        `;

    ScreenUtils.indexFocusables(this.container);
    this.buildNavigationModel();
    this.restoreFocus();
    this.applyHeroToDom();
  },

  renderFollowLayout() {
    HomeScreen.teardownModernTrackScrollPagination.call(this);
    HomeScreen.cancelFocusedPosterFlow.call(this);
    const enterClass = this.folderRouteEnterPending ? " nuvio-route-fade-enter" : "";
    this.folderRouteEnterPending = false;
    this.expandedPosterNode = null;
    this.rows = buildFolderSourceRows(this.tabs || []);
    const modernLandscapePostersEnabled = Boolean(this.layoutPrefs?.modernLandscapePostersEnabled);
    const rowItems = this.rows.flatMap((row) => row?.result?.data?.items || []);
    this.heroCandidates = [this.heroItem, ...rowItems].filter((item) => item?.id);
    const heroItem = this.heroItem || this.heroCandidates[0] || null;
    const payload = renderModernHomeLayout({
      rows: this.rows,
      heroItem,
      heroCandidates: this.heroCandidates,
      continueWatchingItems: [],
      continueWatchingLoading: false,
      continueWatchingLoadingCount: 0,
      rowItemLimit: 50,
      eagerRowCount: this.rows.length,
      showHeroSection: Boolean(heroItem),
      showPosterLabels: false,
      showCatalogTypeSuffix: this.layoutPrefs?.catalogTypeSuffixEnabled !== false,
      preferLandscapePosters: modernLandscapePostersEnabled,
      focusedRowKey: "",
      focusedItemIndex: -1,
      expandFocusedPoster: false,
      buildModernHeroPresentation,
      renderContinueWatchingSection,
      createPosterCardMarkup,
      createSeeAllCardMarkup,
      formatCatalogRowTitle,
      watchedTitleIds: this.watchedTitleIds,
      escapeHtml,
      escapeAttribute
    });
    this.catalogSeeAllMap = payload.catalogSeeAllMap;
    const sizingStyle = buildModernHomeSizingStyle(this.layoutPrefs);
    const markup = `
      <div class="home-shell home-screen-shell home-layout-modern${modernLandscapePostersEnabled ? " home-modern-landscape-posters" : ""} folder-detail-home-shell" style="${escapeAttribute(sizingStyle)}">
        <main class="home-main home-screen-main">
          <div class="home-route-content${enterClass}">
            ${payload.markup}
          </div>
        </main>
      </div>
    `;
    if (!this.applyFollowLayoutRowsPatch(markup, heroItem)) {
      this.container.innerHTML = markup;
    }
    ScreenUtils.indexFocusables(this.container);
    HomeScreen.buildNavigationModel.call(this);
    HomeScreen.bindHomeViewportEvents.call(this);
    if (modernLandscapePostersEnabled) {
      HomeScreen.applyCachedModernLandscapePosterMetrics.call(this, this.container.querySelector(".home-screen-shell.home-modern-landscape-posters"));
    } else {
      HomeScreen.applyCachedModernPortraitPosterMetrics.call(this, this.container.querySelector(".home-screen-shell.home-layout-modern:not(.home-modern-landscape-posters)"));
    }
    this.restoreFocus();
    this.setupModernTrackScrollPagination();
    HomeScreen.applyHeroToDom.call(this);
    HomeScreen.ensureHomeTruncationObservers.call(this);
    HomeScreen.scheduleHomeTruncationUpdate.call(this);
  },

  // The folder hero comes from the folder itself, not from the rows, so it is
  // already final on the mount render — but the render that runs when the
  // sources' items land replaced the whole container, recreating the hero's
  // backdrop/logo <img> nodes (a visible blink a beat after the collection
  // opens) and resetting the rows viewport's scrollTop. When the shell is
  // already up and the hero is unchanged, swap only the rows subtree in.
  // Returns false to fall back to the full innerHTML rebuild.
  applyFollowLayoutRowsPatch(markup, heroItem) {
    const liveScroll = this.container?.querySelector(".home-modern-rows-scroll");
    if (!liveScroll) {
      return false;
    }
    const liveHero = this.container.querySelector(".home-hero-card");
    const heroId = String(heroItem?.id || "");
    if (Boolean(liveHero) !== Boolean(heroId)) {
      return false;
    }
    if (liveHero && String(liveHero.dataset.itemId || "") !== heroId) {
      return false;
    }
    const template = document.createElement("template");
    template.innerHTML = markup;
    const nextScroll = template.content.querySelector(".home-modern-rows-scroll");
    if (!nextScroll) {
      return false;
    }
    // The row entrance animation is for rows appearing into an empty folder,
    // not for a later in-place refresh — replaying it on every refresh reads as
    // the whole list flashing.
    const hadRows = Boolean(liveScroll.querySelector(".home-modern-row"));
    if (hadRows) {
      nextScroll.querySelectorAll(".home-row-enter").forEach((row) => {
        row.classList.remove("home-row-enter");
      });
    }
    if (typeof liveScroll.replaceChildren === "function") {
      liveScroll.replaceChildren(...nextScroll.childNodes);
    } else {
      liveScroll.innerHTML = nextScroll.innerHTML;
    }
    return true;
  },

  setupModernTrackScrollPagination() {
    HomeScreen.teardownModernTrackScrollPagination.call(this);
    if (!this.useHomeFollowLayout || !this.container) {
      return;
    }
    const tracks = Array.from(this.container.querySelectorAll(".home-modern-row .home-track"));
    this._trackScrollHandlers = this._trackScrollHandlers || new Map();
    tracks.forEach((track) => {
      const rowKey = String(track.dataset.trackRowKey || "");
      if (!rowKey || this._trackScrollHandlers.has(track)) {
        return;
      }
      const handler = () => {
        if (this._trackPaginationInFlight?.has(rowKey)) {
          return;
        }
        const cards = track.querySelectorAll(".home-content-card:not(.home-poster-card-loading)");
        const firstCard = cards[0];
        const cardWidth = firstCard ? firstCard.offsetWidth : 230;
        const nearEndThreshold = (cardWidth + 24) * 4;
        const distanceFromEnd = HomeScreen.getTrackMaxScroll.call(this, track) - HomeScreen.getTrackScrollLeft.call(this, track);
        if (distanceFromEnd > nearEndThreshold) {
          return;
        }
        void this.loadMoreFollowLayoutRow(rowKey, track);
      };
      this._trackScrollHandlers.set(track, handler);
      if (HomeScreen.getTrackInner(track)) {
        // Transform track: no scroll events; HomeScreen.applyTrackScrollLeft
        // drives the handler instead. Run once so short rows top up immediately.
        handler();
      } else {
        track.addEventListener("scroll", handler, { passive: true });
        handler();
      }
    });
  },

  async loadMoreFollowLayoutRow(rowKey, track) {
    const rowIndex = (this.rows || []).findIndex((row) => String(row?.homeCatalogKey || "") === String(rowKey || ""));
    const rowData = rowIndex >= 0 ? this.rows[rowIndex] : null;
    const tabIndex = Number(rowData?.folderTabIndex ?? -1);
    const tab = this.tabs?.[tabIndex] || null;
    if (!rowData || !tab || tab.isAllTab || tab.loading || !tab.hasMore) {
      return;
    }
    this._trackPaginationInFlight = this._trackPaginationInFlight || new Set();
    this._trackPaginationInFlight.add(rowKey);
    this.tabs[tabIndex] = { ...tab, loading: true, error: "" };
    try {
      const nextPage = Math.max(1, Number(tab.page || 1) + 1);
      const result = await fetchSourceItems(tab.source, nextPage);
      const existing = Array.isArray(tab.items) ? tab.items : [];
      const seen = new Set(existing.map((item) => `${item.type}:${item.id}`));
      const incoming = (result.items || []).filter((item) => {
        const key = `${item.type}:${item.id}`;
        if (!item.id || seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
      const merged = [...existing, ...incoming];
      const hasMore = Boolean(result.hasMore && incoming.length);
      this.tabs[tabIndex] = {
        ...this.tabs[tabIndex],
        items: merged,
        hasMore,
        page: Number(result.page || nextPage),
        loading: false,
        error: ""
      };
      this.rebuildAllTab();
      if (rowData?.result?.data) {
        rowData.result.data.items = merged;
        rowData.result.data.hasMore = hasMore;
        rowData.result.data.currentPage = Number(result.page || nextPage);
      }
      if (incoming.length && track?.isConnected) {
        const modernLandscapePostersEnabled = Boolean(this.layoutPrefs?.modernLandscapePostersEnabled);
        const startIndex = existing.length;
        const newMarkup = incoming.map((item, index) => createPosterCardMarkup(
          item,
          rowIndex,
          startIndex + index,
          rowData.type || "movie",
          rowData,
          false,
          "modern",
          false,
          modernLandscapePostersEnabled,
          false,
          this.watchedTitleIds
        )).join("");
        const fragment = document.createRange().createContextualFragment(newMarkup);
        (HomeScreen.getTrackInner(track) || track).appendChild(fragment);
        ScreenUtils.indexFocusables(track);
        HomeScreen.buildNavigationModel.call(this);
        this.heroCandidates = [this.heroItem, ...(this.rows || []).flatMap((row) => row?.result?.data?.items || [])].filter((item) => item?.id);
        const paginationHandler = this._trackScrollHandlers?.get(track);
        if (paginationHandler) paginationHandler();
      }
    } catch (error) {
      this.tabs[tabIndex] = {
        ...this.tabs[tabIndex],
        loading: false,
        error: String(error?.message || "Could not load source")
      };
      if (rowData?.result) {
        rowData.result.status = "error";
      }
      console.warn("Folder track pagination failed", rowKey, error);
    } finally {
      this._trackPaginationInFlight?.delete(rowKey);
    }
  },

  mergeHeroIntoFolderTabs(itemId, mergedHero) {
    const mergeItems = (items = []) => (Array.isArray(items) ? items : []).map((item) => {
      return String(item?.id || "") === String(itemId || "") ? { ...item, ...mergedHero } : item;
    });
    this.tabs = (this.tabs || []).map((tab) => ({
      ...tab,
      items: mergeItems(tab.items)
    }));
    this.sourceTabs = (this.sourceTabs || []).map((tab) => ({
      ...tab,
      items: mergeItems(tab.items)
    }));
  },

  // The hero pre-warm in HomeScreen.scheduleModernHeroUpdate reads this to
  // decide whether it can commit the enriched logo/backdrop with the copy.
  // Ours live in the TMDB cache below, not in the inherited _heroMetaCache.
  getCachedHeroArt(itemId) {
    const cached = this._heroTmdbCache?.get(String(itemId));
    if (cached) {
      return { background: cached.background || "", logo: cached.logo || "" };
    }
    return HomeScreen.getCachedHeroArt.call(this, itemId);
  },

  // enrichCurrentHeroAsync below runs the TMDB pipeline, but the inherited
  // prefetch warms a metaRepository cache that pipeline never reads — so every
  // focus paid the full ensureTmdbId + fetchEnrichment latency with the copy
  // hidden behind is-hero-meta-enriching while the backdrop had already
  // crossfaded in. Prefetch through the same pipeline instead.
  _prefetchHeroEnrichment(hero) {
    if (!hero?.id) {
      return;
    }
    if (!hasTmdbItemId(hero)) {
      HomeScreen._prefetchHeroEnrichment.call(this, hero);
      return;
    }
    if (!this._heroTmdbCache) this._heroTmdbCache = new Map();
    if (!this._heroTmdbPending) this._heroTmdbPending = new Set();
    const itemId = String(hero.id);
    if (this._heroTmdbCache.has(itemId) || this._heroTmdbPending.has(itemId)) {
      return;
    }
    if (this._heroTmdbPending.size >= 2) {
      return;
    }
    this._heroTmdbPending.add(itemId);
    const itemType = String(hero.type || hero.apiType || "movie");
    const settings = TmdbSettingsStore.get();
    Promise.resolve()
      .then(() => TmdbService.ensureTmdbId(firstNonEmpty(hero.tmdbId, hero.id), itemType))
      .then((tmdbId) => (tmdbId
        ? TmdbMetadataService.fetchEnrichment({ tmdbId, contentType: itemType, language: settings.language })
        : null))
      .then((enriched) => {
        this._heroTmdbPending.delete(itemId);
        if (this._heroTmdbCache.size >= 100) {
          this._heroTmdbCache.delete(this._heroTmdbCache.keys().next().value);
        }
        // null is a meaningful entry — it records "TMDB had nothing" so the
        // commit path can clear heroMetaEnriching without refetching.
        const merged = enriched ? buildEnrichedTmdbItem(hero, enriched, settings) : null;
        this._heroTmdbCache.set(itemId, merged);
        // Warm the exact URLs the hero will request (the presentation applies
        // the w1280/w185 variants), so the commit is a cache hit.
        const display = merged ? buildModernHeroPresentation(merged) : null;
        if (display?.backdrop) preloadImageSource(display.backdrop);
        if (display?.logo) preloadImageSource(display.logo);
      })
      .catch(() => {
        this._heroTmdbPending.delete(itemId);
      });
  },

  async enrichCurrentHeroAsync(hero) {
    if (!this.useHomeFollowLayout) {
      return;
    }
    if (!hero || !hero.id || hero.heroSource === "continueWatching" || hero.heroSource === "collection" || hero.heroMetaEnriched) {
      return;
    }
    if (!hasTmdbItemId(hero)) {
      return HomeScreen.enrichCurrentHeroAsync.call(this, hero);
    }

    const itemId = String(hero.id || "");
    const itemType = String(hero.type || hero.apiType || "movie");
    const token = (this.heroEnrichmentToken = (Number(this.heroEnrichmentToken || 0) + 1));

    // Prefetch hit: resolve in this task so the copy is never hidden for a
    // frame longer than the backdrop crossfade needs.
    const prefetched = this._heroTmdbCache?.get(itemId);
    if (prefetched !== undefined) {
      if (String(this.heroItem?.id || "") !== itemId) {
        return;
      }
      const mergedHero = prefetched
        ? { ...this.heroItem, ...prefetched, heroMetaEnriched: true, heroMetaEnriching: false }
        : { ...this.heroItem, heroMetaEnriched: true, heroMetaEnriching: false };
      this.heroItem = mergedHero;
      HomeScreen.mergeHeroIntoCatalogState.call(this, itemId, mergedHero);
      this.mergeHeroIntoFolderTabs(itemId, mergedHero);
      HomeScreen.applyHeroToDom.call(this);
      return;
    }

    try {
      const settings = TmdbSettingsStore.get();
      const tmdbId = await TmdbService.ensureTmdbId(firstNonEmpty(hero.tmdbId, hero.id), itemType);
      if (!tmdbId) {
        if (String(this.heroItem?.id || "") === itemId) {
          this.heroItem = { ...this.heroItem, heroMetaEnriched: true, heroMetaEnriching: false };
          HomeScreen.applyHeroToDom.call(this);
        }
        return;
      }
      const enriched = await TmdbMetadataService.fetchEnrichment({
        tmdbId,
        contentType: itemType,
        language: settings.language
      });
      if (Number(this.heroEnrichmentToken) !== token || String(this.heroItem?.id || "") !== itemId) {
        return;
      }
      const mergedHero = enriched
        ? {
          ...this.heroItem,
          ...buildEnrichedTmdbItem(this.heroItem, enriched, settings),
          heroMetaEnriched: true,
          heroMetaEnriching: false
        }
        : { ...this.heroItem, heroMetaEnriched: true, heroMetaEnriching: false };
      this.heroItem = mergedHero;
      // Seed the prefetch cache so re-focusing this card (row scrollback, back
      // from detail) takes the in-task path above instead of refetching.
      if (!this._heroTmdbCache) this._heroTmdbCache = new Map();
      if (!this._heroTmdbCache.has(itemId)) {
        this._heroTmdbCache.set(itemId, enriched ? buildEnrichedTmdbItem(hero, enriched, settings) : null);
      }
      HomeScreen.mergeHeroIntoCatalogState.call(this, itemId, mergedHero);
      this.mergeHeroIntoFolderTabs(itemId, mergedHero);
      HomeScreen.applyHeroToDom.call(this);
    } catch (_error) {
      if (String(this.heroItem?.id || "") === itemId) {
        this.heroItem = { ...this.heroItem, heroMetaEnriched: true, heroMetaEnriching: false };
        HomeScreen.applyHeroToDom.call(this);
      }
    }
  },

  startPendingContinueWatchingHold(node) {
    if (!this.useHomeFollowLayout) {
      return HomeScreen.startPendingContinueWatchingHold.call(this, node);
    }
    if (!this.isHomeHoldTarget(node)) {
      return false;
    }
    this.cancelPendingContinueWatchingEnter();
    this.cancelPendingContinueWatchingHold();
    const isPoster = this.isPosterHoldTarget(node);
    const item = isPoster ? this.getPosterItemFromNode(node) : this.getContinueWatchingItemFromNode(node);
    if (isPoster && !item?.id) {
      return false;
    }
    if (!isPoster && !item?.contentId) {
      return false;
    }
    this.pendingContinueWatchingHoldTarget = {
      kind: isPoster ? "poster" : "continueWatching",
      itemId: String(isPoster ? item.id : item.contentId || ""),
      itemType: String(isPoster ? item.type : ""),
      videoId: String(isPoster ? "" : item.videoId || ""),
      holdTriggered: false
    };
    this.pendingContinueWatchingHoldTimer = setTimeout(() => {
      this.pendingContinueWatchingHoldTimer = null;
      const pending = this.pendingContinueWatchingHoldTarget;
      if (!pending || Router.getCurrent() !== "folderDetail") {
        return;
      }
      const current = this.container?.querySelector(".home-continue-card.focusable.focused, .home-poster-card.focusable.focused") || null;
      if (!this.hasPendingContinueWatchingHold(current)) {
        return;
      }
      pending.holdTriggered = true;
      this.openHoldMenuForNode(current);
    }, 650);
    return true;
  },

  async onKeyDown(event) {
    if (this.exitBackPending) {
      event?.preventDefault?.();
      return;
    }
    if (isBackEvent(event)) {
      event?.preventDefault?.();
      if (this.useHomeFollowLayout && (this.continueWatchingMenu || this.posterHoldMenu)) {
        if (this.continueWatchingMenu) {
          HomeScreen.closeContinueWatchingMenu.call(this);
        } else {
          HomeScreen.closePosterHoldMenu.call(this);
        }
        return;
      }
      this.prepareHomeReturnAnimation();
      this.requestExitWithFade();
      return;
    }
    if (this.useHomeFollowLayout) {
      HomeScreen.onKeyDown.call(this, event);
      return;
    }
    const current = this.container?.querySelector(".focusable.focused") || null;
    if (!current) {
      return;
    }
    const code = Number(event?.keyCode || 0);
    if (code === 13) {
      event?.preventDefault?.();
      const action = String(current.dataset.action || "");
      if (action === "selectTab") {
        this.selectedTabIndex = Math.max(0, Number(current.dataset.tabIndex || 0));
        this.lastFocusedKey = `tab:${this.selectedTabIndex}`;
        this.savedScrollTop = 0;
        this.render();
        return;
      }
      if (action === "openDetail") {
        this.lastFocusedKey = String(
          current.dataset.focusKey || this.lastFocusedKey || ""
        );
        Router.navigate("detail", {
          itemId: current.dataset.itemId || "",
          itemType: current.dataset.itemType || "movie",
          fallbackTitle: current.dataset.itemTitle || "Untitled"
        });
      }
      return;
    }
    const direction = code === 37 ? -1 : (code === 39 ? 1 : 0);
    if (direction !== 0 && current.matches(".folder-detail-tab.focusable")) {
      event?.preventDefault?.();
      const tabs = Array.from(this.container?.querySelectorAll(".folder-detail-tab.focusable") || []);
      const currentIndex = tabs.indexOf(current);
      this.focusNode(tabs[Math.max(0, Math.min(tabs.length - 1, currentIndex + direction))] || current);
      return;
    }
    if (code === 38 || code === 40 || code === 37 || code === 39) {
      event?.preventDefault?.();
      const row = Number(current.dataset.navRow || 0);
      const col = Number(current.dataset.navCol || 0);
      if (code === 37 || code === 39) {
        const rowNodes = this.navModel.rows[row] || [];
        this.focusNode(rowNodes[Math.max(0, Math.min(rowNodes.length - 1, col + (code === 39 ? 1 : -1)))] || current);
        return;
      }
      const nextRowNodes = this.navModel.rows[row + (code === 40 ? 1 : -1)] || null;
      if (!nextRowNodes?.length) {
        return;
      }
      this.focusNode(nextRowNodes[Math.max(0, Math.min(nextRowNodes.length - 1, col))] || nextRowNodes[0]);
      if (this.viewMode === "TABBED_GRID" && code === 40 && this.getSelectedTab()?.hasMore && current.closest(".seeall-grid")) {
        const selectedTabIndex = this.selectedTabIndex;
        if (this.tabs[selectedTabIndex]?.isAllTab) {
          await Promise.all(this.tabs.slice(1).map((tab, index) => {
            if (tab.hasMore && !tab.loading) {
              return this.loadTab(index + 1, { append: true });
            }
            return Promise.resolve();
          }));
        } else if (this.tabs[selectedTabIndex]?.hasMore && !this.tabs[selectedTabIndex]?.loading) {
          await this.loadTab(selectedTabIndex, { append: true });
        }
      } else if (this.viewMode !== "TABBED_GRID" && code === 40) {
        const currentTrack = current.closest(".folder-row-track");
        const currentRowIndex = Array.from(this.container?.querySelectorAll(".folder-row-track") || []).indexOf(currentTrack);
        const rowsForView = this.tabs.filter((tab) => !tab.isAllTab);
        const currentRow = rowsForView[currentRowIndex] || null;
        if (currentRow?.hasMore && !currentRow.loading) {
          await this.loadTab(currentRowIndex, { append: true });
        }
      }
    }
  },

  onKeyUp(event) {
    if (this.useHomeFollowLayout) {
      HomeScreen.onKeyUp.call(this, event);
    }
  },

  prepareHomeReturnAnimation() {
    HomeScreen.pendingCollectionRouteReturnAnimation = true;
  },

  // Immediate visual ack before Router.back(): rebuilding home blocks the main
  // thread for ~1s on the C3, so a Back press otherwise looks ignored until the
  // screen snaps over. This opacity transition runs on the compositor, so it
  // keeps animating straight through that block. Same idea as
  // metaDetailsScreen.requestExitWithFade(), but driven from
  // consumeBackRequest() — FocusEngine.handleBack() intercepts back events and
  // returns before it ever reaches a screen's onKeyDown, so hanging this off
  // onKeyDown would never fire on device.
  requestExitWithFade() {
    if (this.exitBackPending) {
      return;
    }
    this.exitBackPending = true;
    const container = this.container;
    container?.classList.add("nuvio-route-exit-fading");

    // Waiting a double-rAF before Router.back() is NOT enough — measured on the
    // C3, the transition had still not been created when the rebuild seized the
    // main thread, so opacity sat at 1 for the whole ~420ms block and then
    // transitionrun/start/end all fired in the same millisecond afterwards, i.e.
    // no visible fade at all. Hand over only once the transition is genuinely
    // running (~50ms), by which point it lives on the compositor and keeps
    // animating through the block. The timeout is the floor, not the plan:
    // transitionstart never fires if the style change gets coalesced away.
    let navigated = false;
    const go = () => {
      if (navigated) {
        return;
      }
      navigated = true;
      this.clearExitFadeStartWatch();
      // skipConsume: this IS the consume — re-entering it would loop.
      Router.back({ skipConsume: true });
    };
    this.exitFadeStartHandler = (event) => {
      if (event.target === container && event.propertyName === "opacity") {
        go();
      }
    };
    container?.addEventListener("transitionstart", this.exitFadeStartHandler);
    this.exitFadeStartTimer = setTimeout(go, 200);

    // history.back() is a no-op when there is nothing to go back to (e.g. webOS
    // resumed straight into this route), which would strand the screen at
    // opacity 0. Undo the fade if the navigation never lands.
    this.exitFadeSafetyTimer = setTimeout(() => {
      this.exitFadeSafetyTimer = null;
      if (Router.getCurrent() === "folderDetail") {
        this.clearExitFade();
      }
    }, 1200);
  },

  clearExitFadeStartWatch() {
    if (this.exitFadeStartTimer) {
      clearTimeout(this.exitFadeStartTimer);
      this.exitFadeStartTimer = null;
    }
    if (this.exitFadeStartHandler) {
      this.container?.removeEventListener("transitionstart", this.exitFadeStartHandler);
      this.exitFadeStartHandler = null;
    }
  },

  clearExitFade() {
    this.exitBackPending = false;
    this.clearExitFadeStartWatch();
    if (this.exitFadeSafetyTimer) {
      clearTimeout(this.exitFadeSafetyTimer);
      this.exitFadeSafetyTimer = null;
    }
    this.container?.classList.remove("nuvio-route-exit-fading");
  },

  consumeBackRequest() {
    if (this.exitBackPending) {
      // Our own Router.back() passes skipConsume, so this is a second Back press
      // landing while the exit is already in flight — swallow it.
      return "history";
    }
    if (this.useHomeFollowLayout) {
      if (this.continueWatchingMenu) {
        HomeScreen.closeContinueWatchingMenu.call(this);
        return true;
      }
      if (this.posterHoldMenu) {
        HomeScreen.closePosterHoldMenu.call(this);
        return true;
      }
    }
    this.prepareHomeReturnAnimation();
    this.requestExitWithFade();
    // "history" tells FocusEngine.handleBack we are driving the history
    // navigation ourselves, so it must not suppress the resulting popstate.
    return "history";
  },

  cleanup() {
    if (this.useHomeFollowLayout) {
      HomeScreen.stopHeroRotation.call(this);
      HomeScreen.cancelPendingHeroFocus.call(this);
      HomeScreen.cancelFocusedPosterFlow.call(this);
      HomeScreen.clearFocusedPosterFlowState.call(this);
      HomeScreen.collapseFocusedPoster.call(this);
      HomeScreen.teardownModernTrackScrollPagination.call(this);
      if (this.boundHomeViewport && this.boundHomeViewportScrollHandler) {
        this.boundHomeViewport.removeEventListener("scroll", this.boundHomeViewportScrollHandler);
      }
      this.boundHomeViewport = null;
    }
    if (this._followLayoutRenderTimer) {
      // A debounced render firing after the screen is gone would paint into a
      // hidden container and — via restoreFocus() — steal focus back from home.
      clearTimeout(this._followLayoutRenderTimer);
      this._followLayoutRenderTimer = null;
    }
    this.clearExitFade();
    ScreenUtils.hide(this.container);
  }
};

Object.setPrototypeOf(FolderDetailScreen, HomeScreen);
