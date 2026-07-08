import { requestJson, TraktAuthService } from "./traktAuthService.js";

function pad2(value) {
  return String(value).padStart(2, "0");
}

// Trakt calendar endpoints take a plain YYYY-MM-DD (no time/timezone component).
function toTraktDateParam(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function normalizeCalendarEntry(entry = {}) {
  const show = entry.show || {};
  const episode = entry.episode || {};
  const season = Number(episode.season || 0);
  const number = Number(episode.number || 0);
  const imdbId = show.ids?.imdb || null;
  const tmdbId = show.ids?.tmdb || null;
  const traktId = show.ids?.trakt || null;
  if (!entry.first_aired || season <= 0 || number <= 0 || (!imdbId && !tmdbId && !traktId)) {
    return null;
  }
  return {
    id: `${imdbId || traktId}:${season}:${number}`,
    title: episode.title || `S${season}E${number}`,
    season,
    episode: number,
    released: entry.first_aired,
    seriesImdbId: imdbId,
    seriesTmdbId: tmdbId,
    seriesTraktId: traktId,
    seriesName: show.title || "Untitled"
  };
}

export const traktCalendarService = {
  // mode: "all" (public, no auth) | "subscribed" (requires a Trakt account, your
  // watchlist/collection). days is capped by Trakt itself around 33; a 7-day
  // week is always well within range.
  async fetchCalendar({ mode = "all", startDate = new Date(), days = 7 } = {}) {
    if (mode === "subscribed") {
      const token = await TraktAuthService.getValidAccessToken();
      if (!token) {
        return { status: "unauthenticated", episodes: [] };
      }
      const path = `/calendars/my/shows/${toTraktDateParam(startDate)}/${days}`;
      const { response, payload } = await requestJson(path, { authorization: `Bearer ${token}` });
      if (!response.ok || !Array.isArray(payload)) {
        return { status: "error", episodes: [] };
      }
      return { status: "success", episodes: payload.map(normalizeCalendarEntry).filter(Boolean) };
    }

    const path = `/calendars/all/shows/${toTraktDateParam(startDate)}/${days}`;
    const { response, payload } = await requestJson(path);
    if (!response.ok || !Array.isArray(payload)) {
      return { status: "error", episodes: [] };
    }
    return { status: "success", episodes: payload.map(normalizeCalendarEntry).filter(Boolean) };
  }
};
