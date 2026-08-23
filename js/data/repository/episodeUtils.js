// Returns the first value that is a non-negative integer (number or numeric
// string); null when none is. Whitespace-only strings, non-integers and
// non-numeric types count as missing — `Number("  ")` is 0 and would otherwise
// turn an empty field into a fake specials season. An explicit 0 is reported
// as 0 (not folded into a falsy default the way `Number(value || 0)` did) so
// resolveSeasonEpisode() can keep a declared specials season out of its
// missing-season fallback below.
function firstNonNegativeInt(values = []) {
  for (const value of values) {
    if (typeof value !== "number" && typeof value !== "string") {
      continue;
    }
    const normalized = typeof value === "string" ? value.trim() : value;
    if (normalized === "") {
      continue;
    }
    const num = Number(normalized);
    if (Number.isInteger(num) && num >= 0) {
      return num;
    }
  }
  return null;
}

// Stremio video ids frequently encode the season and episode as the trailing
// colon-separated segments (e.g. "tt1234567:1:2"). Many addons (AIOStreams and
// other aggregators included) rely on this and do NOT populate the explicit
// `season`/`episode` fields, which previously caused every episode to be
// dropped and the detail screen to report "No episodes available".
// Returns null when the id does not encode a season/episode pair.
function parseSeasonEpisodeFromId(rawId) {
  const id = String(rawId || "").trim();
  if (!id) {
    return null;
  }
  const segments = id.split(":");
  if (segments.length < 3) {
    return null;
  }
  const lastSegment = segments[segments.length - 1];
  const secondLastSegment = segments[segments.length - 2];
  if (!/^\d+$/.test(lastSegment) || !/^\d+$/.test(secondLastSegment)) {
    return null;
  }
  // Three-segment ids are only safe to treat as "<series>:<season>:<episode>"
  // when the prefix is an IMDb id (e.g. "tt1234567:1:2"). Otherwise the middle
  // segment is an addon-specific identifier (e.g. "kitsu:12345:6") rather than a
  // season, and those metas always provide explicit season/episode fields.
  if (segments.length === 3 && !/^tt\d+$/i.test(segments[0])) {
    return null;
  }
  return { season: Number(secondLastSegment), episode: Number(lastSegment) };
}

function resolveSeasonEpisode(video = {}) {
  const fromId = parseSeasonEpisodeFromId(video.id);
  const season = firstNonNegativeInt([video.season, video.seasonNumber, fromId?.season]);
  const episode = firstNonNegativeInt([video.episode, video.episodeNumber, fromId?.episode, video.number]);
  // Some addons omit the season entirely for single-season shows and only
  // provide an episode/number; treat those as season 1 instead of discarding
  // the episode. The explicit-0-vs-missing distinction from
  // firstNonNegativeInt() is consumed right here: a season explicitly set to 0
  // (specials) skips this fallback, so specials stay excluded from the regular
  // episode list exactly as before. After the fallback, missing values are
  // returned as 0, matching what normalizeEpisodes() filters on.
  if (season == null && episode > 0) {
    return { season: 1, episode };
  }
  return { season: season ?? 0, episode: episode ?? 0 };
}

function toEpisodeEntry(video = {}) {
  const { season, episode } = resolveSeasonEpisode(video);
  const runtimeMinutes = Number(
    video.runtime
    || video.runtimeMinutes
    || video.durationMinutes
    || video.duration
    || 0
  );
  return {
    id: video.id || "",
    title: video.title || video.name || `S${season}E${episode}`,
    season,
    episode,
    thumbnail: video.thumbnail || null,
    overview: video.overview || video.description || "",
    runtimeMinutes: Number.isFinite(runtimeMinutes) && runtimeMinutes > 0 ? runtimeMinutes : 0,
    released: video.released || video.releaseDate || video.release_date || video.firstAired || video.first_aired || video.airDate || video.air_date || "",
    available: video.available,
    imdbRating: video.imdbRating ?? video.imdb_score ?? video.ratings?.imdb ?? video.mdbListRatings?.imdb ?? video.rating ?? null
  };
}

function normalizeEpisodes(videos = []) {
  return videos
    .map((video) => toEpisodeEntry(video))
    .filter((video) => video.id && video.season > 0 && video.episode > 0)
    .sort((left, right) => {
      if (left.season !== right.season) {
        return left.season - right.season;
      }
      return left.episode - right.episode;
    });
}

export {
  firstNonNegativeInt,
  parseSeasonEpisodeFromId,
  resolveSeasonEpisode,
  toEpisodeEntry,
  normalizeEpisodes
};
