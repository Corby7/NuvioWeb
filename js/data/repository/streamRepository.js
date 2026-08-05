import { safeApiCall } from "../../core/network/safeApiCall.js";
import { addonRepository } from "./addonRepository.js";
import { StreamApi } from "../remote/api/streamApi.js";
import { MetaApi } from "../remote/api/metaApi.js";
import { PluginManager } from "../../core/player/pluginManager.js";
import { TmdbService } from "../../core/tmdb/tmdbService.js";
import { LocalDebridAvailabilityService } from "../../core/debrid/localDebridAvailabilityService.js";
import { DebridStreamPresentation } from "../../core/debrid/directDebridStreamPresentation.js";
import { DebridSettingsStore } from "../local/debridSettingsStore.js";

// A source fan-out is shared instead of restarted: the detail screen prefetches
// on the same click that navigates, the stream screen then attaches to that
// running request, and going back and re-entering within the TTL renders from
// the finished one. Kept short so a torrent that just finished caching still
// shows up as cached on the next visit.
const STREAM_RUN_TTL_MS = 120000;
// Torrent addons return long lists, so only a handful of finished runs are held.
const STREAM_RUN_MAX_ENTRIES = 8;
// Debrid cache lookups from addons that land close together are coalesced into
// one request instead of one per addon.
const DEBRID_BATCH_WINDOW_MS = 60;

const streamRuns = new Map();

function safeInvoke(callback, payload, label) {
  if (typeof callback !== "function") {
    return;
  }
  try {
    callback(payload);
  } catch (error) {
    console.warn(label, error);
  }
}

// One fan-out, many subscribers. Groups are stored by key so a group can be
// replaced by a richer revision (debrid-annotated) before any late subscriber
// replays it.
class StreamRun {
  constructor(signature) {
    this.signature = signature;
    this.startedAt = Date.now();
    this.completedAt = 0;
    this.done = false;
    this.addons = [];
    this.groupOrder = [];
    this.groups = new Map();
    this.listeners = new Set();
    this.promise = null;
  }

  emitAddon(addon) {
    if (!addon) {
      return;
    }
    this.addons.push(addon);
    this.listeners.forEach((listener) => {
      safeInvoke(listener.onAddon, addon, "Stream addon callback failed");
    });
  }

  emitGroup(key, group) {
    if (!group?.streams?.length) {
      return;
    }
    if (!this.groups.has(key)) {
      this.groupOrder.push(key);
    }
    this.groups.set(key, group);
    const payload = { status: "success", data: [group] };
    this.listeners.forEach((listener) => {
      safeInvoke(listener.onChunk, payload, "Stream chunk callback failed");
    });
  }

  // Drops a partial group from the result set once the complete one has been
  // emitted. Anything already rendered from it stays — it is a strict subset.
  dropGroup(key) {
    if (!this.groups.delete(key)) {
      return;
    }
    this.groupOrder = this.groupOrder.filter((entry) => entry !== key);
  }

  orderedGroups() {
    const groups = this.groupOrder.map((key) => this.groups.get(key)).filter(Boolean);
    const addonGroups = groups
      .filter((group) => group.streamOrigin?.kind !== "plugin")
      .sort((left, right) => Number(left.addonOrderIndex || 0) - Number(right.addonOrderIndex || 0));
    const pluginGroups = groups.filter((group) => group.streamOrigin?.kind === "plugin");
    return [...addonGroups, ...pluginGroups];
  }
}

class StreamRepository {
  async getStreamsFromAddon(baseUrl, type, videoId) {
    const url = this.buildStreamUrl(baseUrl, type, videoId);
    const result = await safeApiCall(() => StreamApi.getStreams(url));
    if (result.status !== "success") {
      return result;
    }

    const streams = (result.data?.streams || []).map((stream) => this.mapStream(stream));
    return { status: "success", data: streams };
  }

  async getStreamsFromAllAddons(type, videoId, options = {}) {
    const run = this.ensureStreamRun(type, videoId, options);
    return this.attachToStreamRun(run, options);
  }

  // Warms a run without waiting on it, so the fan-out is already in flight while
  // the stream screen renders its shell.
  prefetchStreams(type, videoId, options = {}) {
    if (!type || !videoId) {
      return;
    }
    try {
      const run = this.ensureStreamRun(type, videoId, options);
      run.promise?.catch(() => {});
    } catch (error) {
      console.warn("Stream prefetch failed", error);
    }
  }

