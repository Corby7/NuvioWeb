import { Router } from "../../navigation/router.js";
import { ScreenUtils } from "../../navigation/screen.js";
import { streamRepository } from "../../../data/repository/streamRepository.js";
import { addonRepository } from "../../../data/repository/addonRepository.js";
import { watchProgressRepository } from "../../../data/repository/watchProgressRepository.js";
import { metaRepository } from "../../../data/repository/metaRepository.js";
import { normalizeEpisodes } from "../../../data/repository/episodeUtils.js";
import { PlayerSettingsStore } from "../../../data/local/playerSettingsStore.js";
import {
  selectAutoPlayStream,
  isAutoPlayEffectivelyEnabled
} from "../../../core/streams/streamAutoPlaySelector.js";
import { DirectDebridResolver } from "../../../core/debrid/directDebridResolver.js";
import { DirectDebridStreamPreparer } from "../../../core/debrid/directDebridStreamPreparer.js";
import { WebOsEngineFsResolver } from "../../../core/p2p/webosEngineFsResolver.js";
import { TizenStreamingServerResolver } from "../../../core/p2p/tizenStreamingServerResolver.js";
import { DebridSettingsStore } from "../../../data/local/debridSettingsStore.js";
import { StreamBadgeSettingsStore } from "../../../data/local/streamBadgeSettingsStore.js";
import { LocalStore } from "../../../core/storage/localStore.js";
import {
  ensureWebOsImageProxyReady,
  isWebOsImageProxyUrl,
  normalizeImageUrl,
  onWebOsImageProxyReady
} from "../../../core/media/imageProxy.js";
import { Environment } from "../../../platform/environment.js";
import { I18n } from "../../../i18n/index.js";
import {
  matchStreamBadges,
  normalizeStreamBadgeChipColor,
  normalizeStreamBadgeRules
} from "../../../core/streams/streamBadgeRules.js";

// How long a chunk of sources waits for its badge artwork before rendering anyway.
const BADGE_PRELOAD_MAX_WAIT_MS = 150;

