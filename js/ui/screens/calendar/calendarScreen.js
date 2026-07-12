import { Router } from "../../navigation/router.js";
import { ScreenUtils } from "../../navigation/screen.js";
import { Platform } from "../../../platform/index.js";
import { I18n } from "../../../i18n/index.js";
import { LayoutPreferences } from "../../../data/local/layoutPreferences.js";
import { metaRepository } from "../../../data/repository/metaRepository.js";
import { traktCalendarService } from "../../../data/repository/traktCalendarService.js";
import {
  focusWithoutAutoScroll,
  getRootSidebarSelectedNode
} from "../../components/sidebarNavigation.js";
import { RootSidebarController } from "../../components/rootSidebarController.js";

// Concurrency cap for poster-enrichment lookups against installed addons —
// bounded by however many distinct shows actually air in the visible range,
// which is naturally small for a week and capped-per-day for a month.
const POSTER_BATCH_SIZE = 6;
// Only the first couple of posters per day actually render in a month-grid
// cell; enriching more than that would cost a meta lookup per show for
// artwork nobody sees.
const MONTH_CELL_POSTER_LIMIT = 2;

// Actions that identify a *kind* of element rather than a specific instance
// (many day cells / list rows share the same data-action) — restoring focus
// by action alone would land on the first match in DOM order instead of the
// one the user actually had focused, so these rely on data-focus-key instead.
const NON_UNIQUE_ACTIONS = new Set(["openDetail", "calendarSelectDay"]);

function t(key, params = {}, fallback = key) {
  return I18n.t(key, params, { fallback });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function selectorValue(value) {
  const raw = String(value || "");
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(raw);
  }
  return raw.replace(/["\\]/g, "\\$&");
}

function calendarEmptyIconSvg() {
  return `
    <svg viewBox="0 0 256 256" class="library-empty-icon" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M208,32H184V24a8,8,0,0,0-16,0v8H88V24a8,8,0,0,0-16,0v8H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32ZM72,48v8a8,8,0,0,0,16,0V48h80v8a8,8,0,0,0,16,0V48h24V80H48V48ZM208,208H48V96H208V208Zm-68-76a12,12,0,1,1-12-12A12,12,0,0,1,140,132Zm44,0a12,12,0,1,1-12-12A12,12,0,0,1,184,132ZM96,172a12,12,0,1,1-12-12A12,12,0,0,1,96,172Zm44,0a12,12,0,1,1-12-12A12,12,0,0,1,140,172Zm44,0a12,12,0,1,1-12-12A12,12,0,0,1,184,172Z"/>
    </svg>
  `;
}

function caretLeftSvg() {
  return '<svg viewBox="0 0 256 256" class="calendar-week-nav-icon" aria-hidden="true" focusable="false"><path fill="currentColor" d="M165.66,202.34a8,8,0,0,1-11.32,11.32l-80-80a8,8,0,0,1,0-11.32l80-80a8,8,0,0,1,11.32,11.32L91.31,128Z"/></svg>';
}

function caretRightSvg() {
  return '<svg viewBox="0 0 256 256" class="calendar-week-nav-icon" aria-hidden="true" focusable="false"><path fill="currentColor" d="M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z"/></svg>';
}

function todayIconSvg() {
  return '<svg viewBox="0 0 256 256" class="calendar-today-icon" aria-hidden="true" focusable="false"><path fill="currentColor" d="M232,144a64.07,64.07,0,0,1-64,64H80a8,8,0,0,1,0-16h88a48,48,0,0,0,0-96H51.31l34.35,34.34a8,8,0,0,1-11.32,11.32l-48-48a8,8,0,0,1,0-11.32l48-48A8,8,0,0,1,85.66,45.66L51.31,80H168A64.07,64.07,0,0,1,232,144Z"/></svg>';
}

// A bare date ("2024-05-01") or a timestamp pinned to literal UTC midnight
// represents a date with no meaningful time component — take the leading
// Y-M-D as the intended local calendar day rather than converting a
// fabricated midnight through the viewer's timezone (which could shift it a
// day for negative UTC offsets). Trakt's `first_aired` is a real broadcast
// instant, though, so anything with an actual time-of-day is parsed as a
// true timestamp and converted to the viewer's local date — that's what
// actually determines which day it airs on for them.
function parseReleaseDate(released) {
  const raw = String(released || "").trim();
  if (!raw) {
    return null;
  }
  const dateOnlyMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.000)?Z?)?$/);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfDay(date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function addDays(date, delta) {
  const next = new Date(date);
  next.setDate(next.getDate() + delta);
  return next;
}

// Trakt's calendar weeks run Sunday-Saturday; mirror that so paging by
// week feels familiar to anyone coming from it.
function startOfWeek(date) {
  const day = startOfDay(date);
  day.setDate(day.getDate() - day.getDay());
  return day;
}

function startOfMonth(date) {
  const next = startOfDay(date);
  next.setDate(1);
  return next;
}

// Safe because monthStart is always the 1st — shifting a day-of-month that
// exists in every month never hits the "Jan 31 + 1 month" overflow case.
function addMonths(date, delta) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + delta);
  return next;
}