  // Mirrors how the stream screen derives its request from route params, so a
  // prefetch fired on the click that navigates and the screen's own call land
  // on the same run. Callers that need to wait on the fan-out — the play-path
  // warmer — take the run from here rather than re-deriving the key.
  ensureStreamRunForRoute(params = {}) {
    const type = String(params?.itemType || "movie").toLowerCase() || "movie";
    const videoId = String(params?.videoId || params?.itemId || "");
    if (!videoId) {
      return null;
    }
    return this.ensureStreamRun(type, videoId, {
      itemId: String(params?.itemId || ""),
      season: params?.season ?? null,
      episode: params?.episode ?? null
    });
  }

  prefetchStreamsForRoute(params = {}) {
    try {
      const run = this.ensureStreamRunForRoute(params);
      run?.promise?.catch(() => {});
    } catch (error) {
      console.warn("Stream prefetch failed", error);
    }
  }

  buildStreamRunKey(type, videoId, options = {}) {
    return [type, videoId, options?.itemId, options?.season, options?.episode]
      .map((value) => String(value ?? ""))
      .join("|");
  }

  // Anything that changes what a fan-out would return invalidates a cached run:
  // the installed addons, the debrid account/preferences the presentation layer
  // reads, and the plugin templates.
  buildStreamRunSignature() {
    let debrid = "";
    try {
      debrid = JSON.stringify(DebridSettingsStore.get() || {});
    } catch (_) {
      debrid = "";
    }
    let plugins = "off";
    try {
      plugins = PluginManager.pluginsEnabled
        ? JSON.stringify(
            PluginManager.listPluginSources()
              .filter((source) => source.enabled)
              .map((source) => `${source.id}:${source.urlTemplate}`)
          )
        : "off";
    } catch (_) {
      plugins = "off";
    }
    let addons = "";
    try {
      addons = JSON.stringify(addonRepository.getInstalledAddonUrls());
    } catch (_) {
      addons = "";
    }
    return `${addons}::${debrid}::${plugins}`;
  }

  ensureStreamRun(type, videoId, options = {}) {
    const key = this.buildStreamRunKey(type, videoId, options);
    const signature = this.buildStreamRunSignature();
    const existing = streamRuns.get(key);
    const expired = Boolean(existing?.done) && Date.now() - existing.completedAt > STREAM_RUN_TTL_MS;
    if (existing && existing.signature === signature && !expired) {
      return existing;
    }
    if (existing) {
      streamRuns.delete(key);
    }

    const run = new StreamRun(signature);
    streamRuns.set(key, run);
    run.promise = this.executeStreamRun(run, type, videoId, options)
      .catch((error) => {
        console.warn("Stream fan-out failed", error);
      })
      .finally(() => {
        run.done = true;
        run.completedAt = Date.now();
        run.listeners.clear();
        // An empty result is almost always a transient addon failure — never
        // serve it from cache.
        if (!run.groupOrder.length && streamRuns.get(key) === run) {
          streamRuns.delete(key);
        }
        this.pruneStreamRuns();
      });
    return run;
  }

  async attachToStreamRun(run, options = {}) {
    const listener = {
      onAddon: typeof options?.onAddon === "function" ? options.onAddon : null,
      onChunk: typeof options?.onChunk === "function" ? options.onChunk : null
    };
    // Replay what the run already produced so a late subscriber renders
    // immediately instead of waiting for the remaining addons.
    if (listener.onAddon) {
      run.addons.forEach((addon) => {
        safeInvoke(listener.onAddon, addon, "Stream addon callback failed");
      });
    }
    if (listener.onChunk) {
      run.orderedGroups().forEach((group) => {
        safeInvoke(
          listener.onChunk,
          { status: "success", data: [group] },
          "Stream chunk callback failed"
        );
      });
    }
    if (!run.done && (listener.onAddon || listener.onChunk)) {
      run.listeners.add(listener);
    }
    try {
      await run.promise;
    } finally {
      run.listeners.delete(listener);
    }
    return { status: "success", data: run.orderedGroups() };
  }

  pruneStreamRuns() {
    const now = Date.now();
    streamRuns.forEach((run, key) => {
      if (run.done && now - run.completedAt > STREAM_RUN_TTL_MS) {
        streamRuns.delete(key);
      }
    });
    if (streamRuns.size <= STREAM_RUN_MAX_ENTRIES) {
      return;
    }
    for (const [key, run] of streamRuns) {
      if (streamRuns.size <= STREAM_RUN_MAX_ENTRIES) {
        break;
      }
      if (run.done) {
        streamRuns.delete(key);
      }
    }
  }

