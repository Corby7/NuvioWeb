export const MODERN_HOME_CONSTANTS = {
  heroFocusDelayMs: 180,
  // Presses closer together than the threshold count as held-key navigation;
  // the settle delay must exceed the press interval or hero swaps fire (and
  // fetch w1280 backdrops) for cards the user is skimming past. The old
  // 130/120 pair let swaps slip through between ~150ms key repeats — visible
  // as per-card hero churn on the C3.
  heroRapidNavThresholdMs: 450,
  heroRapidSettleMs: 300,
  // Max wait for the new hero backdrop/logo decode before swapping anyway.
  heroSwapDecodeTimeoutMs: 800,
  // The hero copy is hidden (is-hero-meta-enriching) while the meta round trip
  // that supplies the logo is in flight. On a prefetch hit that clears within a
  // frame, but on a miss the backdrop crossfades in and the copy stays blank
  // for the whole fetch. Past this, reveal the copy with plain title text and
  // let the logo crossfade in on its own — a title that gets replaced beats a
  // blank hero for a second.
  heroEnrichCopyRevealMs: 700,
  keyRepeatThrottleMs: 80,
  cameraFollowDelayMs: 140,
  cameraFollowDurationXMs: 280,
  cameraFollowDurationYMs: 300,
  cameraSafetyDurationMs: 180,
  springScrollStiffness: 180,
  springScrollDampingRatio: 0.95,
  rowFocusInset: 64,
  trackEdgePadding: 104,
  verticalFastScrollVelocityPxPerSec: 6400,
  verticalFastScrollEndTimeoutMs: 160,
  verticalFastScrollMaxFrameMs: 48
};