function daysInMonthCount(year, monthIndexZero) {
  return new Date(year, monthIndexZero + 1, 0).getDate();
}

function formatDayHeader(date) {
  const today = startOfDay(new Date());
  const isToday = dateKey(date) === dateKey(today);
  let weekdayDate;
  try {
    weekdayDate = date.toLocaleDateString(I18n.getLocale() || undefined, {
      weekday: "long",
      month: "short",
      day: "numeric"
    });
  } catch (_) {
    weekdayDate = date.toDateString();
  }
  return isToday ? `${t("calendar_today", {}, "Today")} · ${weekdayDate}` : weekdayDate;
}

function formatWeekRangeLabel(weekStart) {
  const weekEnd = addDays(weekStart, 6);
  const locale = I18n.getLocale() || undefined;
  try {
    const startLabel = weekStart.toLocaleDateString(locale, { month: "short", day: "numeric" });
    const endLabel = weekEnd.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" });
    return `${startLabel} – ${endLabel}`;
  } catch (_) {
    return `${weekStart.toDateString()} - ${weekEnd.toDateString()}`;
  }
}

function formatMonthLabel(monthStart) {
  const locale = I18n.getLocale() || undefined;
  try {
    return monthStart.toLocaleDateString(locale, { month: "long", year: "numeric" });
  } catch (_) {
    return `${monthStart.getMonth() + 1}/${monthStart.getFullYear()}`;
  }
}

function formatMonthListDayLabel(date) {
  const locale = I18n.getLocale() || undefined;
  try {
    return date.toLocaleDateString(locale, { month: "short", day: "numeric" });
  } catch (_) {
    return dateKey(date);
  }
}

// Monday-first short weekday labels for the month grid header, localized.
// 2024-01-01 is a known Monday, used purely as an anchor to read locale
// weekday names back out — the year/month themselves are irrelevant.
function getWeekdayLabels() {
  const locale = I18n.getLocale() || undefined;
  const fallback = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const reference = new Date(2024, 0, 1);
  const labels = [];
  for (let index = 0; index < 7; index += 1) {
    const date = addDays(reference, index);
    try {
      labels.push(date.toLocaleDateString(locale, { weekday: "short" }));
    } catch (_) {
      labels.push(fallback[index]);
    }
  }
  return labels;
}

// A show can be keyed by whichever id Trakt actually gave us — imdb is
// preferred since that's what installed addons key their meta lookups by.
function showKeyOf(episode) {
  if (episode.seriesImdbId) return episode.seriesImdbId;
  if (episode.seriesTmdbId) return `tmdb:${episode.seriesTmdbId}`;
  if (episode.seriesTraktId) return `trakt:${episode.seriesTraktId}`;
  return `name:${episode.seriesName}`;
}

// Buckets episodes into `count` consecutive days starting at `startDate`,
// each day sorted by show name then season/episode. Shared by the week (7
// days) and month (28-31 days) views.
function buildDayBuckets(episodes, startDate, count) {
  const days = [];
  for (let index = 0; index < count; index += 1) {
    const date = addDays(startDate, index);
    days.push({ key: dateKey(date), date, episodes: [] });
  }
  const dayByKey = new Map(days.map((day) => [day.key, day]));
  episodes.forEach((episode) => {
    if (!episode.releasedDate) {
      return;
    }
    const day = dayByKey.get(dateKey(episode.releasedDate));
    if (day) {
      day.episodes.push(episode);
    }
  });
  days.forEach((day) => {
    day.episodes.sort((left, right) => {
      const nameCompare = String(left.seriesName || "").localeCompare(String(right.seriesName || ""));
      if (nameCompare !== 0) return nameCompare;
      if (left.season !== right.season) return left.season - right.season;
      return left.episode - right.episode;
    });
  });
  return days;
}

function buildWeekGroups(episodes, weekStart) {
  return buildDayBuckets(episodes, weekStart, 7);
}

function buildMonthDays(episodes, monthStart, totalDays) {
  return buildDayBuckets(episodes, monthStart, totalDays);
}

// Leading blank cells so day 1 lands in its correct Monday-Sunday column;
// no trailing padding needed since a CSS grid can simply end mid-row.
function buildMonthGridCells(monthDays, monthStart) {
  const leadingBlanks = (monthStart.getDay() + 6) % 7;
  const cells = [];
  for (let index = 0; index < leadingBlanks; index += 1) {
    cells.push({ blank: true, key: `blank-${index}` });
  }
  monthDays.forEach((day) => cells.push(day));
  return cells;
}