  // Debrid availability for several addons is answered by one API call: groups
  // queue here and flush together once the window closes.
  createDebridBatchQueue(run) {
    const pending = [];
    const inFlight = new Set();
    let timer = null;

    const flush = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!pending.length) {
        return Promise.resolve();
      }
      const batch = pending.splice(0, pending.length);
      const task = (async () => {
        let groups = batch.map((entry) => entry.group);
        try {
          groups = await LocalDebridAvailabilityService.annotateCachedAvailability(groups);
        } catch (error) {
          console.warn("Debrid availability check failed", error);
          groups = batch.map((entry) => entry.group);
        }
        const presented = DebridStreamPresentation.apply(groups);
        batch.forEach((entry, index) => {
          run.emitGroup(entry.key, presented[index] || groups[index] || entry.group);
          if (entry.partialKey) {
            run.dropGroup(entry.partialKey);
          }
        });
      })().finally(() => {
        inFlight.delete(task);
      });
      inFlight.add(task);
      return task;
    };

    return {
      enqueue(key, group, partialKey = "") {
        pending.push({ key, group, partialKey });
        if (!timer) {
          timer = setTimeout(() => {
            timer = null;
            void flush();
          }, DEBRID_BATCH_WINDOW_MS);
        }
      },
      async settle() {
        await flush();
        while (inFlight.size) {
          await Promise.allSettled(Array.from(inFlight));
        }
      }
    };
  }

  // Streams that need no debrid lookup are published straight away; the
  // presentation layer leaves them untouched, so nothing shown here can be
  // reordered or dropped once the cache check lands.
  publishStreamGroup(run, key, group, debridQueue) {
    const checking = LocalDebridAvailabilityService.markChecking([group])[0] || group;
    const streams = checking.streams || [];
    const awaitingCheck = streams.filter(
      (stream) => stream.debridCacheStatus?.state === "CHECKING"
    );
    if (!awaitingCheck.length) {
      run.emitGroup(key, DebridStreamPresentation.apply([checking])[0] || checking);
      return;
    }

    const partialKey = `${key}::direct`;
    const readyStreams = streams.filter(
      (stream) =>
        stream.debridCacheStatus?.state !== "CHECKING" &&
        !DebridStreamPresentation.isManagedDebridStream(stream)
    );
    if (readyStreams.length) {
      run.emitGroup(partialKey, { ...checking, streams: readyStreams });
    }
    debridQueue.enqueue(key, checking, readyStreams.length ? partialKey : "");
  }

  async executeStreamRun(run, type, videoId, options = {}) {
    const debridQueue = this.createDebridBatchQueue(run);
    // The plugin leg only needs a TMDB id, so it starts before the addon
    // manifests resolve instead of queueing behind them.
    const pluginTask = (async () => {
      try {
        const pluginStreams = await this.getPluginStreams(type, videoId, options);
        pluginStreams.forEach((group, index) => {
          this.publishStreamGroup(
            run,
            `plugin::${group.sourceProviderId || group.addonName || index}`,
            group,
            debridQueue
          );
        });
      } catch (error) {
        console.warn("Plugin stream fetch failed", error);
      }
    })();

    const installedAddons = (await addonRepository.getInstalledAddons()).map((addon, index) => ({
      ...addon,
      orderIndex: index
    }));

    const supportsResourceType = (resource, type) => {
      const targetType = String(type || "")
        .trim()
        .toLowerCase();
      const types = Array.isArray(resource?.types)
        ? resource.types
            .map((resourceType) =>
              String(resourceType || "")
                .trim()
                .toLowerCase()
            )
            .filter(Boolean)
        : [];
      return !types.length || types.includes(targetType);
    };

    const supportsResourceId = (addon, resource, id) => {
      const prefixes = (Array.isArray(resource?.idPrefixes) && resource.idPrefixes.length
        ? resource.idPrefixes
        : Array.isArray(addon?.idPrefixes) && addon.idPrefixes.length
          ? addon.idPrefixes
          : [])
        .map((prefix) => String(prefix || ""))
        .filter(Boolean);
      return !prefixes.length || prefixes.some((prefix) => String(id || "").startsWith(prefix));
    };

    const supportsStreamType = (addon) =>
      (addon?.resources || []).some((resource) => {
        if (resource.name !== "stream") {
          return false;
        }
        return supportsResourceType(resource, type) && supportsResourceId(addon, resource, videoId);
      });

    const supportsMetaType = (addon) =>
      (addon?.resources || []).some((resource) => {
        if (resource.name !== "meta") {
          return false;
        }
        return supportsResourceType(resource, type) && supportsResourceId(addon, resource, videoId);
      });

    const addonTasks = installedAddons.map(async (addon) => {
      try {
        const canStream = supportsStreamType(addon);
        const canMeta = supportsMetaType(addon);
        // Meta-only stream discovery is a compatibility path for debrid cloud
        // items, which are exposed through the `other` type. Regular movie/series
        // metadata addons must not be queried as stream sources.
        const shouldTryInlineMetaStreams =
          canMeta &&
          (canStream ||
            String(type || "")
              .trim()
              .toLowerCase() === "other");
        if (!canStream && !shouldTryInlineMetaStreams) {
          return;
        }
        const orderIndex = Number(addon.orderIndex ?? Number.MAX_SAFE_INTEGER);
        run.emitAddon({ ...addon, orderIndex });
        let addonStreams = [];
        if (canStream) {
          const streamsResult = await this.getStreamsFromAddon(addon.baseUrl, type, videoId);
          if (streamsResult.status === "success" && streamsResult.data.length) {
            addonStreams = streamsResult.data;
          }
        }
        // Some addons (e.g. debrid cloud catalogs) deliver the playable stream
        // inline in the meta's videos[].streams[] and only expose a meta resource
        // for the content type, not a stream resource. Fall back to that here.
        if (addonStreams.length === 0 && shouldTryInlineMetaStreams) {
          addonStreams = await this.fetchInlineStreamsFromMeta(addon, type, videoId);
        }
        if (addonStreams.length === 0) {
          return;
        }

        const group = {
          addonId: addon.id,
          addonBaseUrl: addon.baseUrl,
          addonName: addon.displayName,
          addonLogo: addon.logo,
          addonOrderIndex: orderIndex,
          streamOrigin: {
            kind: "addon",
            addonId: addon.id,
            addonBaseUrl: addon.baseUrl,
            addonName: addon.displayName,
            addonOrderIndex: orderIndex
          },
          streams: addonStreams.map((stream) => ({
            ...stream,
            addonId: addon.id,
            addonBaseUrl: addon.baseUrl,
            addonName: addon.displayName,
            addonLogo: addon.logo,
            addonOrderIndex: orderIndex,
            streamOrigin: {
              ...(stream.streamOrigin || {}),
              kind: "addon",
              addonId: addon.id,
              addonBaseUrl: addon.baseUrl,
              addonName: addon.displayName,
              addonOrderIndex: orderIndex
            }
          }))
        };
        this.publishStreamGroup(run, `addon::${addon.id || addon.baseUrl}`, group, debridQueue);
      } catch (_) {
        // A failing addon must not hold up the rest of the fan-out.
      }
    });

    await Promise.all(addonTasks);
    await pluginTask;
    await debridQueue.settle();
  }

  async getPluginStreams(type, videoId, options = {}) {
    // The TMDB id lookup is a network round trip, so it only runs when a plugin
    // source could actually consume it.
    if (!PluginManager.pluginsEnabled) {
      return [];
    }
    const enabledSources = PluginManager.listPluginSources().filter((source) => source.enabled);
    if (!enabledSources.length) {
      return [];
    }
    const mediaType = type === "series" ? "tv" : type;
    const tmdbLookupId = String(options?.itemId || videoId || "").trim();
    const tmdbId = await TmdbService.ensureTmdbId(tmdbLookupId, type);
    if (!tmdbId) {
      return [];
    }

    const pluginResults = await PluginManager.executeScrapersStreaming({
      tmdbId,
      mediaType,
      season: options?.season ?? null,
      episode: options?.episode ?? null
    });

    return pluginResults.map((result) => ({
      sourceProviderId: result.sourceId || result.sourceName || null,
      addonName: result.sourceName,
      addonLogo: null,
      streamOrigin: {
        kind: "plugin",
        sourceProviderId: result.sourceId || result.sourceName || null,
        addonName: result.sourceName || null
      },
      streams: (result.streams || []).map((stream) => ({
        ...stream,
        sourceProviderId: result.sourceId || result.sourceName || null,
        addonName: result.sourceName,
        addonLogo: null,
        streamOrigin: {
          ...(stream.streamOrigin || {}),
          kind: "plugin",
          sourceProviderId: result.sourceId || result.sourceName || null,
          addonName: result.sourceName || null
        }
      }))
    }));
  }

  buildStreamUrl(baseUrl, type, videoId) {
    const cleanBaseUrl = addonRepository.canonicalizeUrl(baseUrl);
    const queryStart = cleanBaseUrl.indexOf("?");
    const basePath =
      queryStart >= 0 ? cleanBaseUrl.slice(0, queryStart).replace(/\/+$/, "") : cleanBaseUrl;
    const baseQuery = queryStart >= 0 ? cleanBaseUrl.slice(queryStart) : "";
    return `${basePath}/stream/${this.encode(type)}/${this.encode(videoId)}.json${baseQuery}`;
  }

  buildMetaUrl(baseUrl, type, id) {
    const cleanBaseUrl = addonRepository.canonicalizeUrl(baseUrl);
    const queryStart = cleanBaseUrl.indexOf("?");
    const basePath =
      queryStart >= 0 ? cleanBaseUrl.slice(0, queryStart).replace(/\/+$/, "") : cleanBaseUrl;
    const baseQuery = queryStart >= 0 ? cleanBaseUrl.slice(queryStart) : "";
    return `${basePath}/meta/${this.encode(type)}/${this.encode(id)}.json${baseQuery}`;
  }

  encode(value) {
    return encodeURIComponent(String(value || "")).replace(/\+/g, "%20");
  }

  mapStream(stream = {}) {
    const sidecarSubtitles = Array.isArray(stream.subtitles)
      ? stream.subtitles
          .filter((entry) => entry && entry.url)
          .map((entry) => ({
            id: entry.id || null,
            url: entry.url,
            lang: entry.lang || "unknown"
          }))
      : [];

    return {
      name: stream.name || null,
      title: stream.title || null,
      description: stream.description || null,
      url: stream.url || null,
      ytId: stream.ytId || null,
      infoHash: stream.infoHash || null,
      fileIdx: stream.fileIdx ?? null,
      externalUrl: stream.externalUrl || null,
      behaviorHints: stream.behaviorHints || null,
      sources: Array.isArray(stream.sources) ? stream.sources : [],
      quality: stream.quality || null,
      qualityValue: Number.isFinite(Number(stream.qualityValue)) ? Number(stream.qualityValue) : -1,
      clientResolve: stream.clientResolve || null,
      debridCacheStatus: stream.debridCacheStatus || null,
      subtitles: sidecarSubtitles
    };
  }

  async fetchInlineStreamsFromMeta(addon, type, videoId) {
    const rawVideoId = String(videoId || "").trim();
    if (!addon?.baseUrl || !rawVideoId) {
      return [];
    }

    // Try the content-level id (handles series episode ids like tt123:1:2)
    // and the raw id (handles content whose clicked id is the meta id itself,
    // e.g. debrid cloud "other" items keyed dmm:<torrentId>).
    const contentLevelId = this.buildContentLevelMetaId(rawVideoId);
    const candidateMetaIds = [];
    if (contentLevelId) {
      candidateMetaIds.push(contentLevelId);
    }
    if (rawVideoId && rawVideoId !== contentLevelId) {
      candidateMetaIds.push(rawVideoId);
    }

    for (const metaId of candidateMetaIds) {
      const url = this.buildMetaUrl(addon.baseUrl, type, metaId);
      const result = await safeApiCall(() => MetaApi.getMeta(url));

      if (result.status !== "success") {
        continue;
      }

      const meta = result.data?.meta || null;
      const videos = Array.isArray(meta?.videos) ? meta.videos : [];

      if (!videos.length) {
        continue;
      }

      const matchingVideo =
        videos.find((video) => String(video?.id || "") === rawVideoId) ||
        (type !== "series" && videos.length === 1 ? videos[0] : null);

      const streams = Array.isArray(matchingVideo?.streams) ? matchingVideo.streams : [];

      const mapped = streams
        .map((stream) => this.mapStream(stream))
        .filter(
          (stream) =>
            stream.url ||
            stream.externalUrl ||
            stream.ytId ||
            stream.clientResolve ||
            stream.infoHash
        );

      if (mapped.length) {
        return mapped;
      }
    }

    return [];
  }

  buildContentLevelMetaId(videoId) {
    const raw = String(videoId || "").trim();
    if (!raw) {
      return "";
    }
    const parts = raw.split(":");
    const contentParts = parts.slice();
    while (contentParts.length > 1 && /^\d+$/.test(contentParts[contentParts.length - 1])) {
      contentParts.pop();
    }
    return contentParts.length ? contentParts.join(":") : raw;
  }
}

export const streamRepository = new StreamRepository();
