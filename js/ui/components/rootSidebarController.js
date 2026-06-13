import {
  renderRootSidebar,
  bindRootSidebarEvents,
  getSidebarProfileState
} from "./sidebarNavigation.js";

// Routes that use this persistent sidebar.
// home and settings manage their own sidebar with expand/collapse.
// player, auth, and stream screens don't show a sidebar.
const ROOT_SIDEBAR_ROUTES = new Set([
  "detail",
  "library",
  "search",
  "discover",
  "trakt",
  "castDetail",
  "catalogSeeAll",
  "folderDetail",
  "supportersContributors",
  "plugin",
  "catalogOrder"
]);

export const RootSidebarController = {
  el: null,
  profile: null,

  init() {
    this.el = document.getElementById("root-nav-sidebar");
    if (!this.el) return;
    getSidebarProfileState().then(profile => { this.profile = profile; }).catch(() => {});
  },

  update(routeName) {
    if (!this.el) return;
    const visible = ROOT_SIDEBAR_ROUTES.has(routeName);
    this.el.hidden = !visible;
    if (!visible) return;
    this.el.innerHTML = renderRootSidebar({
      selectedRoute: routeName,
      profile: this.profile,
      layout: {}
    });
    bindRootSidebarEvents(this.el, { currentRoute: routeName });
  }
};