export const CalendarScreen = {

  async mount() {
    this.container = document.getElementById("calendar");
    ScreenUtils.show(this.container);
    this.layoutPrefs = LayoutPreferences.get();
    RootSidebarController.register("calendar", {
      onCollapse: () => {
        const last = this.container?.querySelector(".focusable.focused")
          || this.container?.querySelector(".focusable");
        if (last) {
          this.container?.querySelectorAll(".focusable.focused").forEach((node) => node.classList.remove("focused"));
          last.classList.add("focused");
          focusWithoutAutoScroll(last);
        }
      }
    });
    this.calendarRouteEnterPending = true;
    this.weekStart = startOfWeek(new Date());
    this.monthStart = startOfMonth(new Date());
    this.mode = this.layoutPrefs?.calendarShowMode === "subscribed" ? "subscribed" : "all";
    // Month view is only meaningful for your own (small) show list — "all
    // shows" globally would be an unusable firehose of episodes per cell.
    this.viewMode = this.mode === "all" || this.layoutPrefs?.calendarViewMode === "week" ? "week" : "month";
    this.lastFocusedKey = null;
    this.lastFocusedAction = null;
    this.weekCache = new Map();
    this.monthCache = new Map();
    this.groups = [];
    this.monthDays = [];
    this.selectedDayKey = null;
    this.authRequired = false;
    this.loadError = false;
    this.hasLoadedOnce = false;
    this.loading = false;

    await this.load();
  },

  load() {
    return this.viewMode === "month" ? this.loadMonth() : this.loadWeek();
  },

  async fetchCalendarEpisodes(startDate, days) {
    const result = await traktCalendarService.fetchCalendar({ mode: this.mode, startDate, days });
    if (result.status === "unauthenticated") {
      return "unauthenticated";
    }
    if (result.status !== "success") {
      throw new Error("Trakt calendar request failed");
    }
    return result.episodes
      .map((episode) => ({ ...episode, releasedDate: parseReleaseDate(episode.released) }))
      .filter((episode) => episode.releasedDate);
  },

  async loadWeek() {
    const token = (this.loadToken = (this.loadToken || 0) + 1);
    const cacheKey = `${this.mode}:${dateKey(this.weekStart)}`;
    this.authRequired = false;
    this.loadError = false;

    const cached = this.weekCache.get(cacheKey);
    if (cached) {
      this.groups = cached;
      this.loading = false;
      this.hasLoadedOnce = true;
      this.render();
      return;
    }

    this.loading = true;
    this.render();

    try {
      const episodes = await this.fetchCalendarEpisodes(this.weekStart, 7);
      if (this.loadToken !== token) {
        return;
      }
      if (episodes === "unauthenticated") {
        this.authRequired = true;
        this.groups = [];
      } else {
        await this.enrichPosters(episodes, token);
        if (this.loadToken !== token) {
          return;
        }
        const groups = buildWeekGroups(episodes, this.weekStart);
        this.weekCache.set(cacheKey, groups);
        this.groups = groups;
      }
    } catch (error) {
      if (this.loadToken !== token) {
        return;
      }
      console.error("calendarScreen: failed to load calendar week", error);
      this.loadError = true;
      this.groups = [];
    } finally {
      if (this.loadToken === token) {
        this.loading = false;
        this.hasLoadedOnce = true;
        this.render();
      }
    }
  },

  async loadMonth() {
    const token = (this.loadToken = (this.loadToken || 0) + 1);
    const year = this.monthStart.getFullYear();
    const month = this.monthStart.getMonth();
    const cacheKey = `${this.mode}:${year}-${String(month + 1).padStart(2, "0")}`;
    this.authRequired = false;
    this.loadError = false;

    const cached = this.monthCache.get(cacheKey);
    if (cached) {
      this.monthDays = cached;
      this.loading = false;
      this.hasLoadedOnce = true;
      this.ensureSelectedDay();
      this.render();
      return;
    }

    this.loading = true;
    this.render();

    try {
      const totalDays = daysInMonthCount(year, month);
      const episodes = await this.fetchCalendarEpisodes(this.monthStart, totalDays);
      if (this.loadToken !== token) {
        return;
      }
      if (episodes === "unauthenticated") {
        this.authRequired = true;
        this.monthDays = [];
      } else {
        const monthDays = buildMonthDays(episodes, this.monthStart, totalDays);
        const toEnrich = [];
        monthDays.forEach((day) => {
          day.episodes.slice(0, MONTH_CELL_POSTER_LIMIT).forEach((episode) => toEnrich.push(episode));
        });
        await this.enrichPosters(toEnrich, token);
        if (this.loadToken !== token) {
          return;
        }
        this.monthCache.set(cacheKey, monthDays);
        this.monthDays = monthDays;
        this.ensureSelectedDay();
      }
    } catch (error) {
      if (this.loadToken !== token) {
        return;
      }
      console.error("calendarScreen: failed to load calendar month", error);
      this.loadError = true;
      this.monthDays = [];
    } finally {
      if (this.loadToken === token) {
        this.loading = false;
        this.hasLoadedOnce = true;
        this.render();
      }
    }
  },

  // Defaults the selected day to today (only when viewing the actual current
  // month), else the first day with episodes, else the 1st — but leaves an
  // already-valid selection alone so re-renders don't keep resetting it.
  ensureSelectedDay() {
    if (!this.monthDays.length) {
      this.selectedDayKey = null;
      return;
    }
    if (this.selectedDayKey && this.monthDays.some((day) => day.key === this.selectedDayKey)) {
      return;
    }
    const isCurrentMonth = dateKey(startOfMonth(new Date())) === dateKey(this.monthStart);
    const todayKey = dateKey(startOfDay(new Date()));
    if (isCurrentMonth && this.monthDays.some((day) => day.key === todayKey)) {
      this.selectedDayKey = todayKey;
      return;
    }
    const firstWithEpisodes = this.monthDays.find((day) => day.episodes.length > 0);
    this.selectedDayKey = (firstWithEpisodes || this.monthDays[0]).key;
  },

  // Trakt's calendar doesn't include artwork, so posters are resolved
  // separately through whichever installed addon can serve meta for the
  // show's imdb id — the same mechanism the rest of the app already uses.
  async enrichPosters(episodes, token) {
    const imdbIdByKey = new Map();
    episodes.forEach((episode) => {
      const key = showKeyOf(episode);
      if (!imdbIdByKey.has(key) && episode.seriesImdbId) {
        imdbIdByKey.set(key, episode.seriesImdbId);
      }
    });

    const entries = Array.from(imdbIdByKey.entries());
    const posterByKey = new Map();
    for (let index = 0; index < entries.length; index += POSTER_BATCH_SIZE) {
      if (this.loadToken !== token) {
        return;
      }
      const batch = entries.slice(index, index + POSTER_BATCH_SIZE);
      await Promise.all(batch.map(async ([key, imdbId]) => {
        try {
          const result = await metaRepository.getMetaFromAllAddons("series", imdbId);
          if (result?.status === "success" && result?.data?.poster) {
            posterByKey.set(key, result.data.poster);
          }
        } catch (_) {
          // No poster available from any installed addon; the card falls
          // back to a placeholder rather than failing the whole load.
        }
      }));
    }

    episodes.forEach((episode) => {
      episode.seriesPoster = posterByKey.get(showKeyOf(episode)) || null;
    });
  },

  bindEvents() {
    if (!this.container || this.container.__calendarEventsBound) {
      return;
    }
    this.container.__calendarEventsBound = true;
    this.container.addEventListener("click", (event) => {
      const target = event.target?.closest?.(".focusable");
      if (!target || !this.container.contains(target)) {
        return;
      }
      this.setFocusedNode(target);
      this.activateNode(target);
    });
  },

  setFocusedNode(target) {
    this.container?.querySelectorAll(".focusable.focused").forEach((node) => {
      if (node !== target) {
        node.classList.remove("focused");
      }
    });
    target.classList.add("focused");
    // preventScroll + an explicit, consistent scrollIntoView avoids a feedback
    // loop with the geometry-based dpad nav: native focus-triggered auto-scroll
    // shifts element positions between key presses, which previously made
    // ArrowUp read stale geometry and oscillate between two same-row cards
    // instead of advancing to the row above.
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({ behavior: "smooth", block: "nearest", inline: "nearest" });
    if (target.dataset.focusKey) {
      this.lastFocusedKey = String(target.dataset.focusKey);
    }
    if (target.dataset.action && !NON_UNIQUE_ACTIONS.has(target.dataset.action)) {
      this.lastFocusedAction = String(target.dataset.action);
    }
  },

  activateNode(node) {
    if (!node) {
      return;
    }
    const action = String(node.dataset.action || "");
    if (action === "openDetail") {
      Router.navigate("detail", {
        itemId: node.dataset.itemId,
        itemType: node.dataset.itemType || "series",
        fallbackTitle: node.dataset.itemTitle || "Untitled"
      });
      return;
    }
    if (action === "calendarPrevWeek") {
      this.shiftWeek(-7);
      return;
    }
    if (action === "calendarNextWeek") {
      this.shiftWeek(7);
      return;
    }
    if (action === "calendarToday") {
      this.goToCurrentWeek();
      return;
    }
    if (action === "calendarPrevMonth") {
      this.shiftMonth(-1);
      return;
    }
    if (action === "calendarNextMonth") {
      this.shiftMonth(1);
      return;
    }
    if (action === "calendarThisMonth") {
      this.goToCurrentMonth();
      return;
    }
    if (action === "calendarSelectDay") {
      this.selectDay(String(node.dataset.dayKey || ""));
      return;
    }
    if (action === "calendarModeAll" || action === "calendarModeSubscribed") {
      this.setMode(action === "calendarModeAll" ? "all" : "subscribed");
      return;
    }
    if (action === "calendarViewWeek" || action === "calendarViewMonth") {
      this.setViewMode(action === "calendarViewWeek" ? "week" : "month");
      return;
    }
    if (action === "openTraktSettings") {
      Router.navigate("trakt");
    }
  },

  setMode(mode) {
    if (mode === this.mode) {
      return;
    }
    this.mode = mode;
    this.lastFocusedAction = mode === "all" ? "calendarModeAll" : "calendarModeSubscribed";
    LayoutPreferences.set({ calendarShowMode: mode });
    // Month view isn't offered for "all shows" — force back to week if the
    // user had month selected while switching into that mode.
    if (mode === "all" && this.viewMode === "month") {
      this.viewMode = "week";
      LayoutPreferences.set({ calendarViewMode: "week" });
    }
    this.load();
  },

  setViewMode(viewMode) {
    if (viewMode === this.viewMode || (viewMode === "month" && this.mode === "all")) {
      return;
    }
    this.viewMode = viewMode;
    this.lastFocusedAction = viewMode === "week" ? "calendarViewWeek" : "calendarViewMonth";
    LayoutPreferences.set({ calendarViewMode: viewMode });
    this.load();
  },

  shiftWeek(deltaDays) {
    this.weekStart = addDays(this.weekStart, deltaDays);
    this.loadWeek();
  },

  goToCurrentWeek() {
    this.lastFocusedAction = "calendarNextWeek";
    this.weekStart = startOfWeek(new Date());
    this.loadWeek();
  },

  shiftMonth(deltaMonths) {
    this.monthStart = addMonths(this.monthStart, deltaMonths);
    this.selectedDayKey = null;
    this.loadMonth();
  },

  goToCurrentMonth() {
    this.lastFocusedAction = "calendarNextMonth";
    this.monthStart = startOfMonth(new Date());
    this.selectedDayKey = null;
    this.loadMonth();
  },

  selectDay(dayKey) {
    if (!dayKey || dayKey === this.selectedDayKey) {
      return;
    }
    this.selectedDayKey = dayKey;
    this.lastFocusedKey = `day:${dayKey}`;
    this.render();
  },

  shouldTransferToSidebar(node) {
    if (!node) {
      return false;
    }
    // Auth-required state renders a single centered button with no header
    // rows — nothing is ever to its left, but it also never sits within the
    // left-edge threshold below, so Left must still reach the sidebar.
    if (this.authRequired) {
      return true;
    }
    const main = this.container?.querySelector(".home-main");
    if (!main || !main.contains(node)) {
      return false;
    }
    const nodeRect = node.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    return (nodeRect.left - mainRect.left) <= 140;
  },

  // The mode-row buttons ("All Shows"/"My Shows") sit almost directly above
  // the Prev-week button, so the generic geometry-based dpad nav (nearest by
  // raw x-distance) picks that row over the actual same-row neighbor
  // (Today/Next), which sits much farther right but is the correct target.
  // Handle Left/Right within this specific row explicitly instead of relying
  // on geometry once the sidebar-transfer case is ruled out.
  handleNavRowLeftRight(event, current) {
    const navRow = current?.closest?.(".calendar-week-nav");
    if (!navRow) {
      return false;
    }
    const code = Number(event?.keyCode || 0);
    const delta = code === 37 ? -1 : code === 39 ? 1 : 0;
    if (!delta) {
      return false;
    }
    const buttons = Array.from(navRow.querySelectorAll(".focusable"));
    const currentIndex = buttons.indexOf(current);
    if (currentIndex === -1) {
      return false;
    }
    const nextIndex = currentIndex + delta;
    if (nextIndex < 0 || nextIndex >= buttons.length) {
      return false;
    }
    event?.preventDefault?.();
    this.setFocusedNode(buttons[nextIndex]);
    return true;
  },

  renderEpisodeCard(episode) {
    const focusKey = `card:${showKeyOf(episode)}:${episode.id}`;
    const canOpenDetail = Boolean(episode.seriesImdbId);
    return `
      <article class="calendar-episode-card${canOpenDetail ? " focusable" : ""}"
               ${canOpenDetail ? `data-action="openDetail" data-item-id="${escapeHtml(episode.seriesImdbId)}" data-item-type="series" data-item-title="${escapeHtml(episode.seriesName || "Untitled")}"` : ""}
               data-focus-key="${escapeHtml(focusKey)}">
        <div class="calendar-episode-poster-wrap">
          <div class="calendar-episode-poster${episode.seriesPoster ? "" : " placeholder"}"${episode.seriesPoster ? ` style="background-image:url('${escapeHtml(episode.seriesPoster)}')"` : ""}></div>
        </div>
        <div class="calendar-episode-info">
          <div class="calendar-episode-show">${escapeHtml(episode.seriesName || "Untitled")}</div>
          <div class="calendar-episode-meta">${escapeHtml(`S${episode.season}E${episode.episode}`)}</div>
          <div class="calendar-episode-title">${escapeHtml(episode.title || "")}</div>
        </div>
      </article>
    `;
  },

  renderModeRow() {
    const isAll = this.mode !== "subscribed";
    return `
      <div class="calendar-mode-row">
        <button class="calendar-mode-button focusable${!isAll ? " selected" : ""}" data-action="calendarModeSubscribed">${escapeHtml(t("calendar_mode_subscribed", {}, "My Shows"))}</button>
        <button class="calendar-mode-button focusable${isAll ? " selected" : ""}" data-action="calendarModeAll">${escapeHtml(t("calendar_mode_all", {}, "All Shows"))}</button>
      </div>
    `;
  },

  renderViewModeRow() {
    // Month view isn't offered for "all shows" — a global firehose of
    // episodes per day cell isn't useful, and only week paging makes sense.
    if (this.mode === "all") {
      return "";
    }
    const isWeek = this.viewMode === "week";
    return `
      <div class="calendar-mode-row calendar-view-mode-row">
        <button class="calendar-mode-button focusable${!isWeek ? " selected" : ""}" data-action="calendarViewMonth">${escapeHtml(t("calendar_view_month", {}, "Month"))}</button>
        <button class="calendar-mode-button focusable${isWeek ? " selected" : ""}" data-action="calendarViewWeek">${escapeHtml(t("calendar_view_week", {}, "Week"))}</button>
      </div>
    `;
  },

  renderWeekNav(weekRangeLabel, isCurrentWeek) {
    const prevLabel = t("calendar_prev_week", {}, "Previous week");
    const nextLabel = t("calendar_next_week", {}, "Next week");
    const todayLabel = t("calendar_today", {}, "Today");
    return `
      <div class="calendar-week-nav">
        <button class="calendar-week-nav-button focusable" data-action="calendarPrevWeek" aria-label="${escapeHtml(prevLabel)}" title="${escapeHtml(prevLabel)}">${caretLeftSvg()}</button>
        <div class="calendar-week-range">
          <span class="calendar-week-label">${escapeHtml(weekRangeLabel)}</span>
          ${!isCurrentWeek ? `<button class="calendar-today-button focusable" data-action="calendarToday" title="${escapeHtml(todayLabel)}">${todayIconSvg()}${escapeHtml(todayLabel)}</button>` : ""}
        </div>
        <button class="calendar-week-nav-button focusable" data-action="calendarNextWeek" aria-label="${escapeHtml(nextLabel)}" title="${escapeHtml(nextLabel)}">${caretRightSvg()}</button>
      </div>
    `;
  },

  renderMonthNav() {
    const isCurrentMonth = dateKey(startOfMonth(new Date())) === dateKey(this.monthStart);
    const prevLabel = t("calendar_prev_month", {}, "Previous month");
    const nextLabel = t("calendar_next_month", {}, "Next month");
    const todayLabel = t("calendar_today", {}, "Today");
    return `
      <div class="calendar-week-nav">
        <button class="calendar-week-nav-button focusable" data-action="calendarPrevMonth" aria-label="${escapeHtml(prevLabel)}" title="${escapeHtml(prevLabel)}">${caretLeftSvg()}</button>
        <div class="calendar-week-range">
          <span class="calendar-week-label">${escapeHtml(formatMonthLabel(this.monthStart))}</span>
          ${!isCurrentMonth ? `<button class="calendar-today-button focusable" data-action="calendarThisMonth" title="${escapeHtml(todayLabel)}">${todayIconSvg()}${escapeHtml(todayLabel)}</button>` : ""}
        </div>
        <button class="calendar-week-nav-button focusable" data-action="calendarNextMonth" aria-label="${escapeHtml(nextLabel)}" title="${escapeHtml(nextLabel)}">${caretRightSvg()}</button>
      </div>
    `;
  },

  renderDayGroups(groups) {
    return `
      <div class="calendar-content">
        ${groups.map((group) => `
          <section class="calendar-day-group">
            <h2 class="calendar-day-header">${escapeHtml(formatDayHeader(group.date))}</h2>
            ${group.episodes.length
    ? `<div class="calendar-episode-grid">${group.episodes.map((episode) => this.renderEpisodeCard(episode)).join("")}</div>`
    : `<div class="calendar-day-empty">${escapeHtml(t("calendar_day_empty", {}, "No episodes"))}</div>`}
          </section>
        `).join("")}
      </div>
    `;
  },

  renderMonthDayCell(cell) {
    if (cell.blank) {
      return `<div class="calendar-month-day calendar-month-day-blank"></div>`;
    }
    const isToday = cell.key === dateKey(startOfDay(new Date()));
    const isSelected = cell.key === this.selectedDayKey;
    const posters = cell.episodes.slice(0, MONTH_CELL_POSTER_LIMIT);
    return `
      <div class="calendar-month-day focusable${isSelected ? " selected" : ""}"
           data-action="calendarSelectDay"
           data-day-key="${escapeHtml(cell.key)}"
           data-focus-key="day:${escapeHtml(cell.key)}">
        <span class="calendar-month-day-number${isToday ? " today" : ""}">${cell.date.getDate()}</span>
        ${posters.length ? `
          <div class="calendar-month-day-posters">
            ${posters.map((episode) => `<div class="calendar-month-day-poster${episode.seriesPoster ? "" : " placeholder"}"${episode.seriesPoster ? ` style="background-image:url('${escapeHtml(episode.seriesPoster)}')"` : ""}></div>`).join("")}
          </div>
        ` : ""}
      </div>
    `;
  },

  renderMonthListRow(episode) {
    const canOpenDetail = Boolean(episode.seriesImdbId);
    const focusKey = `row:${showKeyOf(episode)}:${episode.id}`;
    return `
      <button class="calendar-month-list-row${canOpenDetail ? " focusable" : ""}"
              ${canOpenDetail ? `data-action="openDetail" data-item-id="${escapeHtml(episode.seriesImdbId)}" data-item-type="series" data-item-title="${escapeHtml(episode.seriesName || "Untitled")}"` : ""}
              data-focus-key="${escapeHtml(focusKey)}">
        <span class="calendar-month-list-show">${escapeHtml(episode.seriesName || "Untitled")}</span>
        <span class="calendar-month-list-meta">${escapeHtml(`S${episode.season}E${episode.episode}`)}</span>
      </button>
    `;
  },

  renderMonthListDay(day) {
    const isSelected = day.key === this.selectedDayKey;
    return `
      <section class="calendar-month-list-day${isSelected ? " selected" : ""}" data-day-key="${escapeHtml(day.key)}">
        <h3 class="calendar-month-list-date">${escapeHtml(formatMonthListDayLabel(day.date))}</h3>
        ${day.episodes.map((episode) => this.renderMonthListRow(episode)).join("")}
      </section>
    `;
  },

  renderMonthView() {
    if (!this.monthDays.length) {
      return this.renderEmptyState();
    }
    const cells = buildMonthGridCells(this.monthDays, this.monthStart);
    const weekdayLabels = getWeekdayLabels();
    const daysWithEpisodes = this.monthDays.filter((day) => day.episodes.length > 0);
    return `
      <div class="calendar-month-view">
        <div class="calendar-month-grid-wrap">
          <div class="calendar-month-weekday-row">
            ${weekdayLabels.map((label) => `<div class="calendar-month-weekday">${escapeHtml(label)}</div>`).join("")}
          </div>
          <div class="calendar-month-grid">
            ${cells.map((cell) => this.renderMonthDayCell(cell)).join("")}
          </div>
        </div>
        <div class="calendar-month-list">
          ${daysWithEpisodes.length
    ? daysWithEpisodes.map((day) => this.renderMonthListDay(day)).join("")
    : `<div class="calendar-day-empty calendar-month-list-empty">${escapeHtml(t("calendar_day_empty", {}, "No episodes"))}</div>`}
        </div>
      </div>
    `;
  },

  renderEmptyState() {
    const subtitleKey = this.mode === "subscribed" ? "calendar_empty_subtitle_subscribed" : "calendar_empty_subtitle_all";
    const subtitleFallback = this.mode === "subscribed"
      ? "None of the shows you follow have new episodes in this period."
      : "Nothing appears to be airing in this period.";
    return `
      <section class="library-empty-state">
        ${calendarEmptyIconSvg()}
        <h3 class="library-empty-title">${escapeHtml(t("calendar_empty_title", {}, "No episodes"))}</h3>
        <p class="library-empty-subtitle">${escapeHtml(t(subtitleKey, {}, subtitleFallback))}</p>
      </section>
    `;
  },

  renderAuthRequiredState() {
    return `
      <section class="library-empty-state">
        ${calendarEmptyIconSvg()}
        <h3 class="library-empty-title">${escapeHtml(t("calendar_auth_required_title", {}, "Connect Trakt to see your shows"))}</h3>
        <p class="library-empty-subtitle">${escapeHtml(t("calendar_auth_required_subtitle", {}, "Sign in with Trakt in Settings to see episodes for the shows you follow."))}</p>
        <button class="library-action-button focusable" data-action="openTraktSettings">${escapeHtml(t("calendar_open_trakt_settings", {}, "Open Trakt Settings"))}</button>
      </section>
    `;
  },

  renderErrorState() {
    return `
      <section class="library-empty-state">
        ${calendarEmptyIconSvg()}
        <h3 class="library-empty-title">${escapeHtml(t("calendar_error_title", {}, "Couldn't load calendar"))}</h3>
        <p class="library-empty-subtitle">${escapeHtml(t("calendar_error_subtitle", {}, "Something went wrong reaching Trakt. Try again in a moment."))}</p>
      </section>
    `;
  },

  render() {
    this.layoutPrefs = LayoutPreferences.get();
    const enterClass = this.calendarRouteEnterPending ? " nuvio-route-slide-enter" : "";
    this.calendarRouteEnterPending = false;

    if (this.loading && !this.hasLoadedOnce) {
      this.container.innerHTML = `
        <div class="home-shell calendar-shell">
          <main class="home-main calendar-main">
            <section class="library-loading-state">
              <div class="library-loading-spinner" aria-hidden="true"></div>
              <div class="library-loading-label">${escapeHtml(t("calendar_loading", {}, "Loading calendar…"))}</div>
            </section>
          </main>
        </div>
      `;
      return;
    }

    let bodyMarkup;
    if (this.authRequired) {
      bodyMarkup = this.renderAuthRequiredState();
    } else if (this.loading) {
      bodyMarkup = `
        <section class="library-loading-state calendar-inline-loading">
          <div class="library-loading-spinner" aria-hidden="true"></div>
        </section>
      `;
    } else if (this.loadError) {
      bodyMarkup = this.renderErrorState();
    } else if (this.viewMode === "month") {
      bodyMarkup = this.renderMonthView();
    } else {
      const hasAnyEpisodes = this.groups.some((group) => group.episodes.length > 0);
      bodyMarkup = hasAnyEpisodes ? this.renderDayGroups(this.groups) : this.renderEmptyState();
    }

    const navMarkup = this.viewMode === "month"
      ? this.renderMonthNav()
      : this.renderWeekNav(formatWeekRangeLabel(this.weekStart), dateKey(this.weekStart) === dateKey(startOfWeek(new Date())));

    const headerMarkup = this.authRequired
      ? ""
      : `
            <div class="calendar-header-buttons">
              ${this.renderModeRow()}
              ${this.renderViewModeRow()}
            </div>
            <div class="calendar-header">
              ${navMarkup}
            </div>
      `;

    this.container.innerHTML = `
      <div class="home-shell calendar-shell">
        <main class="home-main calendar-main${enterClass}">
          <section class="library-page calendar-page">
            <header class="library-page-header">
              <h1 class="library-page-title">${escapeHtml(t("calendar_title", {}, "Calendar"))}</h1>
            </header>
            ${headerMarkup}
            ${bodyMarkup}
          </section>
        </main>
      </div>
    `;

    ScreenUtils.indexFocusables(this.container);
    this.bindEvents();
    this.restoreFocus();
    this.scrollSelectedDayIntoView();
  },

  scrollSelectedDayIntoView() {
    if (this.viewMode !== "month" || !this.selectedDayKey) {
      return;
    }
    const key = this.selectedDayKey;
    // restoreFocus() just called .focus() on the grid cell, which triggers
    // the browser's own scroll-into-view for that cell — deferred to the
    // next frame so this scroll (to the matching list section) applies
    // after that one and wins as the final position.
    requestAnimationFrame(() => {
      if (this.selectedDayKey !== key) {
        return;
      }
      const section = this.container?.querySelector(
        `.calendar-month-list-day[data-day-key="${selectorValue(key)}"]`
      );
      section?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    });
  },

  restoreFocus() {
    const target = (this.lastFocusedAction
      ? this.container?.querySelector(`.focusable[data-action="${selectorValue(this.lastFocusedAction)}"]`)
      : null)
      || (this.lastFocusedKey
        ? this.container?.querySelector(`.focusable[data-focus-key="${selectorValue(this.lastFocusedKey)}"]`)
        : null)
      || this.container?.querySelector('[data-action="calendarNextWeek"], [data-action="calendarNextMonth"]')
      || this.container?.querySelector(".calendar-episode-card.focusable, .calendar-month-day.focusable, .calendar-month-list-row.focusable")
      || getRootSidebarSelectedNode(this.container, this.layoutPrefs)
      || null;
    if (!target) {
      return;
    }
    this.setFocusedNode(target);
  },

  async onKeyDown(event) {
    if (Platform.isBackEvent(event)) {
      event?.preventDefault?.();
      await Router.back();
      return;
    }

    if (RootSidebarController.hasFocus) {
      return;
    }

    const current = this.container?.querySelector(".focusable.focused");
    const code = Number(event?.keyCode || 0);

    if (code === 37 && this.shouldTransferToSidebar(current)) {
      event?.preventDefault?.();
      RootSidebarController.expand();
      return;
    }

    if ((code === 37 || code === 39) && this.handleNavRowLeftRight(event, current)) {
      return;
    }

    if (ScreenUtils.handleDpadNavigation(event, this.container, ".home-main .focusable")) {
      return;
    }

    if (code !== 13 || !current) {
      return;
    }
    // Several calendar controls (nav arrows, Today, mode/view toggles) are
    // real <button> elements — without preventDefault, the browser's own
    // "Enter activates the focused button" behavior fires a *second*, native
    // click after this handler runs. Since activateNode() below can
    // synchronously re-render and move focus (e.g. Today jumps to the
    // current week and refocuses "Next"), that phantom click was landing on
    // whatever ended up focused afterward and firing its action too —
    // e.g. pressing Enter on Today would jump to the current week and then
    // immediately jump forward another week again.
    event?.preventDefault?.();
    this.activateNode(current);
  },

  cleanup() {
    RootSidebarController.unregister("calendar");
    this.loadToken = (this.loadToken || 0) + 1;
    ScreenUtils.hide(this.container);
  }

};