export function renderModernHomeLayout({
  rows = [],
  heroItem = null,
  heroCandidates = [],
  continueWatchingItems = [],
  continueWatchingLoading = false,
  continueWatchingLoadingCount = 0,
  useEpisodeThumbnailsInCw = true,
  blurContinueWatchingNextUp = false,
  rowItemLimit = 15,
  eagerRowCount = 4,
  showHeroSection = false,
  showPosterLabels = true,
  showCatalogTypeSuffix = true,
  preferLandscapePosters = false,
  focusedRowKey = "",
  focusedItemIndex = -1,
  expandFocusedPoster = false,
  buildModernHeroPresentation,
  renderHeroBackdropImage,
  renderContinueWatchingSection,
  createPosterCardMarkup,
  createSeeAllCardMarkup: _createSeeAllCardMarkup,
  formatCatalogRowTitle,
  shouldDeferRowImages,
  watchedTitleIds = null,
  escapeHtml,
  escapeAttribute
} = {}) {
  const catalogSeeAllMap = new Map();
  const sectionsMarkup = [];
  // Per-row markup keyed by row key, so homeScreen can reconcile the rows it
  // already has in the DOM instead of re-parsing the whole screen when one
  // catalog batch lands. Order is tracked separately because a row's position
  // is part of its markup (data-row-index).
  const rowMarkupByKey = new Map();
  const rowKeys = [];
  let eagerCount = 0;

  rows.forEach((rowData, rowIndex) => {
    const isCollectionRow = rowData?.rowKind === "collection";
    const items = Array.isArray(rowData?.result?.data?.items) ? rowData.result.data.items : [];
    const isLoading = rowData?.result?.status === "loading";
    const rowItems = items.length ? items : (rowData.loadingItems || []);
    if (!rowItems.length) {
      return;
    }

    const rowKey = String(rowData?.homeCatalogKey || buildModernRowKey(rowData));
    const seeAllId = `${rowData.addonId || "addon"}_${rowData.catalogId || "catalog"}_${rowData.type || "movie"}`;
    if (!isLoading && !isCollectionRow && !rowData?.suppressSeeAll) {
      catalogSeeAllMap.set(seeAllId, {
        addonBaseUrl: rowData.addonBaseUrl || "",
        addonId: rowData.addonId || "",
        addonName: rowData.addonName || "",
        catalogId: rowData.catalogId || "",
        catalogName: rowData.catalogName || "",
        type: rowData.type || "movie",
        initialItems: items
      });
    }

    const rowTitle = isCollectionRow
      ? String(rowData.collectionTitle || rowData.collection?.title || "Collection")
      : (rowData.rowTitle || formatCatalogRowTitle(rowData.catalogName, rowData.type, showCatalogTypeSuffix));

    if (eagerCount < eagerRowCount) {
      eagerCount++;
      const maxItems = Math.max(1, Number(rowItemLimit || 15));
      const visibleItems = isCollectionRow || rowData?.showAllItems
        ? rowItems
        : rowItems.slice(0, maxItems);
      const cardsMarkup = visibleItems.map((item, itemIndex) => createPosterCardMarkup(
        item,
        rowIndex,
        itemIndex,
        rowData.type,
        rowData,
        showPosterLabels,
        "modern",
        expandFocusedPoster && focusedRowKey === rowKey && focusedItemIndex === itemIndex,
        preferLandscapePosters
      )).join("");

      const sectionMarkup = `
        <section class="home-row home-modern-row home-row-enter" data-row-key="${escapeHtml(rowKey)}" data-row-index="${rowIndex}">
          <div class="home-row-head">
            <h2 class="home-row-title">${escapeHtml(rowTitle)}</h2>
          </div>
          <div class="home-track" data-track-row-key="${escapeHtml(rowKey)}">
            <div class="home-track-inner">${cardsMarkup}</div>
          </div>
        </section>
      `;
      sectionsMarkup.push(sectionMarkup);
      rowKeys.push(rowKey);
      rowMarkupByKey.set(rowKey, sectionMarkup);
    } else {
      // Deferred row — stub with title only, cards mounted lazily by initVirtualRows()
      const sectionMarkup = `
        <section class="home-row home-modern-row home-row-enter" data-row-key="${escapeHtml(rowKey)}" data-row-index="${rowIndex}" data-row-pending="true">
          <div class="home-row-head">
            <h2 class="home-row-title">${escapeHtml(rowTitle)}</h2>
          </div>
          <div class="home-track" data-track-row-key="${escapeHtml(rowKey)}"><div class="home-track-inner"></div></div>
        </section>
      `;
      sectionsMarkup.push(sectionMarkup);
      rowKeys.push(rowKey);
      rowMarkupByKey.set(rowKey, sectionMarkup);
    }
  });

  const heroMarkup = showHeroSection
    ? renderModernHeroMarkup({
      heroItem,
      heroCandidates,
      buildModernHeroPresentation,
      renderHeroBackdropImage,
      escapeHtml,
      escapeAttribute
    })
    : (continueWatchingLoading ? renderModernHeroSkeletonMarkup() : "");
  const continueWatchingMarkup = renderContinueWatchingSection(continueWatchingItems, {
    rowKey: "continue_watching",
    loading: continueWatchingLoading,
    loadingCount: continueWatchingLoadingCount,
    useEpisodeThumbnails: useEpisodeThumbnailsInCw,
    blurNextUp: blurContinueWatchingNextUp
  });
  const catalogsMarkup = sectionsMarkup.length
    ? sectionsMarkup.join("")
    : (continueWatchingLoading ? renderModernCatalogSkeletonMarkup() : "");

  return {
    catalogSeeAllMap,
    // The same three regions the markup below is assembled from, handed back
    // individually so a re-render can patch only what actually changed.
    parts: {
      heroMarkup,
      continueWatchingMarkup,
      catalogsMarkup,
      rowKeys,
      rowMarkupByKey,
      hasRows: sectionsMarkup.length > 0
    },
    markup: `
      <section class="home-modern-stage">
        ${heroMarkup}
        <div class="home-modern-rows-viewport">
          <div class="home-modern-rows-scroll">
            ${continueWatchingMarkup}
            <div class="home-modern-catalogs">
              ${catalogsMarkup}
            </div>
          </div>
        </div>
      </section>
    `
  };
}

