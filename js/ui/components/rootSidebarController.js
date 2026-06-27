import {
  renderRootSidebar,
  getSidebarProfileState,
  setModernSidebarExpanded,
  setLegacySidebarExpanded,
  getModernSidebarSelectedNode,
  getLegacySidebarSelectedNode,
  focusWithoutAutoScroll,
  activateLegacySidebarAction,
  isSelectedSidebarAction,
  scheduleRootSidebarTextFit
} from "./sidebarNavigation.js";
import { LayoutPreferences } from "../../data/local/layoutPreferences.js";
import { Router } from "../navigation/router.js";

// Routes with no sidebar at all
const NO_SIDEBAR_ROUTES = new Set(["account", "profileSelection", "stream", "player"]);

export const RootSidebarController = {
  el: null,            // #root-nav-sidebar — persistent, never re-injected
  appEl: null,         // #app
  profile: null,
  expanded: false,
  openedBy: null,      // 'dpad' | 'pointer' | null
  _pointerInSidebar: false,
  _savedContentFocused: null,
  lastScreenFocus: null,
  currentRoute: "",
  _currentShell: null, // current screen's .home-shell (for content-shift classes)
  _callbacks: {},      // routeName → { onExpand, onCollapse, onAfterInject }

  init() {
    this.el = document.getElementById("root-nav-sidebar");
    this.appEl = document.getElementById("app");
    if (!this.el || !this.appEl) return;
    getSidebarProfileState().then((profile) => {
      this.profile = profile;
      this._render();
      this._callbacks[this.currentRoute]?.onAfterInject?.();
    }).catch(() => { this._render(); });
    this._bindAppEvents();
  },

  _isManaged(routeName) {
    return !NO_SIDEBAR_ROUTES.has(routeName);
  },

  _render() {
    if (!this.el) return;
    if (!this._isManaged(this.currentRoute)) {
      this.el.hidden = true;
      return;
    }
    const layout = LayoutPreferences.get();
    this.el.hidden = false;
    this.el.innerHTML = renderRootSidebar({
      selectedRoute: this._navHighlightRoute || this.currentRoute,
      profile: this.profile,
      layout
    });
    this._bindSidebarItemEvents(this.el);
    scheduleRootSidebarTextFit(this.el);
    if (this.expanded) {
      if (layout.modernSidebar) {
        setModernSidebarExpanded(this.el, true);
        const target = getModernSidebarSelectedNode(this.el);
        if (target) {
          this.el.querySelectorAll(".focusable.focused").forEach((n) => n.classList.remove("focused"));
          target.classList.add("focused");
          focusWithoutAutoScroll(target);
        }
      } else {
        setLegacySidebarExpanded(this.el, true);
        this._toggleShellClass(true);
        const target = getLegacySidebarSelectedNode(this.el);
        if (target) {
          this.el.querySelectorAll(".focusable.focused").forEach((n) => n.classList.remove("focused"));
          target.classList.add("focused");
          focusWithoutAutoScroll(target);
        }
      }
    }
  },

  // Called by screens to register expand/collapse/afterInject callbacks.
  register(routeName, { onExpand = null, onCollapse = null, onAfterInject = null } = {}) {
    const key = String(routeName || "");
    this._callbacks[key] = { onExpand, onCollapse, onAfterInject };
  },

  unregister(routeName) {
    delete this._callbacks[String(routeName || "")];
  },

  // Called by Router.onNavigate (before screen mount) — update selected route.
  update(routeName) {
    if (!this.el) return;
    this.currentRoute = routeName;
    const navRoute = String(Router.currentParams?.navRoute || "");
    this._navHighlightRoute = navRoute || routeName;
    this.expanded = false;
    this.openedBy = null;
    this._savedContentFocused = null;
    this._currentShell = null;
    this._render();
  },

  // Called by Router.afterNavigate (after screen mount) — resolve current shell + notify.
  afterMount(routeName) {
    if (!this._isManaged(routeName)) return;
    const screenEl = document.getElementById(routeName);
    this._currentShell = screenEl?.querySelector(".home-shell") || null;

    getSidebarProfileState().then((profile) => {
      if (profile !== this.profile) {
        this.profile = profile;
        this._render();
        this._callbacks[routeName]?.onAfterInject?.();
      }
    }).catch(() => {});

    this._callbacks[routeName]?.onAfterInject?.();
  },

  // Toggle content-shift classes on the current screen's .home-shell.
  _toggleShellClass(expanded) {
    const shell = this._currentShell;
    if (!shell) return;
    const sidebar = this.el?.querySelector(".home-sidebar");
    const isCollapsible = this.currentRoute === "home"
      ? true
      : sidebar?.dataset.collapsible === "true";
    shell.classList.toggle("sidebar-expanded-collapsible", expanded && isCollapsible);
    shell.classList.toggle("sidebar-expanded-fixed", expanded && !isCollapsible);
  },

  // Public: let screens that call setLegacySidebarExpanded directly also sync the shell class.
  applyShellExpanded(expanded) {
    this._toggleShellClass(expanded);
  },

  expand() {
    if (this.expanded) return;
    this.expanded = true;
    this.openedBy = 'dpad';

    // Strip .focused from content so it doesn't compete with the sidebar item.
    this.appEl?.querySelectorAll(".focusable.focused:not(#root-nav-sidebar .focusable)")
      .forEach((n) => n.classList.remove("focused"));

    // Clear any pre-existing .focused on sidebar items before opening so that
    // onExpand / openSidebar can set it cleanly on the selected item.
    // (Spatial nav may have already focused a non-selected item via focusin.)
    this.el?.querySelectorAll(".home-sidebar .focusable, .modern-sidebar-panel .focusable")
      .forEach((n) => n.classList.remove("focused"));

    const cb = this._callbacks[this.currentRoute];
    if (cb?.onExpand) {
      cb.onExpand();
      return;
    }

    const layout = LayoutPreferences.get();
    if (layout.modernSidebar) {
      setModernSidebarExpanded(this.el, true);
      const target = getModernSidebarSelectedNode(this.el);
      if (target) {
        this.el.querySelectorAll(".focusable.focused").forEach((n) => n.classList.remove("focused"));
        target.classList.add("focused");
        focusWithoutAutoScroll(target);
      }
    } else {
      setLegacySidebarExpanded(this.el, true);
      const target = getLegacySidebarSelectedNode(this.el);
      if (target) {
        document.querySelectorAll(".focusable.focused").forEach((n) => n.classList.remove("focused"));
        target.classList.add("focused");
        focusWithoutAutoScroll(target);
      }
    }
  },

  // Expand visually only — no focus move, no callbacks. Used for pointer hover.
  _expandVisualOnly() {
    this.expanded = true;
    this.openedBy = 'pointer';
    // Strip .focused from whatever content element had it so it doesn't
    // visually compete with the hovered sidebar item.
    const prev = this.appEl?.querySelector(".focusable.focused:not(#root-nav-sidebar .focusable)");
    if (prev) {
      prev.classList.remove("focused");
      this._savedContentFocused = prev;
    }
    const layout = LayoutPreferences.get();
    if (layout.modernSidebar) {
      setModernSidebarExpanded(this.el, true);
    } else {
      setLegacySidebarExpanded(this.el, true);
      this._toggleShellClass(true);
    }
  },

  collapse() {
    if (!this.expanded) return;
    const wasPointerOpen = this.openedBy === 'pointer';
    this.expanded = false;
    this.openedBy = null;

    if (wasPointerOpen) {
      const layout = LayoutPreferences.get();
      if (layout.modernSidebar) {
        setModernSidebarExpanded(this.el, false);
      } else {
        setLegacySidebarExpanded(this.el, false);
        this._toggleShellClass(false);
      }
      if (this._savedContentFocused?.isConnected) {
        this._savedContentFocused.classList.add("focused");
      }
      this._savedContentFocused = null;
      return;
    }

    const cb = this._callbacks[this.currentRoute];
    if (cb?.onCollapse) {
      // Close the sidebar visually first so pointer-events:none activates immediately.
      const layout = LayoutPreferences.get();
      if (layout.modernSidebar) {
        setModernSidebarExpanded(this.el, false);
      } else {
        setLegacySidebarExpanded(this.el, false);
      }
      this.el?.querySelectorAll(".focusable")
        .forEach((n) => n.classList.remove("focused"));
      this.el?.querySelectorAll(".home-nav-item, .modern-sidebar-nav-item")
        .forEach((n) => n.classList.remove(
          "hovered", "is-hover", "expanded", "active", "is-active", "open", "content-expanded"
        ));
      cb.onCollapse();
      return;
    }

    // Default path (no screen callback): strip all state then collapse.
    this.el?.querySelectorAll(".home-nav-item, .modern-sidebar-nav-item")
      .forEach((n) => n.classList.remove(
        "focused", "hovered", "is-hover",
        "expanded", "active", "is-active", "open", "content-expanded"
      ));
    const layout = LayoutPreferences.get();
    if (layout.modernSidebar) {
      setModernSidebarExpanded(this.el, false);
    } else {
      setLegacySidebarExpanded(this.el, false);
    }
    const target = (this.lastScreenFocus?.isConnected ? this.lastScreenFocus : null)
      || document.getElementById(this.currentRoute)?.querySelector(".focusable") || null;
    if (target) {
      document.querySelectorAll(".focusable.focused").forEach((n) => n.classList.remove("focused"));
      target.classList.add("focused");
      focusWithoutAutoScroll(target);
    }
  },

  _bindAppEvents() {
    const app = this.appEl;

    // focusin: d-pad focus entering the sidebar triggers expand().
    // Guard against magic remote auto-focus when pointer is already in sidebar.
    app.addEventListener("focusin", (event) => {
      if (!this._isManaged(this.currentRoute)) return;
      const target = event?.target;
      if (!target?.closest) return;
      if (target.closest("#root-nav-sidebar")) {
        if (!this.expanded && !this._pointerInSidebar) this.expand();
      } else if (target.classList?.contains("focusable")) {
        this.lastScreenFocus = target;
      }
    });

    // Pointer hover: expand when cursor enters the rail zone.
    // mouseover on this.el covers elements with pointer-events:auto (pill, panel items).
    this.el.addEventListener("mouseover", (event) => {
      if (!this._isManaged(this.currentRoute)) return;
      this._pointerInSidebar = true;
      if (this.expanded || this.openedBy === 'dpad') return;
      if (event.target?.closest(".home-nav-icon-wrap, .modern-sidebar-pill, .modern-sidebar-rail-zone")) {
        this._expandVisualOnly();
      }
    });

    // mousemove on the app catches the full 144px rail height, since pointer-events:none
    // on #root-nav-sidebar makes hit-testing through it unreliable across browsers.
    const railWidth = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--legacy-sidebar-rail-width')
    ) || 144;
    app.addEventListener("mousemove", (event) => {
      if (!this._isManaged(this.currentRoute)) return;
      if (this.expanded || this.openedBy === 'dpad') return;
      if (event.clientX <= railWidth) {
        this._pointerInSidebar = true;
        this._expandVisualOnly();
      }
    });

    this.el.addEventListener("mouseleave", () => {
      this._pointerInSidebar = false;
      if (this.openedBy === 'pointer') this.collapse();
    });
  },

  _bindSidebarItemEvents(host) {
    const focusables = Array.from(
      host.querySelectorAll(".home-sidebar .focusable, .modern-sidebar-panel .focusable")
    );

    const moveFocus = (current, delta) => {
      const nodes = focusables.filter((n) => n.isConnected);
      const idx = nodes.indexOf(current);
      if (idx === -1) return;
      const next = nodes[Math.max(0, Math.min(nodes.length - 1, idx + delta))];
      if (next && next !== current) {
        nodes.forEach((n) => n.classList.remove("focused"));
        next.classList.add("focused");
        focusWithoutAutoScroll(next);
      }
    };

    focusables.forEach((node) => {
      node.onclick = (event) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        const action = String(node.dataset.action || "");
        activateLegacySidebarAction(action, this.currentRoute);
        if (isSelectedSidebarAction(action, this.currentRoute)) {
          this.collapse();
        } else {
          // Navigation in flight — disarm focusin-based expand before update() fires.
          this.expanded = false;
        }
      };
      node.onkeydown = (event) => {
        const key = Number(event?.keyCode || 0);
        if (key === 38 || key === 40) {
          event.preventDefault();
          event.stopPropagation();
          moveFocus(node, key === 38 ? -1 : 1);
        } else if (key === 39) {
          event.preventDefault();
          event.stopPropagation();
          this.collapse();
        } else if (key === 13) {
          // WebOS d-pad OK does not fire a synthetic click on focused buttons.
          event.preventDefault();
          node.click();
        }
      };
    });

    host.querySelectorAll(".modern-sidebar-pill").forEach((pill) => {
      pill.onclick = () => this.expand();
    });

    host.querySelectorAll(".modern-sidebar-rail-zone").forEach((zone) => {
      zone.onclick = () => { if (!this.expanded) this.expand(); };
    });
  }
};
