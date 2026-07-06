import { HomeScreen } from "../screens/home/homeScreen.js";
import { AccountScreen } from "../screens/account/accountScreen.js";
import { AuthSignInScreen } from "../screens/account/authSignInScreen.js";
import { SyncCodeScreen } from "../screens/account/syncCodeScreen.js";
import { ProfileSelectionScreen } from "../../core/profile/profileSelectionScreen.js";
import { Platform } from "../../platform/index.js";
import { RouteStateStore } from "./routeStateStore.js";
import { LocalStore } from "../../core/storage/localStore.js";

// Lazy screen factories — resolved on first navigation and cached back into routes.
// In an ESM+splitting build these become real async chunks; in a single-bundle IIFE
// build esbuild inlines them so module init is still deferred to first use.
const _lazyFactories = {
  authQrSignIn: () => import("../screens/account/authQrSignInScreen.js").then((m) => m.AuthQrSignInScreen),
  settings: () => import("../screens/settings/settingsScreen.js").then((m) => m.SettingsScreen),
  supportersContributors: () => import("../screens/supporters/supportersContributorsScreen.js").then((m) => m.SupportersContributorsScreen),
  castDetail: () => import("../screens/cast/castDetailScreen.js").then((m) => m.CastDetailScreen),
  player: () => import("../screens/player/playerScreen.js").then((m) => m.PlayerScreen),
  detail: () => import("../screens/detail/metaDetailsScreen.js").then((m) => m.MetaDetailsScreen),
  stream: () => import("../screens/stream/streamScreen.js").then((m) => m.StreamScreen),
  library: () => import("../screens/library/libraryScreen.js").then((m) => m.LibraryScreen),
  search: () => import("../screens/search/searchScreen.js").then((m) => m.SearchScreen),
  discover: () => import("../screens/search/discoverScreen.js").then((m) => m.DiscoverScreen),
  trakt: () => import("../screens/trakt/traktScreen.js").then((m) => m.TraktScreen),
  plugin: () => import("../screens/plugin/pluginScreen.js").then((m) => m.PluginScreen),
  plugins: () => import("../screens/plugin/pluginsScreen.js").then((m) => m.PluginsScreen),
  debugConsole: () => import("../screens/debug/consoleDebugScreen.js").then((m) => m.ConsoleDebugScreen),
  catalogOrder: () => import("../screens/plugin/catalogOrderScreen.js").then((m) => m.CatalogOrderScreen),
  catalogSeeAll: () => import("../screens/catalog/catalogSeeAllScreen.js").then((m) => m.CatalogSeeAllScreen),
  folderDetail: () => import("../screens/collection/folderDetailScreen.js").then((m) => m.FolderDetailScreen),
};

// Likely-next chunks warmed in idle time after a route mounts, so the first
// press into them never waits on module init.
const ROUTE_PRELOADS = {
  home: ["detail"],
  search: ["detail"],
  discover: ["detail"],
  library: ["detail"],
  detail: ["stream"],
  stream: ["player"]
};

const NON_BACKSTACK_ROUTES = new Set([
  "profileSelection",
  "authQrSignIn",
  "authSignIn",
  "syncCode"
]);

const WEBOS_RESUME_ROUTE_KEY = "webos_last_resume_route";
const WEBOS_RESUME_ROUTE_TTL_MS = 20 * 60 * 1000;
const WEBOS_NON_RESTORABLE_ROUTES = new Set([...NON_BACKSTACK_ROUTES, "player", "stream"]);