function waitMs(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// rAF callbacks still run before the frame is painted, so work scheduled there blocks the
// paint it was meant to follow. The nested timeout is what actually lands after it.
function afterNextPaint(fn) {
  requestAnimationFrame(() => {
    setTimeout(fn, 0);
  });
}

function resolveImdbIdFromMeta(meta = {}, params = {}) {
  return [
    meta?.imdbId,
    meta?.imdb_id,
    meta?.externalIds?.imdb,
    meta?.external_ids?.imdb_id,
    meta?.id,
    params?.itemId
  ]
    .map((value) => String(value || "").trim().split(":")[0])
    .find((value) => /^tt\d+$/i.test(value)) || null;
}

const failedAddonLogoUrls = new Set();
const addonLogoCache = new Map();
const ADDON_LOGO_CACHE_KEY = "nuvio.stream.addonLogoCache.v1";
const ADDON_LOGO_CACHE_LIMIT = 36;
const ADDON_LOGO_CACHE_MAX_LENGTH = 140000;
const STREAM_BADGE_LIMIT = 9;
let addonLogoCacheHydrated = false;
let addonLogoCachePersistTimer = null;

function t(key, params = {}, fallback = key) {
  return I18n.t(key, params, { fallback });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeHtml(value = "") {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function getDpadDirection(event) {
  const keyCode = Number(event?.keyCode || 0);
  const key = String(event?.key || "").toLowerCase();
  if (keyCode === 37 || key === "arrowleft" || key === "left") return "left";
  if (keyCode === 39 || key === "arrowright" || key === "right") return "right";
  if (keyCode === 38 || key === "arrowup" || key === "up") return "up";
  if (keyCode === 40 || key === "arrowdown" || key === "down") return "down";
  return null;
}

function isBackEvent(event) {
  return Environment.isBackEvent(event);
}

function normalizeType(itemType) {
  const normalized = String(itemType || "movie").toLowerCase();
  return normalized || "movie";
}

function detectQuality(text = "") {
  const value = String(text).toLowerCase();
  if (value.includes("2160") || value.includes("4k")) return "4k";
  if (value.includes("1080")) return "1080p";
  if (value.includes("720")) return "720p";
  if (value.includes("480")) return "480p";
  return "Auto";
}

function isMagnetUrl(value = "") {
  return String(value || "").trim().toLowerCase().startsWith("magnet:");
}

function streamDebridIdentity(item = {}) {
  const resolve = item.clientResolve || item.raw?.clientResolve || {};
  const behaviorHints = item.behaviorHints || item.raw?.behaviorHints || {};
  const infoHash = item.infoHash || item.raw?.infoHash || resolve.infoHash || "";
  const magnetUri = resolve.magnetUri
    || (isMagnetUrl(item.url) ? item.url : "")
    || (isMagnetUrl(item.externalUrl) ? item.externalUrl : "");
  const hasDebridMarker = Boolean(
    item.clientResolve
      || item.raw?.clientResolve
      || item.debridCacheStatus
      || item.raw?.debridCacheStatus
      || infoHash
      || magnetUri
  );
  if (!hasDebridMarker) {
    return "";
  }
  const locator = infoHash || magnetUri || item.url || item.externalUrl || item.ytId || "";
  if (!locator) {
    return "";
  }
  return [
    String(item.addonName || "Addon"),
    String(resolve.service || item.debridCacheStatus?.providerId || item.raw?.debridCacheStatus?.providerId || ""),
    String(locator),
    String(resolve.fileIdx ?? item.fileIdx ?? item.raw?.fileIdx ?? ""),
    String(behaviorHints.filename || resolve.filename || ""),
    String(resolve.torrentName || "")
  ].join("::");
}

function streamMergeKey(item = {}) {
  const debridIdentity = streamDebridIdentity(item);
  if (debridIdentity) {
    return `debrid::${debridIdentity}`;
  }
  const locator = item.url || item.externalUrl || item.ytId || "";
  if (!locator) {
    return "";
  }
  return [
    String(item.addonName || "Addon"),
    String(locator),
    String(item.sourceType || ""),
    String(item.fileIdx ?? ""),
    String(item.behaviorHints?.filename || "")
  ].join("::");
}

function mergeStreamItem(previous = {}, next = {}) {
  const behaviorHints = {
    ...(previous.behaviorHints || {}),
    ...(next.behaviorHints || {})
  };
  return {
    ...previous,
    ...next,
    id: previous.id || next.id,
    url: next.url || previous.url || null,
    externalUrl: next.externalUrl || previous.externalUrl || null,
    ytId: next.ytId || previous.ytId || null,
    behaviorHints: Object.keys(behaviorHints).length ? behaviorHints : null,
    subtitles: Array.isArray(next.subtitles) && next.subtitles.length ? next.subtitles : previous.subtitles,
    sources: Array.isArray(next.sources) && next.sources.length ? next.sources : previous.sources,
    streamPresentation: next.streamPresentation || previous.streamPresentation || null
  };
}

function formatBytes(value) {
  const size = Number(value || 0);
  if (!Number.isFinite(size) || size <= 0) {
    return "";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = size;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  const precision = unitIndex >= 3 ? 2 : (unitIndex >= 2 ? 1 : 0);
  return `${amount.toFixed(precision)} ${units[unitIndex]}`;
}

function normalizeEpisodeCode(season, episode) {
  const seasonNumber = Number(season || 0);
  const episodeNumber = Number(episode || 0);
  if (seasonNumber <= 0 || episodeNumber <= 0) {
    return "";
  }
  return `S${seasonNumber} E${episodeNumber}`;
}

function flattenStreams(streamResult) {
  if (!streamResult || streamResult.status !== "success") {
    return [];
  }
  const flattened = [];
  (streamResult.data || []).forEach((group) => {
    const groupName = group.addonName || "Addon";
    (group.streams || []).forEach((stream, index) => {
      const entry = {
        id: stream.id || `${groupName}-${index}-${stream.url || stream.externalUrl || stream.ytId || ""}`,
        name: stream.name || null,
        title: stream.title || null,
        description: stream.description || null,
        url: stream.url || null,
        ytId: stream.ytId || null,
        infoHash: stream.infoHash || null,
        fileIdx: stream.fileIdx ?? null,
        engineFs: stream.engineFs || stream.raw?.engineFs || null,
        externalUrl: stream.externalUrl || null,
        behaviorHints: stream.behaviorHints || null,
        sources: Array.isArray(stream.sources) ? stream.sources : [],
        quality: stream.quality || null,
        qualityValue: Number.isFinite(Number(stream.qualityValue)) ? Number(stream.qualityValue) : -1,
        clientResolve: stream.clientResolve || null,
        debridCacheStatus: stream.debridCacheStatus || null,
        streamPresentation: stream.streamPresentation || null,
        subtitles: Array.isArray(stream.subtitles) ? stream.subtitles : [],
        addonName: stream.addonName || groupName,
        addonLogo: stream.addonLogo || group.addonLogo || null,
        addonOrderIndex: Number.isFinite(Number(stream.addonOrderIndex))
          ? Number(stream.addonOrderIndex)
          : Number(group.addonOrderIndex ?? Number.MAX_SAFE_INTEGER),
        mimeType: stream.mimeType || stream.raw?.mimeType || stream.type || stream.source || null,
        sourceType: stream.sourceType || stream.mimeType || stream.type || stream.source || "",
        raw: stream
      };
      if (
        DirectDebridResolver.shouldListStream(entry)
        || WebOsEngineFsResolver.canResolveStream(entry)
        || TizenStreamingServerResolver.canResolveStream(entry)
      ) {
        flattened.push(entry);
      }
    });
  });
  return flattened;
}

function mergeStreamItems(existing = [], incoming = []) {
  const order = [];
  const byKey = new Map();
  const push = (item) => {
    if (!item) {
      return;
    }
    const key = streamMergeKey(item);
    if (!key) {
      return;
    }
    if (!byKey.has(key)) {
      order.push(key);
      byKey.set(key, item);
      return;
    }
    byKey.set(key, mergeStreamItem(byKey.get(key), item));
  };
  (existing || []).forEach(push);
  (incoming || []).forEach(push);
  return order.map((key) => byKey.get(key));
}

function renderMetaItem(kind, value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  return `
    <span class="stream-route-meta-item ${kind}">
      <span>${escapeHtml(text)}</span>
    </span>
  `;
}

function extractPeerCount(stream = {}) {
  const text = String([
    stream.name || "",
    stream.title || "",
    stream.description || "",
    stream.behaviorHints?.filename || ""
  ].join(" "));
  const patterns = [
    /\bseed(?:ers?)?\s*[:\-]?\s*(\d{1,5})\b/i,
    /\bpeers?\s*[:\-]?\s*(\d{1,5})\b/i,
    /\b(\d{1,5})\s*seed(?:ers?)?\b/i,
    /\b👤\s*(\d{1,5})\b/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  return "";
}

function getAddonBadgeLabel(name = "") {
  const cleaned = String(name || "").trim();
  if (!cleaned) {
    return "A";
  }
  if (/torrentio|torbox|torrent/i.test(cleaned)) {
    return "µ";
  }
  const letters = cleaned
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase())
    .join("")
    .slice(0, 2);
  return letters || cleaned.charAt(0).toUpperCase();
}

function normalizeAddonLogoUrl(value = "") {
  return normalizeImageUrl(value);
}

export function resetAddonLogoCache() {
  failedAddonLogoUrls.clear();
  addonLogoCache.clear();
  addonLogoCacheHydrated = false;
  if (addonLogoCachePersistTimer) {
    clearTimeout(addonLogoCachePersistTimer);
    addonLogoCachePersistTimer = null;
  }
  LocalStore.remove(ADDON_LOGO_CACHE_KEY);
}

export async function preloadStreamBadgeImages(settings = StreamBadgeSettingsStore.snapshot()) {
  const rules = normalizeStreamBadgeRules(settings?.rules);
  const urls = new Set();
  rules.imports.forEach((importItem) => {
    (importItem.filters || []).forEach((filter) => {
      const url = normalizeAddonLogoUrl(filter.imageURL);
      if (url) {
        urls.add(url);
      }
    });
  });
  await Promise.all(Array.from(urls).map((url) => requestAddonLogo(url)));
}

async function preloadMatchedStreamBadgeImages(streams = [], settings = StreamBadgeSettingsStore.snapshot()) {
  const urls = new Set();
  (streams || []).forEach((stream) => {
    matchStreamBadges(stream, settings?.rules)
      .slice(0, STREAM_BADGE_LIMIT)
      .forEach((badge) => {
        const url = normalizeAddonLogoUrl(badge.imageURL);
        if (url) {
          urls.add(url);
        }
      });
  });
  await Promise.all(Array.from(urls).map((url) => requestAddonLogo(url)));
}

function hydrateAddonLogoCache() {
  if (addonLogoCacheHydrated) {
    return;
  }
  addonLogoCacheHydrated = true;
  const cached = LocalStore.get(ADDON_LOGO_CACHE_KEY, {});
  const entries = cached && typeof cached === "object" && !Array.isArray(cached)
    ? cached
    : {};
  Object.keys(entries).forEach((url) => {
    const entry = entries[url];
    const dataUrl = String(entry?.dataUrl || "").trim();
    if (!url || !dataUrl.startsWith("data:image/")) {
      return;
    }
    addonLogoCache.set(url, {
      status: "ready",
      displayUrl: dataUrl,
      updatedAt: Number(entry?.updatedAt || Date.now())
    });
  });
}

function persistAddonLogoCache() {
  addonLogoCachePersistTimer = null;
  const entries = Array.from(addonLogoCache.entries())
    .filter(([, entry]) => (
      entry?.status === "ready"
      && String(entry.displayUrl || "").startsWith("data:image/")
      && String(entry.displayUrl || "").length <= ADDON_LOGO_CACHE_MAX_LENGTH
    ))
    .sort((left, right) => Number(right[1].updatedAt || 0) - Number(left[1].updatedAt || 0))
    .slice(0, ADDON_LOGO_CACHE_LIMIT);
  const payload = {};
  entries.forEach(([url, entry]) => {
    payload[url] = {
      dataUrl: entry.displayUrl,
      updatedAt: Number(entry.updatedAt || Date.now())
    };
  });
  LocalStore.set(ADDON_LOGO_CACHE_KEY, payload);
}

function scheduleAddonLogoCachePersist() {
  if (addonLogoCachePersistTimer) {
    return;
  }
  addonLogoCachePersistTimer = setTimeout(persistAddonLogoCache, 800);
}

function imageToDataUrl(image) {
  const naturalWidth = Math.max(1, Number(image?.naturalWidth || image?.width || 1));
  const naturalHeight = Math.max(1, Number(image?.naturalHeight || image?.height || 1));
  const maxSize = 144;
  const ratio = Math.min(1, maxSize / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(1, Math.round(naturalWidth * ratio));
  const height = Math.max(1, Math.round(naturalHeight * ratio));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas unavailable");
  }
  context.clearRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/png");
}

function requestAddonLogo(url = "", onSettled = null) {
  const normalized = normalizeAddonLogoUrl(url);
  if (!normalized || failedAddonLogoUrls.has(normalized)) {
    return Promise.resolve(false);
  }
  hydrateAddonLogoCache();
  const cached = addonLogoCache.get(normalized);
  if (cached?.status === "ready" || cached?.status === "direct") {
    return Promise.resolve(true);
  }
  if (cached?.status === "loading") {
    return cached.promise || Promise.resolve(false);
  }

  if (Environment.isWebOS() && !isWebOsImageProxyUrl(normalized)) {
    addonLogoCache.set(normalized, {
      status: "direct",
      displayUrl: normalized,
      updatedAt: Date.now()
    });
    if (typeof onSettled === "function") {
      setTimeout(onSettled, 0);
    }
    return Promise.resolve(true);
  }

  const loadingEntry = { status: "loading", updatedAt: Date.now(), promise: null };
  addonLogoCache.set(normalized, loadingEntry);
  const promise = new Promise((resolve) => {
    const settle = (ok) => {
      if (typeof onSettled === "function") {
        onSettled();
      }
      resolve(ok);
    };
    const fail = () => {
      failedAddonLogoUrls.add(normalized);
      addonLogoCache.set(normalized, { status: "failed", updatedAt: Date.now() });
      settle(false);
    };
    const finishDirect = () => {
      addonLogoCache.set(normalized, {
        status: "direct",
        displayUrl: normalized,
        updatedAt: Date.now()
      });
      settle(true);
    };
    const loadDirect = () => {
      const directImage = new Image();
      directImage.decoding = "async";
      try {
        directImage.referrerPolicy = "no-referrer";
      } catch (_) {
        // Some TV browsers expose referrerPolicy as read-only.
      }
      directImage.onload = finishDirect;
      directImage.onerror = fail;
      directImage.src = normalized;
    };
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    try {
      image.referrerPolicy = "no-referrer";
    } catch (_) {
      // Some TV browsers expose referrerPolicy as read-only.
    }
    image.onload = () => {
      try {
        const dataUrl = imageToDataUrl(image);
        addonLogoCache.set(normalized, {
          status: "ready",
          displayUrl: dataUrl,
          updatedAt: Date.now()
        });
        scheduleAddonLogoCachePersist();
        settle(true);
      } catch (_) {
        loadDirect();
      }
    };
    image.onerror = loadDirect;
    image.src = normalized;
  });
  loadingEntry.promise = promise;
  return promise;
}

function getCachedAddonLogoDisplayUrl(url = "") {
  const normalized = normalizeAddonLogoUrl(url);
  if (!normalized || failedAddonLogoUrls.has(normalized)) {
    return "";
  }
  hydrateAddonLogoCache();
  const cached = addonLogoCache.get(normalized);
  return cached?.status === "ready" || cached?.status === "direct"
    ? String(cached.displayUrl || "")
    : "";
}

function normalizeAddonLookupKey(value = "") {
  return String(value || "").trim().toLowerCase();
}

function buildAddonLogoLookup(addons = []) {
  const lookup = {};
  (addons || []).forEach((addon) => {
    const logo = normalizeAddonLogoUrl(addon?.logo);
    if (!logo) {
      return;
    }
    [
      addon?.displayName,
      addon?.name,
      addon?.id,
      addon?.baseUrl
    ].forEach((key) => {
      const normalized = normalizeAddonLookupKey(key);
      if (normalized && !lookup[normalized]) {
        lookup[normalized] = logo;
      }
    });
  });
  return lookup;
}

function resolveAddonLogo(addonName = "", lookup = {}) {
  const key = normalizeAddonLookupKey(addonName);
  return key ? normalizeAddonLogoUrl(lookup?.[key]) : "";
}

function rememberFailedAddonLogo(url = "") {
  const normalized = normalizeAddonLogoUrl(url);
  if (normalized) {
    failedAddonLogoUrls.add(normalized);
  }
}

function getStreamHeadline(stream = {}) {
  const primary = [
    stream.name,
    stream.title,
    stream.description
  ].find((value) => String(value || "").trim());
  if (!primary) {
    return stream.addonName || "Unknown source";
  }
  const firstLine = String(primary).split(/\r?\n/)[0].trim();
  return firstLine || (stream.addonName || "Unknown source");
}

const NOT_CACHED_TEXT_PATTERN = /\bnot\s*cached\b\s*/i;
const CACHED_TEXT_PATTERN = /\bcached\b\s*/i;
// Lightning, not the cloud-check this used to be: what the flag actually tells
// you is that the file is ready to stream now, and "instant" is the word for
// that. Must stay identical to SOURCE_META_ICONS.cached in playerScreen.js —
// the player's sources panel shows the same flag on the same streams.
const CACHED_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" fill="currentColor" viewBox="0 0 256 256"><path d="M215.79,118.17a8,8,0,0,0-5-5.66L153.18,90.9l14.66-73.33a8,8,0,0,0-13.69-7l-112,120a8,8,0,0,0,3,13l57.63,21.61L88.16,238.43a8,8,0,0,0,13.69,7l112-120A8,8,0,0,0,215.79,118.17Z"></path></svg>';
const NOT_CACHED_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" fill="currentColor" viewBox="0 0 256 256"><path d="M53.92,34.62A8,8,0,1,0,42.08,45.38L81.32,88.55l-.06.12A65,65,0,0,0,72,88a64,64,0,0,0,0,128h88a87.34,87.34,0,0,0,31.8-5.93l10.28,11.31a8,8,0,1,0,11.84-10.76ZM160,200H72a48,48,0,0,1,0-96c1.1,0,2.2,0,3.3.12A88.4,88.4,0,0,0,72,128a8,8,0,0,0,16,0,72.25,72.25,0,0,1,5.06-26.54l87,95.7A71.66,71.66,0,0,1,160,200Zm88-72a87.89,87.89,0,0,1-22.35,58.61A8,8,0,0,1,213.71,176,72,72,0,0,0,117.37,70a8,8,0,0,1-9.48-12.89A88,88,0,0,1,248,128Z"></path></svg>';
// Same glyph as SOURCE_META_ICONS.size in playerScreen.js.
const SIZE_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M219.31,72,184,36.69A15.86,15.86,0,0,0,172.69,32H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V83.31A15.86,15.86,0,0,0,219.31,72ZM168,208H88V152h80Zm40,0H184V152a16,16,0,0,0-16-16H88a16,16,0,0,0-16,16v56H48V48H172.69L208,83.31Z"></path></svg>';

// Matches playerScreen's sourceBitrateLabel, including the small-caps unicode
// spelling, so the same stream reports the same number on both screens.
function getStreamBitrate(stream = {}) {
  const text = [
    stream.name,
    stream.title,
    stream.description,
    stream.behaviorHints?.filename
  ].map((value) => String(value || "")).join(" ");
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*(?:mbps|mb\/s|ᴹᵇᵖˢ)/i);
  return match?.[1] ? `${match[1].replace(",", ".")} Mbps` : "";
}

// Bitrate has its own chip in the meta strip now, so take it (and one adjacent
// separator) out of the description line it came from.
function stripBitrateTokenFromLine(line = "") {
  return String(line)
    .replace(/\d+(?:[.,]\d+)?\s*(?:mbps|mb\/s|ᴹᵇᵖˢ)/i, "")
    .replace(/\s*[•|·]\s*[•|·]\s*/g, " • ")
    .replace(/^\s*[•|·]\s*/, "")
    .replace(/\s*[•|·]\s*$/, "")
    .trim();
}

// Addons often embed the file size in their bitrate line; strip it (plus one
// adjacent separator) so the prepended behaviorHints size isn't shown twice.
// The \b keeps "Mbps"/"GB/s" bitrate tokens intact.
function stripSizeTokenFromLine(line = "") {
  return String(line)
    .replace(/\d+(?:[.,]\d+)?\s*[KMGT]i?B\b(?!\/s)/i, "")
    .replace(/\s*[•|·]\s*[•|·]\s*/g, " • ")
    .replace(/^\s*[•|·]\s*/, "")
    .replace(/\s*[•|·]\s*$/, "")
    .trim();
}

// Aggregators encode a provider tier as a run of star glyphs in the stream name
// ("Library ★★☆", "Sootio ★★★★★"). The rank is genuinely useful, the glyphs are
// not: they arrive in inconsistent fonts, sit in the middle of the title, and
// several addons emit only filled stars so the run reads as decoration rather
// than a value. Parsed out here and shown as a rank chip in the meta strip.
const STAR_RUN_PATTERN = /[\u2605\u2606\u2B50\u2730\u2729]+/g;

function extractStarRating(text = "") {
  const runs = String(text || "").match(STAR_RUN_PATTERN);
  if (!runs || !runs.length) {
    return null;
  }
  // Longest run wins — an addon that stamps a star elsewhere in the blob should
  // not outvote the actual rating.
  const run = runs.reduce((best, entry) => (entry.length > best.length ? entry : best), "");
  const filled = (run.match(/[\u2605\u2B50\u2730]/g) || []).length;
  const empty = (run.match(/[\u2606\u2729]/g) || []).length;
  if (!filled && !empty) {
    return null;
  }
  // Only when the addon spells out the empty stars is the maximum knowable —
  // "★★" alone could be 2 of 2 or 2 of 5, so the chip states the rank plainly
  // rather than inventing a denominator.
  return { filled, total: empty ? filled + empty : 0 };
}

// Rank on a 1-5 scale so the chip can be coloured by tier. When the addon spells
// out its maximum the rank is normalised against it (2 of 3 is a mid tier, not a
// low one); when it does not, the filled count is the rank.
function starRatingLevel(rating) {
  if (!rating || !rating.filled) {
    return 0;
  }
  const level = rating.total
    ? Math.round((rating.filled / rating.total) * 5)
    : rating.filled;
  return Math.min(5, Math.max(1, level));
}

function formatStarRating(rating) {
  if (!rating || !rating.filled) {
    return "";
  }
  return rating.total ? `${rating.filled}/${rating.total}` : String(rating.filled);
}

// Cache state is a chip in the meta row now (renderCacheChip), so the addon's
// own "Cached" / "Not cached" / "⚡" wording comes out of the headline — left
// in, the row states it twice in two different visual languages. Leading and
// trailing separators the cut leaves behind go with it.
function stripCacheTokens(value = "") {
  return String(value)
    .replace(/\[?\s*(?:not\s*)?cached\s*\]?/gi, " ")
    .replace(/[⚡✅❌]/g, " ")
    .replace(STAR_RUN_PATTERN, " ")
    // Invisible format characters — zero-width joiners, word joiners, and the
    // U+2060..U+2064 "invisible operator" block that several addons sprinkle
    // through their text. String.trim() does not touch them (they are Cf, not
    // White_Space), so a line reduced to nothing but these still passed the
    // is-it-empty check and rendered as a blank 26px row between the title and
    // the meta strip. Measured on device: that row was the "big vertical gap".
    .replace(/[\u00AD\u200B-\u200F\u2060-\u2064\u206A-\u206F\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^\s*[•|·\-–]\s*/, "")
    .replace(/\s*[•|·\-–]\s*$/, "")
    .trim();
}

function renderStreamHeadline(headline) {
  return escapeHtml(stripCacheTokens(headline));
}

// Bolt + "Instant", the same flag and the same string as the player's sources
// panel (t("stream_cached")) — this is the one thing on a row worth reading at
// a glance, and it must read identically on both screens.
function renderCacheChip(stream = {}) {
  const text = String([
    stream.name || "",
    stream.title || "",
    stream.description || ""
  ].join(" "));
  if (NOT_CACHED_TEXT_PATTERN.test(text)) {
    return `<span class="stream-route-cache-chip not-cached">${NOT_CACHED_ICON_SVG}${escapeHtml(t("stream_not_cached", {}, "Not cached"))}</span>`;
  }
  if (CACHED_TEXT_PATTERN.test(text) || /⚡/.test(text)) {
    return `<span class="stream-route-cache-chip cached">${CACHED_ICON_SVG}${escapeHtml(t("stream_cached", {}, "Instant"))}</span>`;
  }
  return "";
}

function getStreamQuality(stream = {}) {
  const qualityLines = [];
  [stream.name, stream.title, stream.description].forEach((value) => {
    String(value || "").split(/\r?\n/).forEach((line) => {
      const normalized = String(line || "").trim();
      if (normalized) {
        qualityLines.push(normalized);
      }
    });
  });
  const qualityCandidate = qualityLines.find((line, index) => index > 0 && /(2160|4k|1080|720|480)/i.test(line));
  if (qualityCandidate) {
    return qualityCandidate;
  }
  return detectQuality([
    stream.name || "",
    stream.title || "",
    stream.description || "",
    stream.behaviorHints?.filename || "",
    stream.sourceType || ""
  ].join(" "));
}

function isMetaNoiseLine(line = "") {
  const value = String(line || "").trim();
  if (!value) {
    return true;
  }
  if (/[👤💾⚙🧲]/u.test(value)) {
    return true;
  }
  if (/(?:thepiratebay|torrentio|torbox|1337x|rarbg|yts|eztv|orion)/i.test(value) && /\b\d+(?:\.\d+)?\s*(?:mb|gb|tb)\b/i.test(value)) {
    return true;
  }
  if (/\b(?:seed(?:ers?)?|peers?)\b/i.test(value) && /\b\d+(?:\.\d+)?\s*(?:mb|gb|tb)\b/i.test(value)) {
    return true;
  }
  return false;
}

function getStreamDescriptionLines(stream = {}) {
  const candidates = [
    stream.name,
    stream.description,
    stream.title,
    stream.behaviorHints?.filename
  ].reduce((items, value) => {
    String(value || "").split(/\r?\n/).forEach((line) => {
      const normalized = String(line || "").trim();
      if (normalized) {
        items.push(normalized);
      }
    });
    return items;
  }, []);
  const unique = [];
  candidates.forEach((value) => {
    if (!unique.some((entry) => entry.toLowerCase() === value.toLowerCase())) {
      unique.push(value);
    }
  });
  const headline = getStreamHeadline(stream).toLowerCase();
  const quality = getStreamQuality(stream).toLowerCase();
  return unique
    .filter((entry) => {
      const normalized = entry.toLowerCase();
      return normalized !== headline && normalized !== quality && !isMetaNoiseLine(entry);
    })
    .slice(0, 2);
}

function normalizeBadgeText(value = "") {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function toBadgeArray(value) {
  return Array.isArray(value)
    ? value.map(normalizeBadgeText).filter(Boolean)
    : [normalizeBadgeText(value)].filter(Boolean);
}

function uniquePushBadge(badges, seen, label, type = "default") {
  const text = normalizeBadgeText(label);
  if (!text) {
    return;
  }
  const key = text.toLowerCase();
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  badges.push({ label: text, type });
}

function parsedStreamDetails(stream = {}) {
  const resolve = stream.clientResolve || stream.raw?.clientResolve || {};
  const raw = resolve.stream?.raw || {};
  return raw.parsed || {};
}

function normalizeCodecBadge(value = "") {
  const normalized = normalizeBadgeText(value).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!normalized) return "";
  if (normalized === "av1") return "AV1";
  if (["hevc", "h265", "x265"].includes(normalized)) return "HEVC";
  if (["avc", "h264", "x264"].includes(normalized)) return "AVC";
  return normalizeBadgeText(value).toUpperCase();
}

const LANGUAGE_BADGE_ALIASES = {
  en: "🇬🇧",
  eng: "🇬🇧",
  english: "🇬🇧",
  hi: "🇮🇳",
  hin: "🇮🇳",
  hindi: "🇮🇳",
  it: "🇮🇹",
  ita: "🇮🇹",
  italian: "🇮🇹",
  es: "🇪🇸",
  spa: "🇪🇸",
  spanish: "🇪🇸",
  fr: "🇫🇷",
  fra: "🇫🇷",
  fre: "🇫🇷",
  french: "🇫🇷",
  de: "🇩🇪",
  deu: "🇩🇪",
  ger: "🇩🇪",
  german: "🇩🇪",
  pt: "🇵🇹",
  por: "🇵🇹",
  portuguese: "🇵🇹",
  "pt-br": "🇧🇷",
  ptbr: "🇧🇷",
  br: "🇧🇷",
  brazilian: "🇧🇷",
  "brazilian portuguese": "🇧🇷",
  pl: "🇵🇱",
  polish: "🇵🇱",
  cs: "🇨🇿",
  czech: "🇨🇿",
  la: "LAT",
  latino: "LAT",
  ja: "🇯🇵",
  jpn: "🇯🇵",
  japanese: "🇯🇵",
  ko: "🇰🇷",
  kor: "🇰🇷",
  korean: "🇰🇷",
  zh: "🇨🇳",
  chinese: "🇨🇳",
  multi: "Multi"
};

function languageBadge(value = "") {
  const text = normalizeBadgeText(value);
  const normalized = text.toLowerCase();
  const compact = normalized.replace(/[^a-z0-9]/g, "");
  return LANGUAGE_BADGE_ALIASES[normalized] || LANGUAGE_BADGE_ALIASES[compact] || text;
}

function fallbackLanguagesFromText(text = "") {
  const value = String(text || "");
  const matches = [];
  const pushMatch = (label) => {
    if (label && !matches.includes(label)) {
      matches.push(label);
    }
  };
  if (/(^|[^a-z0-9])(pt[\s._-]?br|brazilian[\s._-]?portuguese)([^a-z0-9]|$)/i.test(value)) pushMatch("pt-br");
  if (/(^|[^a-z0-9])(en|eng|english)([^a-z0-9]|$)/i.test(value)) pushMatch("en");
  if (/(^|[^a-z0-9])(pt|por|portuguese)([^a-z0-9]|$)/i.test(value) && !matches.includes("pt-br")) pushMatch("pt");
  if (/(^|[^a-z0-9])(it|ita|italian)([^a-z0-9]|$)/i.test(value)) pushMatch("it");
  if (/(^|[^a-z0-9])(es|spa|spanish)([^a-z0-9]|$)/i.test(value)) pushMatch("es");
  if (/(^|[^a-z0-9])(fr|fra|fre|french)([^a-z0-9]|$)/i.test(value)) pushMatch("fr");
  if (/(^|[^a-z0-9])(de|deu|ger|german)([^a-z0-9]|$)/i.test(value)) pushMatch("de");
  if (/(^|[^a-z0-9])(multi|multilang|multi[\s._-]?audio)([^a-z0-9]|$)/i.test(value)) pushMatch("multi");
  return matches;
}

function fallbackPresentationFromText(stream = {}) {
  const parsed = parsedStreamDetails(stream);
  const text = [
    stream.name,
    stream.title,
    stream.description,
    stream.behaviorHints?.filename,
    stream.sourceType,
    ...(Array.isArray(parsed.languages) ? parsed.languages : [])
  ].filter(Boolean).join(" ");
  const visualTags = [];
  if (/\b(dolby[ ._-]?vision|dovi|dv)\b/i.test(text)) visualTags.push("DV");
  if (/\bhdr10\+|hdr10plus\b/i.test(text)) visualTags.push("HDR10+");
  else if (/\bhdr10\b/i.test(text)) visualTags.push("HDR10");
  else if (/\bhdr\b/i.test(text)) visualTags.push("HDR");
  if (/\bhlg\b/i.test(text)) visualTags.push("HLG");
  if (/\b10\s?bit\b/i.test(text)) visualTags.push("10bit");
  if (/\bimax\b/i.test(text)) visualTags.push("IMAX");
  const audioTags = [];
  if (/\batmos\b/i.test(text)) audioTags.push("Atmos");
  if (/\b(truehd|true hd)\b/i.test(text)) audioTags.push("TrueHD");
  if (/\bdts[\s._-]?x\b/i.test(text)) audioTags.push("DTS:X");
  if (/\bdts[\s._-]?hd\b/i.test(text)) audioTags.push("DTS-HD");
  if (/\bddp|dd\+|dolby digital plus\b/i.test(text)) audioTags.push("DD+");
  if (/\baac\b/i.test(text)) audioTags.push("AAC");
  const audioChannels = [];
  const channelMatch = text.match(/\b([257]\.1|6\.1|2\.0)\b/);
  if (channelMatch) audioChannels.push(channelMatch[1]);
  const codec = /\b(av1|hevc|h\.?265|x265|avc|h\.?264|x264)\b/i.exec(text)?.[1] || "";
  return {
    resolution: detectQuality(text),
    quality: "",
    visualTags,
    encode: normalizeCodecBadge(codec),
    audioTags,
    audioChannels,
    languages: fallbackLanguagesFromText(text),
    size: stream.behaviorHints?.videoSize || 0
  };
}

function getStreamPresentation(stream = {}) {
  const parsed = parsedStreamDetails(stream);
  const presentation = stream.streamPresentation || stream.raw?.streamPresentation || {};
  const fallback = fallbackPresentationFromText(stream);
  const visualTags = toBadgeArray(presentation.visualTags?.length ? presentation.visualTags : parsed.hdr);
  const audioTags = toBadgeArray(presentation.audioTags?.length ? presentation.audioTags : parsed.audio);
  const audioChannels = toBadgeArray(presentation.audioChannels?.length ? presentation.audioChannels : parsed.channels);
  const languages = toBadgeArray(presentation.languages?.length ? presentation.languages : parsed.languages);
  const languageEmojis = toBadgeArray(presentation.languageEmojis?.length ? presentation.languageEmojis : []);
  const resolvedLanguages = languages.length ? languages : fallback.languages;
  return {
    resolution: presentation.resolution || parsed.resolution || fallback.resolution,
    quality: presentation.quality || parsed.quality || fallback.quality,
    visualTags: visualTags.length ? visualTags : fallback.visualTags,
    encode: normalizeCodecBadge(presentation.encode || parsed.codec || fallback.encode),
    audioTags: audioTags.length ? audioTags : fallback.audioTags,
    audioChannels: audioChannels.length ? audioChannels : fallback.audioChannels,
    languages: resolvedLanguages,
    languageEmojis: languageEmojis.length ? languageEmojis : resolvedLanguages.map(languageBadge).filter(Boolean),
    size: presentation.size || stream.behaviorHints?.videoSize || fallback.size,
    cached: presentation.cached,
    serviceShortName: presentation.serviceShortName || ""
  };
}

function buildLegacyStreamBadges(stream = {}, enabled = true, includeSizeBadge = true) {
  if (!enabled) {
    return [];
  }
  const presentation = getStreamPresentation(stream);
  const badges = [];
  const seen = new Set();
  const quality = normalizeBadgeText(presentation.resolution && presentation.resolution !== "Auto" ? presentation.resolution : getStreamQuality(stream));
  uniquePushBadge(badges, seen, quality, "quality");
  uniquePushBadge(badges, seen, presentation.quality, "quality");
  toBadgeArray(presentation.visualTags).slice(0, 3).forEach((tag) => uniquePushBadge(badges, seen, tag, "visual"));
  uniquePushBadge(badges, seen, presentation.encode, "codec");
  toBadgeArray(presentation.languageEmojis).slice(0, 4).forEach((tag) => uniquePushBadge(badges, seen, tag, "language"));
  toBadgeArray(presentation.audioTags).slice(0, 3).forEach((tag) => uniquePushBadge(badges, seen, tag, "audio"));
  toBadgeArray(presentation.audioChannels).slice(0, 1).forEach((tag) => uniquePushBadge(badges, seen, tag, "audio"));
  if (includeSizeBadge) {
    uniquePushBadge(badges, seen, formatBytes(presentation.size), "size");
  }
  if (presentation.cached === true && presentation.serviceShortName) {
    uniquePushBadge(badges, seen, presentation.serviceShortName, "service");
  }
  return badges.slice(0, STREAM_BADGE_LIMIT);
}

function renderImageBadgeChip(badge = {}) {
  const imageUrl = normalizeAddonLogoUrl(badge.imageURL);
  let displayImageUrl = getCachedAddonLogoDisplayUrl(imageUrl);
  if (imageUrl && !displayImageUrl && !failedAddonLogoUrls.has(imageUrl)) {
    requestAddonLogo(imageUrl);
    if (Environment.isWebOS()) {
      displayImageUrl = getCachedAddonLogoDisplayUrl(imageUrl);
    }
  }
  const backgroundColor = normalizeStreamBadgeChipColor(badge.tagColor);
  const outlineColor = normalizeStreamBadgeChipColor(badge.borderColor);
  const textColor = normalizeStreamBadgeChipColor(badge.textColor);
  const filled = String(badge.tagStyle || "").trim().toLowerCase() === "filled";
  const fallbackImageUrl = Environment.isWebOS() ? "" : imageUrl;
  const safeImageUrl = displayImageUrl || fallbackImageUrl;
  const style = [
    filled && backgroundColor ? `background:${backgroundColor};` : "",
    outlineColor ? `border-color:${outlineColor};` : "",
    textColor ? `color:${textColor};` : ""
  ].join("");
  return `
    <span class="stream-route-stream-badge image${filled ? " filled" : ""}"${style ? ` style="${escapeHtml(style)}"` : ""}>
      ${safeImageUrl
        ? `<img src="${escapeHtml(safeImageUrl)}" alt="${escapeHtml(badge.name || "")}" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`
        : ""}
    </span>
  `;
}

function renderImportedStreamBadgeChips(stream = {}, badges = [], showFileSizeBadges = true) {
  const sizeBytes = stream.behaviorHints?.videoSize;
  const chips = [];
  if (showFileSizeBadges && sizeBytes != null) {
    chips.push(`<span class="stream-route-stream-badge size">${escapeHtml(t("streams_size", [formatBytes(sizeBytes)], `SIZE ${formatBytes(sizeBytes)}`))}</span>`);
  }
  badges.slice(0, STREAM_BADGE_LIMIT).forEach((badge) => {
    chips.push(renderImageBadgeChip(badge));
  });
  return chips.length
    ? `<div class="stream-route-card-badges" aria-label="${escapeHtml(t("settings_stream_badges_section", {}, "Fusion Style"))}">${chips.join("")}</div>`
    : "";
}

function renderStreamBadges(stream = {}, enabled = true, badgeSettings = null) {
  const currentBadgeSettings = badgeSettings || StreamBadgeSettingsStore.snapshot();
  const importedBadges = matchStreamBadges(stream, currentBadgeSettings.rules);
  if (importedBadges.length) {
    return renderImportedStreamBadgeChips(stream, importedBadges, currentBadgeSettings.showFileSizeBadges !== false);
  }

  const badges = buildLegacyStreamBadges(stream, enabled, currentBadgeSettings.showFileSizeBadges !== false);
  if (!badges.length) {
    return "";
  }
  return `
    <div class="stream-route-card-badges" aria-label="${escapeHtml(t("settings.integration.debrid.streamBadges.title", {}, "Stream badges"))}">
      ${badges.map((badge) => `<span class="stream-route-stream-badge ${escapeHtml(badge.type)}">${escapeHtml(badge.label)}</span>`).join("")}
    </div>
  `;
}

function resolveStreamBadgePlacement(badgeSettings = null) {
  const placement = String((badgeSettings || StreamBadgeSettingsStore.snapshot()).badgePlacement || "BOTTOM").trim().toUpperCase();
  return placement === "TOP" ? "TOP" : "BOTTOM";
}

function getOrderedFilterNames(sourceChips = [], streams = []) {
  const ordered = [];
  const sortedChips = (sourceChips || [])
    .slice()
    .sort((left, right) => Number(left?.orderIndex ?? Number.MAX_SAFE_INTEGER) - Number(right?.orderIndex ?? Number.MAX_SAFE_INTEGER));
  sortedChips.forEach((chip) => {
    if (chip?.name && !ordered.includes(chip.name)) {
      ordered.push(chip.name);
    }
  });
  const sortedStreams = (streams || [])
    .map((stream, index) => ({ stream, index }))
    .sort((left, right) => {
      const leftOrder = Number(left.stream?.addonOrderIndex ?? Number.MAX_SAFE_INTEGER);
      const rightOrder = Number(right.stream?.addonOrderIndex ?? Number.MAX_SAFE_INTEGER);
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.stream);
  sortedStreams.forEach((stream) => {
    const addonName = String(stream?.addonName || "").trim();
    if (addonName && !ordered.includes(addonName)) {
      ordered.push(addonName);
    }
  });
  return ordered;
}

function sortStreamsByAddonOrder(streams = [], sourceChips = []) {
  const order = new Map();
  (sourceChips || []).forEach((chip, index) => {
    const name = String(chip?.name || "").trim();
    if (name && !order.has(name)) {
      order.set(name, index);
    }
  });
  return (streams || [])
    .map((stream, index) => ({ stream, index }))
    .sort((left, right) => {
      const leftOrder = order.has(left.stream?.addonName)
        ? order.get(left.stream.addonName)
        : Number(left.stream?.addonOrderIndex ?? Number.MAX_SAFE_INTEGER);
      const rightOrder = order.has(right.stream?.addonName)
        ? order.get(right.stream.addonName)
        : Number(right.stream?.addonOrderIndex ?? Number.MAX_SAFE_INTEGER);
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.stream);
}

export const StreamScreen = {

  cancelScheduledRender() {
    if (this.renderDelayTimer) {
      clearTimeout(this.renderDelayTimer);
      this.renderDelayTimer = null;
    }
    if (this.renderFrame) {
      cancelAnimationFrame(this.renderFrame);
      this.renderFrame = null;
    }
  },

  requestRender({ delayMs = 0 } = {}) {
    if (!this.container || Router.getCurrent() !== "stream") {
      return;
    }
    const delay = Math.max(0, Number(delayMs || 0));
    if (delay > 0) {
      if (this.renderFrame || this.renderDelayTimer) {
        return;
      }
      this.renderDelayTimer = setTimeout(() => {
        this.renderDelayTimer = null;
        this.requestRender();
      }, delay);
      return;
    }
    if (this.renderFrame) {
      return;
    }
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = null;
      if (!this.container || Router.getCurrent() !== "stream") {
        return;
      }
      this.render();
    });
  },

  applyAddonLogos(streams = []) {
    const lookup = this.addonLogoLookup || {};
    return (streams || []).map((stream) => {
      const currentLogo = normalizeAddonLogoUrl(stream?.addonLogo);
      if (currentLogo) {
        return stream;
      }
      const addonLogo = resolveAddonLogo(stream?.addonName, lookup);
      return addonLogo ? { ...stream, addonLogo } : stream;
    });
  },

  scheduleDebridPreparation() {
    const token = this.loadToken || 0;
    if (this.debridPreparationScheduled) {
      return;
    }
    this.debridPreparationScheduled = true;
    setTimeout(() => {
      this.debridPreparationScheduled = false;
      if (!this.container || Router.getCurrent() !== "stream" || token !== this.loadToken) {
        return;
      }
      const season = this.params?.season == null ? null : Number(this.params.season);
      const episode = this.params?.episode == null ? null : Number(this.params.episode);
      void DirectDebridStreamPreparer.prepare(this.streams, {
        season,
        episode,
        onPrepared: (original, prepared) => {
          if (!this.container || Router.getCurrent() !== "stream" || token !== this.loadToken) {
            return;
          }
          const keyFor = (stream) => [
            stream.clientResolve?.service || "",
            stream.clientResolve?.infoHash || stream.infoHash || "",
            stream.clientResolve?.fileIdx ?? stream.fileIdx ?? "",
            stream.clientResolve?.filename || stream.behaviorHints?.filename || "",
            stream.name || "",
            stream.title || ""
          ].join("|");
          const originalKey = keyFor(original);
          this.streams = this.streams.map((stream) => (
            keyFor(stream) === originalKey ? { ...stream, ...prepared } : stream
          ));
          this.requestRender();
        }
      });
    }, 0);
  },

  // Continue Watching opens this screen directly so the source requests start on the very
  // first frame instead of queueing behind a detail-screen metadata fetch. The parts of the
  // metadata only the player needs — the episode list for next-up, the imdb id — are pulled
  // alongside the sources and merged in here. Nothing the shell renders is touched, so
  // hydrating never repaints; playStream waits on this before handing off.
  async hydrateStreamMetaParams() {
    const token = this.loadToken;
    const itemId = String(this.params?.itemId || "").trim();
    const itemType = normalizeType(this.params?.itemType);
    if (!itemId) {
      return;
    }
    let meta = null;
    try {
      const result = await metaRepository.getMetaFromAllAddons(itemType, itemId);
      meta = result?.status === "success" ? result.data : null;
    } catch (error) {
      console.warn("Stream meta hydration failed", error);
    }
    if (!meta || token !== this.loadToken || Router.getCurrent() !== "stream") {
      return;
    }
    const episodes = normalizeEpisodes(meta?.videos || []);
    const currentVideoId = String(this.params?.videoId || "");
    const currentIndex = episodes.findIndex((entry) => String(entry?.id || "") === currentVideoId);
    const nextEpisode = currentIndex >= 0 ? (episodes[currentIndex + 1] || null) : null;
    this.params = {
      ...this.params,
      imdbId: this.params?.imdbId || resolveImdbIdFromMeta(meta, this.params),
      parentalWarnings: this.params?.parentalWarnings || meta?.parentalWarnings || null,
      parentalGuide: this.params?.parentalGuide || meta?.parentalGuide || null,
      episodes,
      nextEpisodeVideoId: nextEpisode?.id || null,
      nextEpisodeLabel: nextEpisode ? `S${nextEpisode.season}E${nextEpisode.episode}` : null,
      nextEpisodeSeason: nextEpisode?.season ?? null,
      nextEpisodeEpisode: nextEpisode?.episode ?? null,
      nextEpisodeTitle: nextEpisode?.title || "",
      nextEpisodeReleased: nextEpisode?.released || ""
    };
  },

  getBackdropUrl() {
    return this.params?.backdrop || this.params?.landscapePoster || this.params?.poster || "";
  },

  getRouteStateKey(params = {}) {
    const itemType = normalizeType(params?.itemType);
    const itemId = String(params?.itemId || "").trim();
    const videoId = String(params?.videoId || "").trim();
    if (!itemId && !videoId) {
      return null;
    }
    return `stream:${itemType}:${itemId}:${videoId}`;
  },

  navigateBackFromStream() {
    const itemId = String(this.params?.itemId || "").trim();
    if (!itemId) {
      return false;
    }
    void Router.navigate("detail", {
      itemId,
      itemType: normalizeType(this.params?.itemType),
      fallbackTitle: this.params?.itemTitle || this.params?.playerTitle || "Untitled",
      returnHomeOnBack: Boolean(
        this.params?.continueWatchingBackHome
        || this.params?.returnHomeOnBack
        || this.params?.returnToDetail
        || this.params?.fromDetailRoute
      )
    }, {
      skipStackPush: true,
      replaceHistory: true
    });
    return true;
  },

  consumeBackRequest() {
    return this.navigateBackFromStream();
  },

  captureRouteState() {
    const list = this.container?.querySelector(".stream-route-list");
    return {
      params: this.params ? { ...this.params } : {},
      loading: Boolean(this.loading),
      error: String(this.error || ""),
      streams: Array.isArray(this.streams) ? this.streams.map((stream) => ({ ...stream })) : [],
      addonFilter: String(this.addonFilter || "all"),
      focusState: this.focusState ? { ...this.focusState } : { zone: "filter", index: 0 },
      sourceChips: Array.isArray(this.sourceChips) ? this.sourceChips.map((chip) => ({ ...chip })) : [],
      addonLogoLookup: this.addonLogoLookup ? { ...this.addonLogoLookup } : {},
      listScrollTop: Number(list?.scrollTop || 0)
    };
  },

  async mount(params = {}, navigationContext = {}) {
    this.container = document.getElementById("stream");
    ScreenUtils.show(this.container);
    this.params = params || {};
    this.loadToken = (this.loadToken || 0) + 1;
    this.focusState = { zone: "filter", index: 0 };
    this.listScrollTop = 0;
    this.error = "";
    this.loading = true;
    this.streams = [];
    this.sourceChips = [];
    this.addonLogoLookup = {};
    this.addonFilter = "all";
    this.hasRenderedStreamRouteShell = false;
    // ScreenUtils.hide() empties the container on cleanup, so nothing rendered survives a
    // remount — the diff caches have to start empty or the first render would skip work
    // whose DOM is already gone.
    this.resetRenderCaches();
    this.autoPlayAttempted = false;
    this.cancelAutoPlayCountdown();
    if (this.releaseImageProxyReadyListener) {
      this.releaseImageProxyReadyListener();
      this.releaseImageProxyReadyListener = null;
    }
    if (Environment.isWebOS()) {
      this.releaseImageProxyReadyListener = onWebOsImageProxyReady(() => {
        failedAddonLogoUrls.clear();
        this.requestRender({ delayMs: 0 });
      });
    }
    this.metaHydrationPromise = null;

    const restored = navigationContext?.restoredState && typeof navigationContext.restoredState === "object"
      ? navigationContext.restoredState
      : null;
    if (restored) {
      this.loading = Boolean(restored.loading);
      this.error = String(restored.error || "");
      this.streams = Array.isArray(restored.streams) ? restored.streams.map((stream) => ({ ...stream })) : [];
      this.addonFilter = String(restored.addonFilter || "all");
      this.focusState = restored.focusState ? { ...restored.focusState } : { zone: "filter", index: 0 };
      this.sourceChips = Array.isArray(restored.sourceChips) ? restored.sourceChips.map((chip) => ({ ...chip })) : [];
      this.addonLogoLookup = restored.addonLogoLookup && typeof restored.addonLogoLookup === "object"
        ? { ...restored.addonLogoLookup }
        : {};
      this.listScrollTop = Number(restored.listScrollTop || 0);
    }

    this.render();

    if (restored && navigationContext?.isBackNavigation && this.streams.length) {
      this.loading = false;
      this.render();
      return;
    }

    // The shell above is all the first frame needs. Everything below — the webOS image
    // proxy handshake, the addon fan-out, the metadata hydration — used to run inside the
    // same task as the key press, which is what made opening this screen feel like a freeze
    // rather than a transition. Deferring past the first paint costs a frame and buys back
    // ~80ms of blocked main thread.
    const mountToken = this.loadToken;
    afterNextPaint(() => {
      if (!this.container || Router.getCurrent() !== "stream" || mountToken !== this.loadToken) {
        return;
      }
      if (Environment.isWebOS()) {
        void ensureWebOsImageProxyReady();
      }
      this.metaHydrationPromise = this.params?.hydrateMetaOnStream
        ? this.hydrateStreamMetaParams()
        : null;
      void this.loadStreams();
    });
  },

  async loadStreams() {
    const token = this.loadToken;
    const itemType = normalizeType(this.params?.itemType);
    const videoId = String(this.params?.videoId || this.params?.itemId || "");

    this.loading = true;
    this.error = "";
    this.streams = [];
    this.addonFilter = "all";
    this.focusState = { zone: "filter", index: 0 };
    this.listScrollTop = 0;
    this.addonLogoLookup = {};
    this.hasRenderedStreamRouteShell = false;

    this.sourceChips = [];
    this.requestRender();
    const pendingChunkTasks = new Set();
    const badgeSettings = StreamBadgeSettingsStore.snapshot();

    const upsertSourceChip = (addon, status = "loading") => {
      const name = String(addon?.displayName || addon?.name || "").trim();
      if (!name) {
        return;
      }
      const orderIndex = Number(addon?.orderIndex);
      const nextChip = {
        name,
        logo: normalizeAddonLogoUrl(addon.logo),
        status,
        orderIndex: Number.isFinite(orderIndex) ? orderIndex : Number.MAX_SAFE_INTEGER
      };
      const existingIndex = this.sourceChips.findIndex((chip) => chip.name === name);
      if (existingIndex >= 0) {
        this.sourceChips[existingIndex] = { ...this.sourceChips[existingIndex], ...nextChip };
      } else {
        this.sourceChips.push(nextChip);
      }
      this.addonLogoLookup[name] = nextChip.logo;
      this.sourceChips = this.sourceChips
        .slice()
        .sort((left, right) => Number(left.orderIndex || 0) - Number(right.orderIndex || 0));
    };

    const markSuccessfulSources = (names = []) => {
      if (!Array.isArray(names) || !names.length) {
        return;
      }
      const entries = names
        .map((entry) => {
          if (entry && typeof entry === "object") {
            return {
              name: String(entry.name || entry.addonName || "").trim(),
              logo: normalizeAddonLogoUrl(entry.logo || entry.addonLogo),
              orderIndex: Number(entry.orderIndex ?? entry.addonOrderIndex)
            };
          }
          const name = String(entry || "").trim();
          const existingStream = this.streams.find((stream) => stream.addonName === name);
          return {
            name,
            logo: resolveAddonLogo(name, this.addonLogoLookup),
            orderIndex: Number(existingStream?.addonOrderIndex)
          };
        })
        .filter((entry) => entry.name);
      const successSet = new Set(entries.map((entry) => entry.name));
      const known = new Set(this.sourceChips.map((chip) => chip.name));
      this.sourceChips = this.sourceChips.map((chip) => (
        successSet.has(chip.name) ? { ...chip, status: "success" } : chip
      ));
      entries.forEach((entry) => {
        if (!known.has(entry.name)) {
          const orderIndex = Number.isFinite(entry.orderIndex) ? entry.orderIndex : Number.MAX_SAFE_INTEGER;
          this.sourceChips.push({
            name: entry.name,
            logo: entry.logo || resolveAddonLogo(entry.name, this.addonLogoLookup),
            status: "success",
            orderIndex
          });
        }
      });
      this.sourceChips = this.sourceChips
        .slice()
        .sort((left, right) => Number(left.orderIndex ?? Number.MAX_SAFE_INTEGER) - Number(right.orderIndex ?? Number.MAX_SAFE_INTEGER));
    };

    const displayChunkGroups = async (groups = []) => {
      if (token !== this.loadToken) {
        return;
      }
      const chunkStreams = mergeStreamItems(
        [],
        this.applyAddonLogos(flattenStreams({ status: "success", data: groups }))
      );
      if (!chunkStreams.length) {
        return;
      }
      const hadStreams = this.streams.length > 0;
      // Badge artwork is worth a beat so chips don't pop in, but never worth
      // holding the first sources off screen — the card render re-requests any
      // image that missed the window and this repaints once it lands.
      const badgePreload = preloadMatchedStreamBadgeImages(chunkStreams, badgeSettings);
      badgePreload
        .then(() => {
          if (token === this.loadToken) {
            this.requestRender({ delayMs: 120 });
          }
        })
        .catch(() => {});
      await Promise.race([badgePreload, waitMs(BADGE_PRELOAD_MAX_WAIT_MS)]);
      if (token !== this.loadToken) {
        return;
      }
      this.streams = mergeStreamItems(this.streams, chunkStreams);
      this.scheduleDebridPreparation();
      markSuccessfulSources(groups.map((group) => ({
        name: group?.addonName || "",
        logo: group?.addonLogo || "",
        orderIndex: group?.addonOrderIndex
      })));
      if (this.streams.length && this.focusState?.zone !== "card") {
        this.focusState = { zone: "card", index: 0 };
      }
      // The first sources to arrive paint on the next frame; later chunks are
      // batched so a burst of addons doesn't render five times in a row.
      this.requestRender({ delayMs: hadStreams ? 120 : 0 });
    };

    const queueChunkGroups = (groups = []) => {
      const task = displayChunkGroups(groups)
        .catch((error) => {
          console.warn("Stream chunk prerender failed", error);
        })
        .finally(() => {
          pendingChunkTasks.delete(task);
        });
      pendingChunkTasks.add(task);
      return task;
    };

    const options = {
      itemId: String(this.params?.itemId || ""),
      season: this.params?.season ?? null,
      episode: this.params?.episode ?? null,
      onAddon: (addon) => {
        if (token !== this.loadToken) {
          return;
        }
        upsertSourceChip(addon, "loading");
        this.requestRender({ delayMs: 120 });
      },
      onChunk: (chunkResult) => {
        if (token !== this.loadToken || chunkResult?.status !== "success") {
          return;
        }
        const groups = Array.isArray(chunkResult.data) ? chunkResult.data : [];
        queueChunkGroups(groups);
      }
    };

    try {
      const streamResult = await streamRepository.getStreamsFromAllAddons(itemType, videoId, options);
      if (token !== this.loadToken) {
        return;
      }
      const loadedStreams = mergeStreamItems([], this.applyAddonLogos(flattenStreams(streamResult)));
      await Promise.allSettled(Array.from(pendingChunkTasks));
      if (token !== this.loadToken) {
        return;
      }
      const existingKeys = new Set(this.streams.map((stream) => streamMergeKey(stream)).filter(Boolean));
      const missingStreams = loadedStreams.filter((stream) => {
        const key = streamMergeKey(stream);
        return key && !existingKeys.has(key);
      });
      if (missingStreams.length) {
        const badgePreload = preloadMatchedStreamBadgeImages(missingStreams, badgeSettings);
        badgePreload
          .then(() => {
            if (token === this.loadToken) {
              this.requestRender({ delayMs: 120 });
            }
          })
          .catch(() => {});
        await Promise.race([badgePreload, waitMs(BADGE_PRELOAD_MAX_WAIT_MS)]);
        if (token !== this.loadToken) {
          return;
        }
        this.streams = mergeStreamItems(this.streams, missingStreams);
      }
      this.scheduleDebridPreparation();
      markSuccessfulSources(this.streams.map((stream) => stream.addonName));
      this.sourceChips = this.sourceChips.map((chip) => (
        chip.status === "loading" ? { ...chip, status: "error" } : chip
      ));
      this.loading = false;
      if (this.streams.length) {
        this.focusState = { zone: "card", index: clamp(Number(this.focusState?.index || 0), 0, this.streams.length - 1) };
      } else {
        this.focusState = { zone: "filter", index: 0 };
      }
      this.requestRender();
      this.scheduleErrorChipCleanup();
      this.maybeAutoPlayStream();
    } catch (error) {
      if (token !== this.loadToken) {
        return;
      }
      this.loading = false;
      this.error = error?.message || "Failed to load streams.";
      this.sourceChips = this.sourceChips.map((chip) => (
        chip.status === "loading" ? { ...chip, status: "error" } : chip
      ));
      this.requestRender();
      this.scheduleErrorChipCleanup();
    }
  },

  scheduleErrorChipCleanup() {
    if (this.errorChipTimer) {
      clearTimeout(this.errorChipTimer);
      this.errorChipTimer = null;
    }
    if (!this.sourceChips.some((chip) => chip.status === "error")) {
      return;
    }
    this.errorChipTimer = setTimeout(() => {
      this.sourceChips = this.sourceChips.filter((chip) => chip.status !== "error");
      this.requestRender();
    }, 1600);
  },

  getOrderedFilterNames() {
    return getOrderedFilterNames(this.sourceChips, this.streams);
  },

  getFilteredStreams(filter = this.addonFilter) {
    const orderedStreams = sortStreamsByAddonOrder(this.streams, this.sourceChips);
    if (filter === "all") {
      return orderedStreams;
    }
    return orderedStreams.filter((stream) => stream.addonName === filter);
  },

  hasPendingSourceLoads(filter = this.addonFilter) {
    if (!Array.isArray(this.sourceChips) || !this.sourceChips.length) {
      return Boolean(this.loading);
    }
    if (filter === "all") {
      return this.sourceChips.some((chip) => chip.status === "loading");
    }
    return this.sourceChips.some((chip) => chip.name === filter && chip.status === "loading");
  },

  setAddonFilter(nextFilter, preferredZone = "filter", preferredIndex = 0) {
    const targetFilter = String(nextFilter || "all");
    this.addonFilter = targetFilter;
    const filtered = this.getFilteredStreams(targetFilter);
    if (preferredZone === "card" && filtered.length) {
      this.focusState = { zone: "card", index: clamp(preferredIndex, 0, filtered.length - 1) };
    } else {
      const ordered = ["all", ...this.getOrderedFilterNames()];
      this.focusState = { zone: "filter", index: clamp(ordered.indexOf(targetFilter), 0, Math.max(0, ordered.length - 1)) };
    }
    this.listScrollTop = 0;
    this.render();
  },

  focusList(list, index) {
    if (!Array.isArray(list) || !list.length) {
      return false;
    }
    const targetIndex = clamp(index, 0, list.length - 1);
    const target = list[targetIndex];
    if (!target) {
      return false;
    }
    this.container.querySelectorAll(".focusable").forEach((node) => node.classList.remove("focused"));
    target.classList.add("focused");
    try {
      target.focus({ preventScroll: true });
    } catch (_) {
      target.focus();
    }

    const chipTrack = target.closest(".stream-route-chip-track");
    if (chipTrack) {
      const left = target.offsetLeft;
      const right = left + target.offsetWidth;
      const viewLeft = chipTrack.scrollLeft;
      const viewRight = viewLeft + chipTrack.clientWidth;
      const pad = 24;
      if (right > viewRight - pad) {
        chipTrack.scrollLeft = Math.max(0, right - chipTrack.clientWidth + pad);
      } else if (left < viewLeft + pad) {
        chipTrack.scrollLeft = Math.max(0, left - pad);
      }
    }

    const listNode = target.closest(".stream-route-list");
    if (listNode) {
      this.ensureListItemVisible(listNode, target);
      this.listScrollTop = Number(listNode.scrollTop || 0);
      this.scheduleFocusedListItemVisibilityCheck(listNode, target);
    }
    return true;
  },

  setListScrollTop(listNode, nextScrollTop) {
    if (!listNode) {
      return;
    }
    const maxScrollTop = Math.max(0, Number(listNode.scrollHeight || 0) - Number(listNode.clientHeight || 0));
    const normalized = clamp(Number(nextScrollTop || 0), 0, maxScrollTop);
    listNode.scrollTop = normalized;
    if (typeof listNode.scrollTo === "function") {
      try {
        listNode.scrollTo(0, normalized);
      } catch (_) {
        listNode.scrollTop = normalized;
      }
    }
    this.listScrollTop = Number(listNode.scrollTop || normalized || 0);
  },

  ensureListItemVisible(listNode, target) {
    if (!listNode || !target) {
      return;
    }
    const viewTop = Number(listNode.scrollTop || 0);
    let itemTop = Number(target.offsetTop || 0);
    let itemBottom = itemTop + Number(target.offsetHeight || 0);
    if (typeof listNode.getBoundingClientRect === "function" && typeof target.getBoundingClientRect === "function") {
      const listRect = listNode.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      if (listRect && targetRect && Number.isFinite(targetRect.top) && Number.isFinite(listRect.top)) {
        itemTop = viewTop + (targetRect.top - listRect.top);
        itemBottom = viewTop + (targetRect.bottom - listRect.top);
      }
    }
    if (target.classList.contains("stream-route-card")) {
      const padTop = parseFloat(getComputedStyle(listNode).paddingTop) || 0;
      this.setListScrollTop(listNode, Math.max(0, itemTop - padTop));
      return;
    }
    const viewHeight = Number(listNode.clientHeight || 0);
    if (!viewHeight) {
      return;
    }
    const viewBottom = viewTop + viewHeight;
    const pad = 16;
    if (itemBottom > viewBottom - pad) {
      this.setListScrollTop(listNode, itemBottom - viewHeight + pad);
    } else if (itemTop < viewTop + pad) {
      this.setListScrollTop(listNode, itemTop - pad);
    }
  },

  scheduleFocusedListItemVisibilityCheck(listNode, target) {
    if (!listNode || !target) {
      return;
    }
    const run = () => {
      const root = document.documentElement || document.body;
      if (!this.container || !root?.contains?.(listNode) || !root?.contains?.(target)) {
        return;
      }
      this.ensureListItemVisible(listNode, target);
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(run);
      return;
    }
    setTimeout(run, 0);
  },

  getFocusLists() {
    const chips = Array.from(this.container.querySelectorAll(".stream-route-chip.focusable"));
    const cards = Array.from(this.container.querySelectorAll(".stream-route-card.focusable"));
    return { chips, cards };
  },

  applyFocus() {
    const { chips, cards } = this.getFocusLists();
    if (!chips.length && !cards.length) {
      return;
    }
    const zone = this.focusState?.zone || (cards.length ? "card" : "filter");
    const index = Number(this.focusState?.index || 0);
    if (zone === "card" && cards.length) {
      this.focusState = { zone: "card", index: clamp(index, 0, cards.length - 1) };
      this.focusList(cards, this.focusState.index);
      return;
    }
    this.focusState = { zone: "filter", index: clamp(index, 0, Math.max(0, chips.length - 1)) };
    this.focusList(chips, this.focusState.index);
  },

  restoreScrollPosition() {
    const list = this.container?.querySelector(".stream-route-list");
    if (!list) {
      return;
    }
    this.setListScrollTop(list, Number(this.listScrollTop || 0));
  },

  getHeaderMeta() {
    const isSeries = normalizeType(this.params?.itemType) === "series";
    const title = String(this.params?.itemTitle || this.params?.playerTitle || "Untitled");
    const subtitle = isSeries
      ? String(this.params?.episodeTitle || this.params?.playerSubtitle || "").trim()
      : String(this.params?.itemSubtitle || "").trim();
    const episodeLabel = normalizeEpisodeCode(this.params?.season, this.params?.episode);
    const detailLine = isSeries
      ? ""
      : [String(this.params?.genres || "").trim(), String(this.params?.year || "").trim()].filter(Boolean).join(" • ");
    return { isSeries, title, subtitle, episodeLabel, detailLine };
  },

  renderChip(name, selected, status) {
    const chipStatus = String(status || "success");
    const classes = [
      "stream-route-chip",
      "focusable",
      selected ? "selected" : "",
      chipStatus !== "success" ? chipStatus : ""
    ].filter(Boolean).join(" ");
    const spinner = chipStatus === "loading" ? '<span class="stream-route-chip-spinner" aria-hidden="true"></span>' : "";
    return `
      <button class="${classes}" data-action="setFilter" data-addon="${escapeHtml(name)}">
        ${spinner}
        <span>${escapeHtml(name === "all" ? t("common.all", {}, "All") : name)}</span>
      </button>
    `;
  },

  renderStreamCard(stream, index, streamBadgesEnabled = true, badgeSettings = null) {
    const headline = getStreamHeadline(stream);
    const quality = getStreamQuality(stream);
    const badges = renderStreamBadges(stream, streamBadgesEnabled, badgeSettings);
    const badgePlacement = resolveStreamBadgePlacement(badgeSettings);
    const topBadges = badgePlacement === "TOP" ? badges : "";
    const bottomBadges = badgePlacement === "BOTTOM" ? badges : "";
    const descriptionLines = getStreamDescriptionLines(stream);
    const sizeText = formatBytes(stream.behaviorHints?.videoSize);
    const bitrateText = getStreamBitrate(stream);
    // Instant, size and bitrate are the row's facts; they belong in one strip,
    // rendered by the same rules as the player's sources panel. Both are pulled
    // out of the description lines so nothing is stated twice — what is left of
    // a line after the cut still shows, and a line emptied by it drops out.
    const renderedDescriptionLines = descriptionLines
      .map((line) => escapeHtml(stripCacheTokens(stripBitrateTokenFromLine(stripSizeTokenFromLine(line)))))
      .filter((line) => line.trim());
    const addonLogoUrl = normalizeAddonLogoUrl(stream.addonLogo) || resolveAddonLogo(stream.addonName, this.addonLogoLookup);
    const cachedAddonLogoUrl = getCachedAddonLogoDisplayUrl(addonLogoUrl);
    let displayAddonLogoUrl = cachedAddonLogoUrl || "";
    if (addonLogoUrl && !displayAddonLogoUrl && !failedAddonLogoUrls.has(addonLogoUrl)) {
      requestAddonLogo(addonLogoUrl, () => this.requestRender({ delayMs: 160 }));
      if (Environment.isWebOS()) {
        displayAddonLogoUrl = getCachedAddonLogoDisplayUrl(addonLogoUrl);
      }
    }
    const addonBadgeLabel = escapeHtml(getAddonBadgeLabel(stream.addonName || ""));
    // Order matches the player's strip exactly: cache state, size, bitrate,
    // then peers (which the player has no equivalent for).
    const tierRating = extractStarRating([stream.name, stream.title].join(" "));
    const tierLabel = formatStarRating(tierRating);
    const tierLevel = starRatingLevel(tierRating);
    const meta = [
      renderCacheChip(stream),
      sizeText ? `<span class="stream-route-meta-item size">${SIZE_ICON_SVG}<span>${escapeHtml(sizeText)}</span></span>` : "",
      bitrateText ? `<span class="stream-route-meta-item is-plain"><span>${escapeHtml(bitrateText)}</span></span>` : "",
      renderMetaItem("peers", extractPeerCount(stream)),
      tierLabel
        ? `<span class="stream-route-meta-item is-tier is-tier-${tierLevel}"><span>${escapeHtml(t("stream_provider_tier", {}, "Tier"))} ${escapeHtml(tierLabel)}</span></span>`
        : ""
    ].filter(Boolean).join("");
    const isResolving = this.resolvingStreamId === stream.id;
    const resolvingLabel = this.resolvingStreamMode === "p2p"
      ? t("stream.p2p.resolving", {}, "Resolving P2P stream")
      : t("stream.debrid.resolving", {}, "Resolving Debrid stream");
    const addonLogoLoading = Environment.isWebOS() ? "eager" : "lazy";
    const addonBadge = displayAddonLogoUrl
      ? `<img src="${escapeHtml(displayAddonLogoUrl)}" alt="${escapeHtml(stream.addonName || "Addon")}" data-addon-logo="${escapeHtml(addonLogoUrl)}" decoding="async" loading="${addonLogoLoading}" referrerpolicy="no-referrer" /><span hidden>${addonBadgeLabel}</span>`
      : `<span>${addonBadgeLabel}</span>`;

    // No `focused` class here: the card markup is cached and diffed by stream id, so it
    // must not depend on focus state. applyFocus() stamps the ring in the same task, so
    // nothing paints in between.
    return `
      <article class="stream-route-card focusable"
               data-action="playStream"
               data-stream-id="${escapeHtml(stream.id)}">
        <div class="stream-route-card-copy">
          ${topBadges || ""}
          <div class="stream-route-card-heading">${renderStreamHeadline(headline)}</div>
          ${!badges ? `<div class="stream-route-card-quality">${escapeHtml(quality)}</div>` : ""}
          ${renderedDescriptionLines.map((line, lineIndex) => `<div class="stream-route-card-line${lineIndex < renderedDescriptionLines.length - 1 ? " secondary" : ""}">${line}</div>`).join("")}
          ${meta ? `<div class="stream-route-card-meta">${meta}</div>` : ""}
          ${bottomBadges || ""}
        </div>
      </article>
    `;
  },

  renderLoadingCards(count = 6) {
    const safeCount = Math.max(1, Number(count || 0));
    return Array.from({ length: safeCount }).map(() => `
      <div class="stream-route-card skeleton">
        <div class="stream-route-skeleton-badges">
          <div class="stream-route-skeleton-badge"></div>
          <div class="stream-route-skeleton-badge wide"></div>
          <div class="stream-route-skeleton-badge"></div>
          <div class="stream-route-skeleton-badge narrow"></div>
        </div>
        <div class="stream-route-skeleton-line title"></div>
        <div class="stream-route-skeleton-line secondary"></div>
      </div>
    `).join("");
  },

  // Everything outside the sources list — backdrop, gradients, title/logo block. Rebuilding
  // the shell means re-decoding the backdrop and the title logo and restarting the panel
  // enter animation, so it is keyed and only redone when one of its inputs actually changes.
  buildShellSignature() {
    const { isSeries, title, subtitle, episodeLabel, detailLine } = this.getHeaderMeta();
    return JSON.stringify([
      isSeries,
      title,
      subtitle,
      episodeLabel,
      detailLine,
      this.getBackdropUrl() || "",
      String(this.params?.logo || "")
    ]);
  },

  resetRenderCaches() {
    this.renderedShellSignature = null;
    this.renderedChipsHtml = null;
    this.renderedAutoPlayHtml = null;
    this.renderedListPlaceholderHtml = null;
    this.renderedListIsPlaceholder = false;
    this.renderedCardHtmlByKey = new Map();
    this.renderedAddonFilter = null;
  },

  buildChipsHtml() {
    return [
      this.renderChip("all", this.addonFilter === "all", "success"),
      ...this.getOrderedFilterNames().map((name) => {
        const chip = this.sourceChips.find((entry) => entry.name === name) || { name, status: "success" };
        return this.renderChip(name, this.addonFilter === name, chip.status);
      })
    ].join("");
  },

  updateChips() {
    const track = this.container?.querySelector(".stream-route-chip-track");
    if (!track) {
      return;
    }
    const html = this.buildChipsHtml();
    if (this.renderedChipsHtml === html) {
      return;
    }
    track.innerHTML = html;
    this.renderedChipsHtml = html;
  },

  // Reconcile the sources list against `this.streams` instead of reparsing it. Addons resolve
  // one at a time and each arrival used to reparse the whole screen (~200ms of ParseHTML +
  // layout on the C3, once per addon), which is what made the Continue Watching handoff
  // stutter. Cards are keyed by stream id, so a batch of new sources is an append.
  updateStreamList() {
    const list = this.container?.querySelector(".stream-route-list");
    if (!list) {
      return;
    }
    const filtered = this.getFilteredStreams();
    const hasPendingForFilter = this.hasPendingSourceLoads();

    if (!filtered.length) {
      let html = "";
      if ((this.loading && !this.streams.length) || hasPendingForFilter) {
        html = this.renderLoadingCards();
      } else if (this.error) {
        html = `<div class="stream-route-empty">${escapeHtml(this.error)}</div>`;
      } else {
        html = `<div class="stream-route-empty">No sources found for this filter.</div>`;
      }
      if (!this.renderedListIsPlaceholder || this.renderedListPlaceholderHtml !== html) {
        list.innerHTML = html;
        this.renderedListIsPlaceholder = true;
        this.renderedListPlaceholderHtml = html;
        this.renderedCardHtmlByKey = new Map();
      }
      return;
    }

    if (this.renderedListIsPlaceholder) {
      list.innerHTML = "";
      this.renderedListIsPlaceholder = false;
      this.renderedListPlaceholderHtml = null;
      this.renderedCardHtmlByKey = new Map();
    }

    const streamBadgesEnabled = DebridSettingsStore.get().streamBadgesEnabled !== false;
    const badgeSettings = StreamBadgeSettingsStore.snapshot();
    const previous = this.renderedCardHtmlByKey instanceof Map ? this.renderedCardHtmlByKey : new Map();
    const stale = new Map();
    Array.from(list.children).forEach((node) => {
      const key = node.dataset?.streamId;
      if (key && !node.classList.contains("skeleton")) {
        stale.set(key, node);
      }
    });

    const scratch = document.createElement("div");
    const next = new Map();
    filtered.forEach((stream, index) => {
      const key = String(stream.id ?? index);
      const html = this.renderStreamCard(stream, index, streamBadgesEnabled, badgeSettings);
      let node = stale.get(key) || null;
      if (node && previous.get(key) !== html) {
        scratch.innerHTML = html;
        const fresh = scratch.firstElementChild;
        if (fresh) {
          list.replaceChild(fresh, node);
          node = fresh;
        }
      } else if (!node) {
        scratch.innerHTML = html;
        node = scratch.firstElementChild;
      }
      if (!node) {
        return;
      }
      if (list.children[index] !== node) {
        list.insertBefore(node, list.children[index] || null);
      }
      stale.delete(key);
      next.set(key, html);
    });
    stale.forEach((node) => node.remove());
    this.renderedCardHtmlByKey = next;

    // One trailing skeleton while sources are still arriving, always last in the list.
    const skeletons = Array.from(list.querySelectorAll(":scope > .stream-route-card.skeleton"));
    if (hasPendingForFilter) {
      skeletons.slice(1).forEach((node) => node.remove());
      const keep = skeletons[0];
      if (keep) {
        if (keep !== list.lastElementChild) {
          list.appendChild(keep);
        }
      } else {
        list.insertAdjacentHTML("beforeend", this.renderLoadingCards(1));
      }
    } else {
      skeletons.forEach((node) => node.remove());
    }
  },

  updateAutoPlayOverlay() {
    const shell = this.container?.querySelector(".stream-route-shell");
    if (!shell) {
      return;
    }
    const existing = shell.querySelector(":scope > .stream-route-autoplay");
    const html = this.renderAutoPlayOverlay();
    if (!html) {
      existing?.remove();
      this.renderedAutoPlayHtml = null;
      return;
    }
    if (existing && this.renderedAutoPlayHtml === html) {
      return;
    }
    if (existing) {
      existing.outerHTML = html;
    } else {
      shell.insertAdjacentHTML("beforeend", html);
    }
    this.renderedAutoPlayHtml = html;
  },

  renderFullShell(signature) {
    const { isSeries, title, subtitle, episodeLabel, detailLine } = this.getHeaderMeta();
    const backdrop = this.getBackdropUrl();
    const logo = this.params?.logo || "";
    // `streamShellPrewarmed`: the Continue Watching handoff already painted this shell on the
    // way in, so replaying the enter animation would look like the screen restarting.
    const shellStableClass = (this.hasRenderedStreamRouteShell || this.params?.streamShellPrewarmed) ? " stable" : "";

    this.container.innerHTML = `
      <div class="stream-route-shell${shellStableClass}">
        <div class="stream-route-backdrop"${backdrop ? ` style="background-image:url('${String(backdrop).replace(/'/g, "%27")}')"` : ""}></div>
        <div class="stream-route-backdrop-dim"></div>
        <div class="stream-route-left-gradient"></div>
        <div class="stream-route-right-gradient"></div>
        <div class="stream-route-content">
          <section class="stream-route-left">
            <div class="stream-route-left-inner">
              ${logo ? `<img src="${logo}" class="stream-route-logo" alt="${escapeHtml(title)}" />` : `<h1 class="stream-route-title">${escapeHtml(title)}</h1>`}
              ${episodeLabel ? `<div class="stream-route-episode-code">${escapeHtml(episodeLabel)}</div>` : ""}
              ${subtitle ? `<div class="stream-route-subtitle">${escapeHtml(subtitle)}</div>` : ""}
              ${detailLine ? `<div class="stream-route-detail-line">${escapeHtml(detailLine)}</div>` : (!isSeries && subtitle ? `<div class="stream-route-detail-line">${escapeHtml(subtitle)}</div>` : "")}
            </div>
          </section>
          <section class="stream-route-right">
            <div class="stream-route-chip-wrap">
              <div class="stream-route-chip-track"></div>
            </div>
            <div class="stream-route-panel-shell">
              <div class="stream-route-panel">
                <div class="stream-route-list"></div>
              </div>
            </div>
          </section>
        </div>
      </div>
    `;

    this.resetRenderCaches();
    this.renderedShellSignature = signature;
    this.updateChips();
    this.updateStreamList();
    this.updateAutoPlayOverlay();
    this.renderedAddonFilter = String(this.addonFilter || "all");
    this.bindAddonLogoFallbacks();
    ScreenUtils.indexFocusables(this.container);
    this.restoreScrollPosition();
    this.applyFocus();
    this.bindListScrollState();
    this.hasRenderedStreamRouteShell = true;
  },

  render() {
    this.cancelScheduledRender();
    if (!this.container) {
      return;
    }
    const signature = this.buildShellSignature();
    if (!this.container.querySelector(".stream-route-shell") || this.renderedShellSignature !== signature) {
      this.renderFullShell(signature);
      return;
    }

    const filterChanged = this.renderedAddonFilter !== String(this.addonFilter || "all");
    this.updateChips();
    this.updateStreamList();
    this.updateAutoPlayOverlay();
    this.renderedAddonFilter = String(this.addonFilter || "all");
    this.bindAddonLogoFallbacks();
    ScreenUtils.indexFocusables(this.container);
    if (filterChanged) {
      this.restoreScrollPosition();
    }
    this.applyFocus();
  },

  bindListScrollState() {
    const list = this.container?.querySelector(".stream-route-list");
    if (!list) {
      return;
    }
    list.addEventListener("scroll", () => {
      this.listScrollTop = Number(list.scrollTop || 0);
    }, { passive: true });
  },

  bindAddonLogoFallbacks() {
    this.container?.querySelectorAll(".stream-route-addon-badge img[data-addon-logo]").forEach((node) => {
      if (!(node instanceof HTMLImageElement) || node.dataset.fallbackBound === "true") {
        return;
      }
      node.dataset.fallbackBound = "true";
      const fallback = node.nextElementSibling;
      const applyFallback = () => {
        rememberFailedAddonLogo(node.dataset.addonLogo || node.getAttribute("src") || "");
        node.hidden = true;
        if (fallback instanceof HTMLElement) {
          fallback.hidden = false;
        }
      };
      node.addEventListener("error", applyFallback, { once: true });
    });
  },

  async playStream(streamId) {
    this.cancelAutoPlayCountdown();
    const playResolveToken = (Number(this.playResolveToken || 0) + 1);
    this.playResolveToken = playResolveToken;
    const isCurrentPlayRequest = () => (
      this.playResolveToken === playResolveToken
      && Router.getCurrent?.() === "stream"
    );
    const filtered = this.getFilteredStreams();
    const selected = filtered.find((stream) => stream.id === streamId) || filtered[0];
    if (!selected) {
      return;
    }
    let targetUrl = selected.url || selected.externalUrl || "";
    if (!targetUrl) {
      const resolveContext = {
        season: this.params?.season == null ? null : Number(this.params.season),
        episode: this.params?.episode == null ? null : Number(this.params.episode)
      };
      const canUseEngineFs = WebOsEngineFsResolver.canResolveStream(selected);
      const canUseTizenP2p = TizenStreamingServerResolver.canResolveStream(selected);
      const canUseP2p = canUseEngineFs || canUseTizenP2p;
      let fallbackError = "";

      if (DirectDebridResolver.canResolveStream(selected, resolveContext)) {
        this.resolvingStreamId = selected.id;
        this.resolvingStreamMode = "debrid";
        this.requestRender();
        const result = await DirectDebridResolver.resolve(selected, resolveContext);
        if (!isCurrentPlayRequest()) {
          return;
        }
        this.resolvingStreamId = null;
        this.resolvingStreamMode = "";
        if (result.status === "success" && result.stream?.url) {
          selected.url = result.stream.url;
          selected.externalUrl = null;
          selected.behaviorHints = result.stream.behaviorHints || selected.behaviorHints;
          selected.raw = result.stream.raw || selected.raw;
          targetUrl = selected.url || selected.externalUrl || "";
        } else {
          this.requestRender();
          const messageKey = result.status === "not_cached"
            ? "stream.debrid.notCached"
            : result.status === "stale"
                ? "stream.debrid.stale"
                : "stream.debrid.failed";
          const fallback = result.status === "not_cached"
            ? "Not cached on this service."
            : result.status === "stale"
                ? "This Debrid result expired. Refreshing streams."
                : "Could not resolve this Debrid stream.";
          fallbackError = t(messageKey, {}, fallback);
        }
      }

      if (!targetUrl && canUseP2p) {
        this.resolvingStreamId = selected.id;
        this.resolvingStreamMode = "p2p";
        this.requestRender();
        const result = canUseEngineFs
          ? await WebOsEngineFsResolver.resolve(selected, resolveContext)
          : await TizenStreamingServerResolver.resolve(selected, resolveContext);
        if (!isCurrentPlayRequest()) {
          return;
        }
        this.resolvingStreamId = null;
        this.resolvingStreamMode = "";
        if (result.status === "success" && result.stream?.url) {
          selected.url = result.stream.url;
          selected.externalUrl = null;
          selected.infoHash = result.stream.infoHash || selected.infoHash;
          selected.fileIdx = result.stream.fileIdx ?? selected.fileIdx;
          selected.engineFs = result.stream.engineFs || selected.engineFs || null;
          selected.tizenP2p = result.stream.tizenP2p || selected.tizenP2p || null;
          selected.mimeType = result.stream.mimeType || selected.mimeType || null;
          selected.sourceType = result.stream.sourceType || selected.sourceType || "";
          selected.behaviorHints = result.stream.behaviorHints || selected.behaviorHints;
          selected.raw = result.stream.raw || selected.raw;
          targetUrl = selected.url || selected.externalUrl || "";
        } else {
          console.warn("StreamScreen: P2P resolve failed", {
            status: result.status,
            detail: result.detail || "",
            infoHash: selected.infoHash || selected.raw?.infoHash || selected.clientResolve?.infoHash || selected.raw?.clientResolve?.infoHash || "",
            fileIdx: selected.fileIdx ?? selected.raw?.fileIdx ?? null
          });
          this.requestRender();
        }
      }

      if (!targetUrl) {
        window.alert?.(canUseP2p
          ? t("stream.p2p.failed", {}, "Could not start this torrent stream.")
          : (fallbackError || t("stream.debrid.unavailable", {}, "This Debrid source needs a configured Debrid account.")));
        return;
      }
      this.streams = this.streams.map((stream) => stream.id === selected.id ? { ...stream, ...selected } : stream);
      this.requestRender();
    }
    if (!isCurrentPlayRequest()) {
      return;
    }
    // The player is handed `episodes`/`imdbId` by value, so a Continue Watching entry that
    // resolves a source faster than its metadata has to wait for the merge. In practice
    // hydration settles long before this; the cap only stops a dead addon blocking playback.
    if (this.metaHydrationPromise) {
      await Promise.race([
        this.metaHydrationPromise,
        new Promise((resolve) => setTimeout(resolve, 1500))
      ]);
      if (!isCurrentPlayRequest()) {
        return;
      }
    }
    const playerStreamCandidates = this.getFilteredStreams();
    const itemType = normalizeType(this.params?.itemType);
    Router.navigate("player", {
      streamUrl: targetUrl,
      itemId: this.params?.itemId || null,
      itemType: itemType || "movie",
      imdbId: this.params?.imdbId || null,
      videoId: this.params?.videoId || null,
      resumePositionMs: Number(this.params?.resumePositionMs || 0) || 0,
      episodeLabel: this.params?.season && this.params?.episode
        ? `S${this.params.season}E${this.params.episode}`
        : null,
      playerTitle: this.params?.itemTitle || this.params?.playerTitle || "Untitled",
      playerSubtitle: this.params?.episodeTitle || this.params?.playerSubtitle || "",
      playerEpisodeTitle: this.params?.episodeTitle || "",
      playerReleaseYear: this.params?.year || "",
      playerBackdropUrl: this.getBackdropUrl() || null,
      playerLogoUrl: this.params?.logo || null,
      parentalWarnings: this.params?.parentalWarnings || null,
      parentalGuide: this.params?.parentalGuide || null,
      season: this.params?.season == null ? null : Number(this.params.season),
      episode: this.params?.episode == null ? null : Number(this.params.episode),
      episodes: Array.isArray(this.params?.episodes) ? this.params.episodes : [],
      streamCandidates: playerStreamCandidates,
      returnToStreamOnBack: true,
      fromDetailRoute: Boolean(this.params?.fromDetailRoute),
      nextEpisodeVideoId: this.params?.nextEpisodeVideoId || null,
      nextEpisodeLabel: this.params?.nextEpisodeLabel || null,
      nextEpisodeSeason: this.params?.nextEpisodeSeason ?? null,
      nextEpisodeEpisode: this.params?.nextEpisodeEpisode ?? null,
      nextEpisodeTitle: this.params?.nextEpisodeTitle || "",
      nextEpisodeReleased: this.params?.nextEpisodeReleased || ""
    });
  },

  onPointerFocus(target) {
    if (!target || !this.container?.contains(target)) {
      return false;
    }
    const { chips, cards } = this.getFocusLists();
    const chipIndex = chips.indexOf(target);
    if (chipIndex >= 0) {
      this.focusState = { zone: "filter", index: chipIndex };
      this.focusList(chips, chipIndex);
      return true;
    }
    const cardIndex = cards.indexOf(target);
    if (cardIndex >= 0) {
      this.focusState = { zone: "card", index: cardIndex };
      this.focusList(cards, cardIndex);
      return true;
    }
    return false;
  },

  onPointerActivate(target) {
    if (!target || !this.container?.contains(target)) {
      return false;
    }
    this.onPointerFocus(target);
    const action = String(target.dataset.action || "");
    if (action === "setFilter") {
      const addon = String(target.dataset.addon || "all");
      const { chips } = this.getFocusLists();
      this.setAddonFilter(addon, "filter", Math.max(0, chips.indexOf(target)));
      return true;
    }
    if (action === "playStream") {
      this.playStream(target.dataset.streamId);
      return true;
    }
    return false;
  },

  maybeAutoPlayStream() {
    if (this.autoPlayAttempted || this.autoPlayCountdown) {
      return;
    }
    if (Router.getCurrent() !== "stream" || !this.streams.length) {
      return;
    }
    const settings = PlayerSettingsStore.get();
    if (!isAutoPlayEffectivelyEnabled(settings)) {
      return;
    }
    this.autoPlayAttempted = true;
    const installedAddonNames = new Set(
      (addonRepository.getCachedInstalledAddons() || [])
        .map((addon) => String(addon?.displayName || addon?.name || "").trim())
        .filter(Boolean)
    );
    const selected = selectAutoPlayStream(this.getFilteredStreams(), {
      mode: settings.streamAutoPlayMode,
      source: settings.streamAutoPlaySource,
      regexPattern: settings.streamAutoPlayRegex,
      installedAddonNames
    });
    if (!selected?.id) {
      return;
    }
    this.startAutoPlayCountdown(selected, Number(settings.streamAutoPlayTimeoutSeconds || 0));
  },

  startAutoPlayCountdown(stream, seconds) {
    this.cancelAutoPlayCountdown();
    const visible = this.getFilteredStreams();
    const idx = visible.findIndex((entry) => String(entry?.id || "") === String(stream.id || ""));
    if (idx >= 0) {
      this.focusState = { zone: "card", index: idx, row: idx, action: "play" };
    }
    const total = Math.max(0, Math.trunc(Number(seconds) || 0));
    if (total <= 0) {
      void this.playStream(stream.id);
      return;
    }
    this.autoPlayCountdown = {
      streamId: stream.id,
      label: getStreamHeadline(stream) || stream.addonName || "stream",
      quality: getStreamQuality(stream),
      sizeText: formatBytes(stream.behaviorHints?.videoSize),
      totalSeconds: total,
      secondsLeft: total
    };
    this.requestRender({ delayMs: 0 });
    this.autoPlayTimer = setInterval(() => {
      if (!this.autoPlayCountdown) {
        return;
      }
      this.autoPlayCountdown.secondsLeft -= 1;
      if (this.autoPlayCountdown.secondsLeft <= 0) {
        const targetId = this.autoPlayCountdown.streamId;
        this.cancelAutoPlayCountdown();
        void this.playStream(targetId);
        return;
      }
      this.updateAutoPlayCountdownView();
    }, 1000);
  },

  // The dial drains in CSS over the whole countdown window, so the per-second
  // tick only has to patch the digit inside it. Re-rendering the screen once a
  // second (what this used to do) rebuilt the entire sources list and restarted
  // that animation from full every time.
  updateAutoPlayCountdownView() {
    const node = this.container?.querySelector("[data-autoplay-seconds]");
    if (!node) {
      this.requestRender({ delayMs: 0 });
      return;
    }
    node.textContent = String(Math.max(0, Number(this.autoPlayCountdown?.secondsLeft || 0)));
  },

  cancelAutoPlayCountdown() {
    if (this.autoPlayTimer) {
      clearInterval(this.autoPlayTimer);
      this.autoPlayTimer = null;
    }
    if (this.autoPlayCountdown) {
      this.autoPlayCountdown = null;
      this.requestRender({ delayMs: 0 });
    }
  },

  renderAutoPlayOverlay() {
    if (!this.autoPlayCountdown) {
      return "";
    }
    const { label, secondsLeft, totalSeconds, quality, sizeText } = this.autoPlayCountdown;
    const total = Math.max(1, Number(totalSeconds || 0));
    // The dial is one CSS animation started at render time; seeding it with a
    // negative delay equal to the elapsed time keeps it in sync when something
    // else (a late addon, a resolve) re-renders the screen mid-countdown.
    const elapsed = Math.max(0, total - Math.max(0, Number(secondsLeft || 0)));
    // Only the first paint of a countdown gets the entrance animation — a
    // re-render mid-countdown (late addon, debrid resolve) would otherwise
    // replay the card scaling in from nothing.
    const settled = this.autoPlayCountdown.rendered === true;
    this.autoPlayCountdown.rendered = true;
    // Enough to tell which source was picked and nothing more — the release
    // name carries the identity, quality and size settle the rest.
    const qualityText = String(quality || "").trim();
    const meta = [
      qualityText && qualityText.length <= 28 ? qualityText : "",
      sizeText || ""
    ].filter(Boolean).join(" · ");
    return `
      <div class="stream-route-autoplay" role="status">
        <div class="stream-route-autoplay-card${settled ? " is-settled" : ""}" style="--autoplay-total:${total}s;--autoplay-elapsed:-${elapsed}s">
          <div class="stream-route-autoplay-dial">
            <svg class="stream-route-autoplay-dial-svg" viewBox="0 0 72 72" aria-hidden="true">
              <circle class="stream-route-autoplay-dial-track" cx="36" cy="36" r="32"></circle>
              <circle class="stream-route-autoplay-dial-progress" cx="36" cy="36" r="32"></circle>
            </svg>
            <span class="stream-route-autoplay-dial-value" data-autoplay-seconds>${escapeHtml(String(Math.max(0, Number(secondsLeft || 0))))}</span>
          </div>
          <div class="stream-route-autoplay-copy">
            <div class="stream-route-autoplay-eyebrow">${escapeHtml(t("stream_autoplay_title", {}, "Auto-playing"))}</div>
            <div class="stream-route-autoplay-name">${escapeHtml(label)}</div>
            ${meta ? `<div class="stream-route-autoplay-meta">${escapeHtml(meta)}</div>` : ""}
            <div class="stream-route-autoplay-hint">${escapeHtml(t("stream_autoplay_hint", {}, "Press OK to play now, or any key to choose manually"))}</div>
          </div>
        </div>
      </div>`;
  },

  onKeyDown(event) {
    // Any key during the auto-play countdown hands control back to the user.
    if (this.autoPlayCountdown) {
      this.cancelAutoPlayCountdown();
      if (isBackEvent(event)) {
        event?.preventDefault?.();
        return;
      }
    }

    if (isBackEvent(event)) {
      event?.preventDefault?.();
      if (!this.navigateBackFromStream()) {
        Router.back();
      }
      return;
    }

    const direction = getDpadDirection(event);
    if (direction) {
      const { chips, cards } = this.getFocusLists();
      const zone = this.focusState?.zone || (cards.length ? "card" : "filter");
      let index = Number(this.focusState?.index || 0);
      event?.preventDefault?.();

      if (zone === "filter") {
        if (direction === "left") {
          if (chips.length) {
            const ordered = ["all", ...this.getOrderedFilterNames()];
            const currentFilter = ordered[clamp(index, 0, ordered.length - 1)] || "all";
            const currentPosition = ordered.indexOf(currentFilter);
            const nextFilter = ordered[clamp(currentPosition - 1, 0, ordered.length - 1)];
            this.setAddonFilter(nextFilter, "filter", clamp(index - 1, 0, Math.max(0, chips.length - 1)));
          }
          return;
        }
        if (direction === "right") {
          if (chips.length) {
            const ordered = ["all", ...this.getOrderedFilterNames()];
            const currentFilter = ordered[clamp(index, 0, ordered.length - 1)] || "all";
            const currentPosition = ordered.indexOf(currentFilter);
            const nextFilter = ordered[clamp(currentPosition + 1, 0, ordered.length - 1)];
            this.setAddonFilter(nextFilter, "filter", clamp(index + 1, 0, Math.max(0, chips.length - 1)));
          }
          return;
        }
        if (direction === "down" && cards.length) {
          this.focusState = { zone: "card", index: clamp(index, 0, cards.length - 1) };
          this.applyFocus();
        }
        return;
      }

      if (zone === "card") {
        if (direction === "up") {
          if (index > 0) {
            this.focusState = { zone: "card", index: index - 1 };
            this.applyFocus();
            return;
          }
          this.focusState = {
            zone: "filter",
            index: clamp(["all", ...this.getOrderedFilterNames()].indexOf(this.addonFilter), 0, Math.max(0, chips.length - 1))
          };
          this.applyFocus();
          return;
        }
        if (direction === "down") {
          this.focusState = { zone: "card", index: clamp(index + 1, 0, Math.max(0, cards.length - 1)) };
          this.applyFocus();
          return;
        }
        if (direction === "left" || direction === "right") {
          const ordered = ["all", ...this.getOrderedFilterNames()];
          const currentIndex = Math.max(0, ordered.indexOf(this.addonFilter));
          const delta = direction === "left" ? -1 : 1;
          const nextFilter = ordered[clamp(currentIndex + delta, 0, ordered.length - 1)] || "all";
          this.setAddonFilter(nextFilter, "card", index);
          return;
        }
      }
      return;
    }

    if (Number(event?.keyCode || 0) !== 13) {
      return;
    }

    const current = this.container.querySelector(".focusable.focused");
    if (!current) {
      return;
    }
    const action = String(current.dataset.action || "");
    if (action === "setFilter") {
      const addon = String(current.dataset.addon || "all");
      this.setAddonFilter(addon, "filter", Array.from(this.container.querySelectorAll(".stream-route-chip.focusable")).indexOf(current));
      return;
    }
    if (action === "playStream") {
      this.playStream(current.dataset.streamId);
    }
  },

  cleanup() {
    this.cancelAutoPlayCountdown();
    this.loadToken = (this.loadToken || 0) + 1;
    this.playResolveToken = (Number(this.playResolveToken || 0) + 1);
    this.cancelScheduledRender();
    if (this.errorChipTimer) {
      clearTimeout(this.errorChipTimer);
      this.errorChipTimer = null;
    }
    if (this.releaseImageProxyReadyListener) {
      this.releaseImageProxyReadyListener();
      this.releaseImageProxyReadyListener = null;
    }
    ScreenUtils.hide(this.container);
  }

};