export function buildModernNavigationRows(container) {
  const rows = [];
  const continueTrack = container?.querySelector(".home-row-continue .home-track");
  if (continueTrack) {
    const continueNodes = Array.from(continueTrack.querySelectorAll(".home-content-card.focusable"));
    if (continueNodes.length) {
      rows.push(continueNodes);
    }
  }

  const rowSections = Array.from(container?.querySelectorAll(".home-modern-row") || []);
  rowSections.forEach((section) => {
    const track = section.querySelector(".home-track");
    if (!track) {
      return;
    }
    const cards = Array.from(track.querySelectorAll(".home-content-card.focusable"));
    if (cards.length) {
      rows.push(cards);
    }
  });

  return rows;
}

export function buildModernRowKey(rowData = {}) {
  return `${rowData.addonId || ""}_${rowData.type || ""}_${rowData.catalogId || ""}`;
}

function buildHeroIndicators(items = [], activeItem = null) {
  if (!Array.isArray(items) || items.length <= 1) {
    return "";
  }
  const activeId = String(activeItem?.id || "");
  const activeIndex = items.findIndex((item) => String(item?.id || "") === activeId);
  return items.map((_, index) => `
    <span class="home-hero-indicator${index === activeIndex ? " is-active" : ""}"></span>
  `).join("");
}

function renderModernHeroMarkup({
  heroItem,
  heroCandidates,
  buildModernHeroPresentation,
  renderHeroBackdropImage,
  escapeHtml,
  escapeAttribute
}) {
  const display = buildModernHeroPresentation(heroItem);
  if (!display) {
    return "";
  }
  const primaryLeft = display.leadingMeta
    .map((token) => `<span>${escapeHtml(token)}</span>`)
    .join('<span class="home-hero-dot">•</span>');
  const primaryRightParts = display.trailingMeta
    .map((token) => `<span>${escapeHtml(token)}</span>`);
  if (display.showImdbPrimary) {
    primaryRightParts.push(`
      <span class="home-hero-imdb">
        <img src="assets/icons/imdb_logo_2016.svg" alt="IMDb" />
        <span>${escapeHtml(display.imdbText)}</span>
      </span>
    `);
  }
  const hasPrimaryRight = primaryRightParts.length > 0;
  const secondaryParts = [];
  if (display.secondaryHighlightText) {
    secondaryParts.push(`<span class="home-modern-hero-highlight">${escapeHtml(display.secondaryHighlightText)}</span>`);
  }
  display.badges.forEach((badge) => {
    secondaryParts.push(`<span class="home-modern-hero-badge">${escapeHtml(badge)}</span>`);
  });
  if (display.showImdbSecondary) {
    secondaryParts.push(`
      <span class="home-hero-imdb">
        <img src="assets/icons/imdb_logo_2016.svg" alt="IMDb" />
        <span>${escapeHtml(display.imdbText)}</span>
      </span>
    `);
  }
  if (display.languageText) {
    secondaryParts.push(`<span class="home-modern-hero-secondary-detail">${escapeHtml(display.languageText)}</span>`);
  }
  return `
    <section class="home-hero home-hero-modern">
      <article class="home-hero-card home-modern-hero-card${heroItem?.heroMetaEnriching ? " is-hero-meta-enriching" : ""}"
               data-item-id="${escapeAttribute(heroItem?.id || "")}"
               data-item-type="${escapeAttribute(heroItem?.type || "movie")}"
               data-item-title="${escapeAttribute(heroItem?.name || "Untitled")}">
        <div class="home-modern-hero-media">
          <div class="home-hero-backdrop-wrap">
          ${typeof renderHeroBackdropImage === "function"
              ? renderHeroBackdropImage(display)
              : (display.backdrop
                ? `<img class="home-hero-backdrop" src="${escapeAttribute(display.backdrop)}" alt="${escapeAttribute(display.title)}" decoding="async" fetchpriority="high" />`
                : '<div class="home-hero-backdrop placeholder"></div>')}
          </div>
          <div class="home-hero-trailer-layer"></div>
        </div>
        <div class="home-hero-copy home-modern-hero-copy">
          <div class="home-hero-brand">
            ${display.logo ? `<img class="home-hero-logo" src="${escapeAttribute(display.logo)}" alt="${escapeAttribute(display.title)}" decoding="async" fetchpriority="high" />` : ""}
            <h1 class="home-hero-title-text${display.logo ? " is-hidden" : ""}">${escapeHtml(display.title)}</h1>
          </div>
          <div class="home-modern-hero-meta-line${display.leadingMeta.length || display.trailingMeta.length || display.showImdbPrimary ? "" : " is-empty"}">
            <div class="home-modern-hero-meta-group home-modern-hero-meta-group-leading">
              ${primaryLeft}
            </div>
            <div class="home-modern-hero-meta-group home-modern-hero-meta-group-trailing">
              ${primaryLeft && hasPrimaryRight ? '<span class="home-hero-dot">•</span>' : ""}
              ${primaryRightParts.join('<span class="home-hero-dot">•</span>')}
            </div>
          </div>
          <div class="home-modern-hero-secondary${display.secondaryHighlightText || display.badges.length || display.showImdbSecondary || display.languageText ? "" : " is-empty"}">
            ${secondaryParts.join('<span class="home-hero-dot">•</span>')}
          </div>
          <p class="home-hero-description${display.description ? "" : " is-empty"}">${escapeHtml(display.description)}</p>
        </div>
        <div class="home-hero-indicators">${buildHeroIndicators(heroCandidates, heroItem)}</div>
      </article>
    </section>
  `;
}