export const Router = {

  current: null,
  currentParams: {},
  stack: [],
  historyInitialized: false,
  popstateBound: false,
  suppressPopstateUntil: 0,
  skipConsumeNextPopstate: false,
  ignoreNextPopstate: false,
  onNavigate: null,
  afterNavigate: null,

  routes: {
    // Eager: needed for boot / auth gating before any navigation settles.
    home: HomeScreen,
    account: AccountScreen,
    authSignIn: AuthSignInScreen,
    syncCode: SyncCodeScreen,
    profileSelection: ProfileSelectionScreen,
    // Lazy-loaded on first navigation; factory in _lazyFactories
    player: null,
    detail: null,
    stream: null,
    library: null,
    search: null,
    discover: null,
    trakt: null,
    plugin: null,
    catalogOrder: null,
    catalogSeeAll: null,
    folderDetail: null,
    authQrSignIn: null,
    settings: null,
    supportersContributors: null,
    castDetail: null,
  },

  schedulePreloads(routeName) {
    const targets = (ROUTE_PRELOADS[routeName] || []).filter((name) => !this.routes[name]);
    if (!targets.length) {
      return;
    }
    const run = () => {
      targets.forEach((name) => {
        this._resolveScreen(name).catch(() => {});
      });
    };
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(run, { timeout: 5000 });
    } else {
      setTimeout(run, 800);
    }
  },

  async _resolveScreen(routeName) {
    if (this.routes[routeName]) return this.routes[routeName];
    const factory = _lazyFactories[routeName];
    if (!factory) return null;
    const screen = await factory();
    this.routes[routeName] = screen;
    return screen;
  },

  getRouteStateKey(routeName, params = {}) {
    const screen = this.routes[routeName];
    if (!screen?.getRouteStateKey) {
      return null;
    }
    try {
      return screen.getRouteStateKey(params || {});
    } catch (error) {
      console.warn("Failed to resolve route state key", routeName, error);
      return null;
    }
  },

  captureCurrentRouteState() {
    if (!this.current) {
      return;
    }
    const screen = this.routes[this.current];
    if (!screen?.captureRouteState) {
      return;
    }
    const key = this.getRouteStateKey(this.current, this.currentParams);
    if (!key) {
      return;
    }
    try {
      RouteStateStore.set(key, screen.captureRouteState());
    } catch (error) {
      console.warn("Failed to capture route state", this.current, error);
    }
  },

  resolveNavigationContext(routeName, params = {}, options = {}) {
    const screen = this.routes[routeName];
    const key = this.getRouteStateKey(routeName, params);
    const shouldClear = Boolean(screen?.clearRouteStateOnMount?.(params || {}));
    if (shouldClear && key) {
      RouteStateStore.clear(key);
    }
    return {
      restoredState: !shouldClear && key ? RouteStateStore.get(key) : null,
      routeStateKey: key,
      fromHistory: Boolean(options?.fromHistory),
      isBackNavigation: Boolean(options?.isBackNavigation)
    };
  },

  init() {
    if (this.popstateBound) {
      return;
    }
    this.popstateBound = true;
    window.addEventListener("popstate", async (event) => {
      if (this.ignoreNextPopstate) {
        this.ignoreNextPopstate = false;
        return;
      }
      if (Date.now() < Number(this.suppressPopstateUntil || 0)) {
        if (window?.history && typeof window.history.pushState === "function") {
          window.history.pushState({ route: this.current, params: this.currentParams }, "");
        }
        return;
      }
      const shouldSkipConsume = Boolean(this.skipConsumeNextPopstate);
      this.skipConsumeNextPopstate = false;
      const currentScreen = this.getCurrentScreen();
      if (!shouldSkipConsume && currentScreen?.consumeBackRequest?.()) {
        if (window?.history && typeof window.history.pushState === "function") {
          window.history.pushState({ route: this.current, params: this.currentParams }, "");
        }
        return;
      }
      const state = event?.state || null;
      if (this.current === "home" && (!state?.route || NON_BACKSTACK_ROUTES.has(state.route))) {
        Platform.exitApp();
        return;
      }
      if (state?.route && (this.routes[state.route] || _lazyFactories[state.route])) {
        await this.navigate(state.route, state.params || {}, {
          fromHistory: true,
          skipStackPush: true,
          isBackNavigation: true
        });
        return;
      }
      if (this.current && this.current !== "home" && this.routes.home) {
        await this.navigate("home", {}, {
          fromHistory: true,
          skipStackPush: true,
          isBackNavigation: true
        });
      }
    });
  },

  suppressNextPopstate(durationMs = 700) {
    this.suppressPopstateUntil = Math.max(
      Number(this.suppressPopstateUntil || 0),
      Date.now() + Math.max(0, Number(durationMs || 0))
    );
  },

  ignoreSinglePopstate() {
    this.ignoreNextPopstate = true;
  },

  // webOS keeps the app resident when backgrounded; on relaunch we restore the
  // last route (within a TTL) instead of always landing on home.
  persistWebOsResumeRoute(routeName = this.current, params = this.currentParams) {
    if (!Platform.isWebOS()) {
      return;
    }
    const route = String(routeName || "").trim();
    const isKnownRoute = Boolean(this.routes[route] || _lazyFactories[route]);
    if (!route || !isKnownRoute || WEBOS_NON_RESTORABLE_ROUTES.has(route)) {
      LocalStore.remove(WEBOS_RESUME_ROUTE_KEY);
      return;
    }
    try {
      LocalStore.set(WEBOS_RESUME_ROUTE_KEY, {
        route,
        params: params || {},
        savedAt: Date.now()
      });
    } catch (error) {
      console.warn("Failed to persist webOS resume route", error);
    }
  },

  consumeWebOsResumeRoute() {
    if (!Platform.isWebOS()) {
      return null;
    }
    const snapshot = LocalStore.get(WEBOS_RESUME_ROUTE_KEY, null);
    if (!snapshot || typeof snapshot !== "object") {
      return null;
    }
    const route = String(snapshot.route || "").trim();
    const savedAt = Number(snapshot.savedAt || 0);
    const isKnownRoute = Boolean(this.routes[route] || _lazyFactories[route]);
    if (
      !route ||
      !isKnownRoute ||
      WEBOS_NON_RESTORABLE_ROUTES.has(route) ||
      !Number.isFinite(savedAt) ||
      Date.now() - savedAt > WEBOS_RESUME_ROUTE_TTL_MS
    ) {
      LocalStore.remove(WEBOS_RESUME_ROUTE_KEY);
      return null;
    }
    return {
      route,
      params: snapshot.params && typeof snapshot.params === "object" ? snapshot.params : {}
    };
  },

  async navigate(routeName, params = {}, options = {}) {

    const fromHistory = Boolean(options?.fromHistory);
    const skipStackPush = Boolean(options?.skipStackPush);
    const replaceHistory = Boolean(options?.replaceHistory);
    const targetParams = params || {};

    const Screen = await this._resolveScreen(routeName);

    if (!Screen) {
      console.error("Route not found:", routeName);
      return;
    }

    // Cleanup current
    const previousRoute = this.current;
    const shouldSkipPush = skipStackPush || NON_BACKSTACK_ROUTES.has(previousRoute);
    if (this.current && this.current !== routeName) {
      this.captureCurrentRouteState();
      this.routes[this.current].cleanup?.();
      if (!shouldSkipPush) {
        this.stack.push({
          route: this.current,
          params: this.currentParams || {}
        });
      }
    } else if (this.current === routeName) {
      this.captureCurrentRouteState();
      this.routes[this.current].cleanup?.();
    }

    this.current = routeName;
    this.currentParams = targetParams;
    const navigationContext = this.resolveNavigationContext(routeName, this.currentParams, options);

    // Fire before mount so UI chrome (sidebar, etc.) updates during the loading skeleton phase.
    this.onNavigate?.(routeName);

    await Screen.mount(this.currentParams, navigationContext);

    // If another navigation happened while this screen was mounting, this
    // navigation is stale and must not write an extra history entry.
    if (this.current !== routeName || this.currentParams !== targetParams) {
      return;
    }

    this.schedulePreloads(routeName);

    // Fire after mount so chrome that must live inside the screen container
    // (e.g. sidebar injection for LG Magic Remote pointer hit-testing) can
    // attach after the screen has written its final HTML.
    this.afterNavigate?.(routeName);

    if (window?.history && typeof window.history.pushState === "function") {
      const state = { route: this.current, params: this.currentParams };
      if (!this.historyInitialized) {
        window.history.replaceState(state, "");
        this.historyInitialized = true;
      } else if (!fromHistory) {
        if (replaceHistory || NON_BACKSTACK_ROUTES.has(previousRoute)) {
          window.history.replaceState(state, "");
        } else {
          window.history.pushState(state, "");
        }
      }
    }
    this.persistWebOsResumeRoute(this.current, this.currentParams);
  },

  async back(options = {}) {
    const currentScreen = this.getCurrentScreen();
    if (!options?.skipConsume && currentScreen?.consumeBackRequest?.()) {
      this.suppressNextPopstate();
      return;
    }

    if (this.current === "home") {
      Platform.exitApp();
      return;
    }

    if (window?.history && typeof window.history.back === "function" && this.historyInitialized) {
      if (options?.skipConsume) {
        this.skipConsumeNextPopstate = true;
      }
      window.history.back();
      return;
    }

    if (this.stack.length === 0) {
      if (this.current && this.current !== "home" && this.routes.home) {
        this.routes[this.current].cleanup?.();
        this.current = "home";
        this.currentParams = {};
        await this.routes.home.mount();
        return;
      }

      Platform.exitApp();
      return;
    }

    const previous = this.stack.pop();
    const previousRoute = typeof previous === "string" ? previous : previous?.route;
    const previousParams = typeof previous === "string" ? {} : (previous?.params || {});

    if (!previousRoute || !this.routes[previousRoute]) {
      return;
    }

    this.captureCurrentRouteState();
    this.routes[this.current].cleanup?.();
    this.current = previousRoute;
    this.currentParams = previousParams;
    const navigationContext = this.resolveNavigationContext(previousRoute, previousParams, {
      isBackNavigation: true
    });

    await this.routes[previousRoute].mount(previousParams, navigationContext);
    this.persistWebOsResumeRoute(this.current, this.currentParams);
  },

  getCurrent() {
    return this.current;
  },

  getCurrentScreen() {
    if (!this.current) {
      return null;
    }
    return this.routes[this.current] || null;
  }

};
