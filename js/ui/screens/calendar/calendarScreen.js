import { Router } from "../../navigation/router.js";
import { ScreenUtils } from "../../navigation/screen.js";
import { Platform } from "../../../platform/index.js";
import { I18n } from "../../../i18n/index.js";
import { LayoutPreferences } from "../../../data/local/layoutPreferences.js";
import { addonRepository } from "../../../data/repository/addonRepository.js";
import { catalogRepository } from "../../../data/repository/catalogRepository.js";
import { metaRepository } from "../../../data/repository/metaRepository.js";
import { normalizeEpisodes } from "../../../data/repository/episodeUtils.js";
import {
  focusWithoutAutoScroll,
  getRootSidebarSelectedNode
} from "../../components/sidebarNavigation.js";
import { RootSidebarController } from "../../components/rootSidebarController.js";

const META_BATCH_SIZE = 6;
// Bounds how many distinct shows get a meta/episode lookup per load — catalog
// browsing (unlike a personal library) has no natural upper bound, and each
// show costs a network round-trip, so this caps worst-case load time.
const CALENDAR_MAX_CATALOG_SHOWS = 150;

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

// Air-date strings are date-only in practice ("2024-05-01" or a full ISO
// timestamp); parsing via explicit local y/m/d avoids UTC-vs-local off-by-one
// day shifts that `new Date("2024-05-01")` (parsed as UTC midnight) would
// introduce for viewers west of UTC.
function parseReleaseDate(released) {
  const raw = String(released || "").trim();
  if (!raw) {
    return null;
  }
  const dateOnlyMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
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

// Builds all 7 days of the given week (Sun-Sat) up front, including days
// with no episodes, so the week's shape is always visible — matching a
// week-agenda view rather than a sparse flat list.
function buildWeekGroups(episodes = [], weekStart) {
  const days = [];
  for (let index = 0; index < 7; index += 1) {
    const date = addDays(weekStart, index);
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
    this.loading = true;
    this.allEpisodes = [];
    this.weekStart = startOfWeek(new Date());
    this.lastFocusedKey = null;
    this.lastFocusedAction = null;
    this.loadToken = (this.loadToken || 0) + 1;
    const token = this.loadToken;

    this.render();

    try {
      const episodes = await this.loadEpisodes(token);
      if (this.loadToken !== token) {
        return;
      }
      this.allEpisodes = episodes;
    } catch (error) {
      console.error("calendarScreen: failed to load calendar", error);
      this.allEpisodes = [];
    } finally {
      if (this.loadToken === token) {
        this.loading = false;
        this.render();
      }
    }
  },

  // Browses every installed addon's non-movie/non-channel catalogs (first
  // page only) the same way discoverScreen does, dedupes shows by type+id
  // across addons/catalogs, and caps the total so a large addon collection
  // can't turn into hundreds of meta round-trips.
  async collectCatalogSeries() {
    const addons = await addonRepository.getInstalledAddons();
    const catalogTargets = [];
    addons.forEach((addon) => {
      (addon.catalogs || []).forEach((catalog) => {
        const type = String(catalog.apiType || "").trim().toLowerCase();
        if (!type || type === "movie" || type === "channel") {
          return;
        }
        // Only treat a catalog as search-only when search is *required* — most
        // browsable catalogs (Cinemeta's "Popular"/"New" included) also list an
        // optional "search" extra to let you filter within them, which isn't
        // the same as needing a query just to list anything.
        const isSearchOnly = (catalog.extra || []).some((extra) => extra?.name === "search" && extra?.isRequired);
        if (isSearchOnly) {
          return;
        }
        catalogTargets.push({ addon, catalog, type });
      });
    });

    const catalogResults = await Promise.all(catalogTargets.map(async ({ addon, catalog, type }) => {
      try {
        const result = await catalogRepository.getCatalog({
          addonBaseUrl: addon.baseUrl,
          addonId: addon.id,
          addonName: addon.displayName || addon.name,
          catalogId: catalog.id,
          catalogName: catalog.name || catalog.id,
          type,
          skip: 0,
          extraArgs: {},
          supportsSkip: true
        });
        if (result?.status !== "success") {
          return [];
        }
        const items = Array.isArray(result?.data?.items) ? result.data.items : [];
        return items
          .filter((item) => item?.id)
          .map((item) => ({ id: item.id, type, name: item.name, poster: item.poster }));
      } catch (_) {
        return [];
      }
    }));

    const uniqueSeries = new Map();
    catalogResults.flat().forEach((item) => {
      if (uniqueSeries.size >= CALENDAR_MAX_CATALOG_SHOWS) {
        return;
      }
      const key = `${item.type}:${item.id}`;
      if (!uniqueSeries.has(key)) {
        uniqueSeries.set(key, item);
      }
    });
    return Array.from(uniqueSeries.values());
  },

  async loadEpisodes(token) {
    const seriesItems = await this.collectCatalogSeries();

    const flatEpisodes = [];
    for (let index = 0; index < seriesItems.length; index += META_BATCH_SIZE) {
      if (this.loadToken !== token) {
        return [];
      }
      const batch = seriesItems.slice(index, index + META_BATCH_SIZE);
      await Promise.all(batch.map(async (series) => {
        try {
          const result = await metaRepository.getMetaFromAllAddons(series.type, series.id);
          if (result?.status !== "success" || !result?.data) {
            return;
          }
          const episodes = normalizeEpisodes(result.data.videos || []);
          episodes.forEach((episode) => {
            const releasedDate = parseReleaseDate(episode.released);
            if (!releasedDate) {
              return;
            }
            flatEpisodes.push({
              ...episode,
              releasedDate,
              seriesId: series.id,
              seriesType: series.type,
              seriesName: series.name || series.id,
              seriesPoster: series.poster || null
            });
          });
        } catch (_) {
          // Addons that fail to resolve meta are skipped; the calendar shows
          // whatever episodes did resolve rather than failing the whole screen.
        }
      }));
    }
    return flatEpisodes;
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
    target.focus();
    if (target.dataset.focusKey) {
      this.lastFocusedKey = String(target.dataset.focusKey);
    }
    if (target.dataset.action && target.dataset.action !== "openDetail") {
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
    }
  },

  shiftWeek(deltaDays) {
    this.weekStart = addDays(this.weekStart, deltaDays);
    this.render();
  },

  goToCurrentWeek() {
    this.lastFocusedAction = "calendarNextWeek";
    this.weekStart = startOfWeek(new Date());
    this.render();
  },

  shouldTransferToSidebar(node) {
    if (!node) {
      return false;
    }
    const main = this.container?.querySelector(".home-main");
    if (!main || !main.contains(node)) {
      return false;
    }
    const nodeRect = node.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    return (nodeRect.left - mainRect.left) <= 140;
  },

  renderEpisodeCard(episode) {
    const focusKey = `${episode.seriesId}:${episode.id}`;
    return `
      <article class="calendar-episode-card focusable"
               data-action="openDetail"
               data-item-id="${escapeHtml(episode.seriesId)}"
               data-item-type="${escapeHtml(episode.seriesType || "series")}"
               data-item-title="${escapeHtml(episode.seriesName || "Untitled")}"
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

  renderWeekNav(weekRangeLabel, isCurrentWeek) {
    return `
      <div class="calendar-week-nav">
        <button class="calendar-week-nav-button focusable" data-action="calendarPrevWeek" aria-label="${escapeHtml(t("calendar_prev_week", {}, "Previous week"))}">${caretLeftSvg()}</button>
        <div class="calendar-week-range">
          <span class="calendar-week-label">${escapeHtml(weekRangeLabel)}</span>
          ${!isCurrentWeek ? `<button class="calendar-today-button focusable" data-action="calendarToday">${escapeHtml(t("calendar_today", {}, "Today"))}</button>` : ""}
        </div>
        <button class="calendar-week-nav-button focusable" data-action="calendarNextWeek" aria-label="${escapeHtml(t("calendar_next_week", {}, "Next week"))}">${caretRightSvg()}</button>
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

  renderEmptyState() {
    return `
      <section class="library-empty-state">
        ${calendarEmptyIconSvg()}
        <h3 class="library-empty-title">${escapeHtml(t("calendar_empty_title", {}, "No upcoming episodes"))}</h3>
        <p class="library-empty-subtitle">${escapeHtml(t("calendar_empty_subtitle", {}, "Install an addon with series catalogs to see upcoming episodes here."))}</p>
      </section>
    `;
  },

  render() {
    this.layoutPrefs = LayoutPreferences.get();
    const enterClass = this.calendarRouteEnterPending ? " nuvio-route-slide-enter" : "";
    this.calendarRouteEnterPending = false;

    if (this.loading) {
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

    const hasAnyEpisodes = this.allEpisodes.length > 0;
    const groups = hasAnyEpisodes ? buildWeekGroups(this.allEpisodes, this.weekStart) : [];
    const isCurrentWeek = dateKey(this.weekStart) === dateKey(startOfWeek(new Date()));

    this.container.innerHTML = `
      <div class="home-shell calendar-shell">
        <main class="home-main calendar-main${enterClass}">
          <section class="library-page calendar-page">
            <header class="library-page-header">
              <h1 class="library-page-title">${escapeHtml(t("calendar_title", {}, "Calendar"))}</h1>
            </header>
            ${hasAnyEpisodes ? this.renderWeekNav(formatWeekRangeLabel(this.weekStart), isCurrentWeek) : ""}
            ${hasAnyEpisodes ? this.renderDayGroups(groups) : this.renderEmptyState()}
          </section>
        </main>
      </div>
    `;

    ScreenUtils.indexFocusables(this.container);
    this.bindEvents();
    this.restoreFocus();
  },

  restoreFocus() {
    const target = (this.lastFocusedAction
      ? this.container?.querySelector(`.focusable[data-action="${selectorValue(this.lastFocusedAction)}"]`)
      : null)
      || (this.lastFocusedKey
        ? this.container?.querySelector(`.calendar-episode-card[data-focus-key="${selectorValue(this.lastFocusedKey)}"]`)
        : null)
      || this.container?.querySelector('[data-action="calendarNextWeek"]')
      || this.container?.querySelector(".calendar-episode-card.focusable")
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

    if (ScreenUtils.handleDpadNavigation(event, this.container, ".home-main .focusable")) {
      return;
    }

    if (code !== 13 || !current) {
      return;
    }
    this.activateNode(current);
  },

  cleanup() {
    RootSidebarController.unregister("calendar");
    this.loadToken = (this.loadToken || 0) + 1;
    ScreenUtils.hide(this.container);
  }

};