function renderModernHeroSkeletonMarkup() {
  return `
    <section class="home-hero home-hero-modern home-hero-modern-loading" aria-hidden="true">
      <article class="home-hero-card home-modern-hero-card home-modern-hero-card-loading">
        <div class="home-modern-hero-copy-skeleton">
          <div class="home-modern-skeleton-block home-modern-hero-logo-skeleton"></div>
          <div class="home-modern-hero-meta-skeleton">
            <div class="home-modern-skeleton-block" style="width:72px"></div>
            <div class="home-modern-skeleton-block" style="width:52px"></div>
            <div class="home-modern-skeleton-block" style="width:84px"></div>
          </div>
          <div class="home-modern-hero-btn-skeleton">
            <div class="home-modern-skeleton-block home-modern-hero-btn-primary-skeleton"></div>
            <div class="home-modern-skeleton-block home-modern-hero-btn-circle-skeleton"></div>
            <div class="home-modern-skeleton-block home-modern-hero-btn-circle-skeleton"></div>
          </div>
          <div class="home-modern-hero-desc-skeleton">
            <div class="home-modern-skeleton-block" style="width:74%"></div>
            <div class="home-modern-skeleton-block" style="width:88%"></div>
            <div class="home-modern-skeleton-block" style="width:60%"></div>
          </div>
        </div>
      </article>
    </section>
  `;
}

function renderModernCatalogSkeletonMarkup(rowCount = 3, cardsPerRow = 6) {
  const titleWidths = [116, 128, 104, 132, 120, 140];
  const subtitleWidths = [82, 96, 74, 90, 88, 100];
  const skeletonCard = (i) => `
    <article class="home-content-card home-poster-card home-poster-card-loading" aria-disabled="true">
      <div class="home-poster-frame">
        <div class="content-poster placeholder"></div>
        <div class="home-poster-expanded-backdrop placeholder" aria-hidden="true"></div>
        <div class="home-poster-trailer-layer"></div>
        <div class="home-poster-expanded-gradient"></div>
        <div class="home-poster-expanded-brand"></div>
      </div>
      <div class="home-poster-copy home-poster-copy-skeleton" aria-hidden="true"
           style="--poster-skeleton-title:${titleWidths[i % titleWidths.length]}px;--poster-skeleton-subtitle:${subtitleWidths[i % subtitleWidths.length]}px;">
        <div class="home-poster-skeleton-line home-poster-skeleton-title"></div>
        <div class="home-poster-skeleton-line home-poster-skeleton-subtitle"></div>
      </div>
    </article>
  `;
  const skeletonRow = () => `
    <section class="home-row home-modern-row home-modern-row-loading" aria-hidden="true">
      <div class="home-row-head">
        <div class="home-modern-skeleton-block home-modern-row-title-skeleton"></div>
      </div>
      <div class="home-track">
        ${Array.from({ length: cardsPerRow+1 }, (_, i) => skeletonCard(i)).join("")}
      </div>
    </section>
  `;
  return Array.from({ length: rowCount }, skeletonRow).join("");
}
