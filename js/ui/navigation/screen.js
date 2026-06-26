import { LocalStore } from "../../core/storage/localStore.js";

const STRICT_DPAD_GRID_KEY = "strictDpadGridNavigation";

function shouldUseStrictDpadGrid() {
  return Boolean(LocalStore.get(STRICT_DPAD_GRID_KEY, true));
}

export const ScreenUtils = {

  show(container) {
    if (!container) {
      return;
    }
    if (container.style.display !== "block") {
      container.style.display = "block";
    }
  },

  hide(container, { preserveDom = false } = {}) {
    if (!container) {
      return;
    }
    if (container.style.display !== "none") {
      container.style.display = "none";
    }
    if (!preserveDom && container.childNodes?.length) {
      if (typeof container.replaceChildren === "function") {
        container.replaceChildren();
      } else {
        container.innerHTML = "";
      }
    }
  },

  setInitialFocus(container, selector = ".focusable") {
    const first = container?.querySelector(selector);
    if (!first) {
      return;
    }
    first.classList.add("focused");
    first.focus();
  },

  moveFocus(container, direction, selector = ".focusable") {
    const list = Array.from(container?.querySelectorAll(selector) || []);
    const current = container?.querySelector(`${selector}.focused`);
    if (!list.length || !current) {
      return;
    }

    const index = Number(current.dataset.index || 0);
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= list.length) {
      return;
    }

    current.classList.remove("focused");
    list[nextIndex].classList.add("focused");
    list[nextIndex].focus();
  },

  moveFocusDirectional(container, direction, selector = ".focusable") {
    const list = Array.from(container?.querySelectorAll(selector) || [])
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    if (!list.length) {
      return;
    }

    const current = container?.querySelector(`${selector}.focused`) || list[0];
    if (!current.classList.contains("focused")) {
      list.forEach((node) => node.classList.remove("focused"));
      current.classList.add("focused");
      current.focus();
      return;
    }

    const currentRect = current.getBoundingClientRect();
    const cx = currentRect.left + (currentRect.width / 2);
    const cy = currentRect.top + (currentRect.height / 2);
    const strictDpadGrid = shouldUseStrictDpadGrid();

    const candidates = list
      .filter((node) => node !== current)
      .map((node) => {
        const rect = node.getBoundingClientRect();
        const nx = rect.left + (rect.width / 2);
        const ny = rect.top + (rect.height / 2);
        const dx = nx - cx;
        const dy = ny - cy;
        return { node, rect, dx, dy };
      })
      .filter(({ dx, dy }) => {
        if (direction === "up") return dy < -2;
        if (direction === "down") return dy > 2;
        if (direction === "left") return dx < -2;
        if (direction === "right") return dx > 2;
        return false;
      })
      .map((entry) => {
        const primary = (direction === "up" || direction === "down")
          ? Math.abs(entry.dy)
          : Math.abs(entry.dx);
        const secondary = (direction === "up" || direction === "down")
          ? Math.abs(entry.dx)
          : Math.abs(entry.dy);
        const axisTolerance = (direction === "up" || direction === "down")
          ? Math.max(currentRect.width * 0.7, entry.rect.width * 0.7, 48)
          : Math.max(currentRect.height * 0.7, entry.rect.height * 0.7, 48);
        const aligned = (direction === "up" || direction === "down")
          ? secondary <= axisTolerance
          : secondary <= axisTolerance;
        return {
          ...entry,
          aligned,
          score: primary * 1000 + secondary
        };
      });

    let target = null;

    if (direction === "up" || direction === "down") {
      if (strictDpadGrid) {
        const nearestPrimary = candidates.reduce((min, entry) => {
          const primary = Math.abs(entry.dy);
          return Math.min(min, primary);
        }, Number.POSITIVE_INFINITY);
        const rowTolerance = Math.max(currentRect.height * 0.9, 42);
        const nearestRow = candidates.filter((entry) => {
          const primary = Math.abs(entry.dy);
          return primary <= nearestPrimary + rowTolerance;
        });
        const alignedInRow = nearestRow
          .filter((entry) => entry.aligned)
          .sort((left, right) => Math.abs(left.dx) - Math.abs(right.dx));
        const rowSorted = nearestRow
          .sort((left, right) => {
            const sec = Math.abs(left.dx) - Math.abs(right.dx);
            if (sec !== 0) {
              return sec;
            }
            return Math.abs(left.dy) - Math.abs(right.dy);
          });
        target = alignedInRow[0]?.node || rowSorted[0]?.node || null;
      } else {
        const alignedCandidates = candidates
          .filter((entry) => entry.aligned)
          .sort((left, right) => left.score - right.score);
        const sortedCandidates = candidates
          .sort((left, right) => left.score - right.score);
        target = alignedCandidates[0]?.node || sortedCandidates[0]?.node || null;
      }
    } else {
      if (strictDpadGrid) {
        const nearestPrimary = candidates.reduce((min, entry) => {
          const primary = Math.abs(entry.dx);
          return Math.min(min, primary);
        }, Number.POSITIVE_INFINITY);
        const columnTolerance = Math.max(currentRect.width * 0.9, 42);
        const nearestColumn = candidates.filter((entry) => {
          const primary = Math.abs(entry.dx);
          return primary <= nearestPrimary + columnTolerance;
        });
        const alignedInColumn = nearestColumn
          .filter((entry) => entry.aligned)
          .sort((left, right) => Math.abs(left.dy) - Math.abs(right.dy));
        const columnSorted = nearestColumn
          .sort((left, right) => {
            const sec = Math.abs(left.dy) - Math.abs(right.dy);
            if (sec !== 0) {
              return sec;
            }
            return Math.abs(left.dx) - Math.abs(right.dx);
          });
        target = alignedInColumn[0]?.node || columnSorted[0]?.node || null;
      } else {
        const alignedCandidates = candidates
          .filter((entry) => entry.aligned)
          .sort((left, right) => left.score - right.score);
        const sortedCandidates = candidates
          .sort((left, right) => left.score - right.score);
        target = alignedCandidates[0]?.node || sortedCandidates[0]?.node || null;
      }
    }
    if (!target) {
      return;
    }

    current.classList.remove("focused");
    target.classList.add("focused");
    target.focus();
  },

  handleDpadNavigation(event, container, selector = ".focusable") {
    const code = Number(event?.keyCode || 0);
    const direction = code === 38 ? "up"
      : code === 40 ? "down"
        : code === 37 ? "left"
          : code === 39 ? "right"
            : null;
    if (!direction) {
      return false;
    }
    if (typeof event?.preventDefault === "function") {
      event.preventDefault();
    }
    this.moveFocusDirectional(container, direction, selector);
    return true;
  },

  indexFocusables(container, selector = ".focusable") {
    const list = Array.from(container?.querySelectorAll(selector) || []);
    list.forEach((node, index) => {
      const indexValue = String(index);
      if (node.dataset.index !== indexValue) {
        node.dataset.index = indexValue;
      }
      if (node.tabIndex !== 0) {
        node.tabIndex = 0;
      }
    });
  },

  // Build a pre-indexed 2-D navigation grid from the focusable nodes matched by
  // `selector` inside `container`. Groups nodes into rows by offsetTop (8px
  // tolerance), sorts within each row by offsetLeft, then stamps data-nav-grid-row
  // and data-nav-grid-col onto each node. The result is cached in a WeakMap so
  // navigateWithGrid can look up neighbours in O(1) with no DOM geometry reads.
  // Call this once after each render that changes the list of focusable nodes.
  buildNavGrid(container, selector = ".focusable") {
    if (!container) {
      return null;
    }
    const nodes = Array.from(container.querySelectorAll(selector) || [])
      .filter((node) => node.offsetHeight > 0);
    if (!nodes.length) {
      return null;
    }

    const groups = [];
    nodes.forEach((node) => {
      const top = Math.round(node.offsetTop);
      const group = groups.find((g) => Math.abs(g.top - top) <= 8);
      if (group) {
        group.nodes.push(node);
      } else {
        groups.push({ top, nodes: [node] });
      }
    });
    groups.sort((a, b) => a.top - b.top);

    const rows = groups.map((g) => {
      g.nodes.sort((a, b) => a.offsetLeft - b.offsetLeft);
      return g.nodes;
    });

    rows.forEach((row, rowIndex) => {
      row.forEach((node, colIndex) => {
        node.dataset.navGridRow = String(rowIndex);
        node.dataset.navGridCol = String(colIndex);
        if (node.tabIndex !== 0) {
          node.tabIndex = 0;
        }
      });
    });

    if (!this._navGrids) {
      this._navGrids = new WeakMap();
    }
    this._navGrids.set(container, { rows });
    return { rows };
  },

  // Navigate to an adjacent node in the pre-built grid. Returns true and moves
  // focus if a valid neighbour exists. Returns false if the current node is not
  // in the grid or there is no neighbour in that direction — callers should fall
  // back to handleDpadNavigation/moveFocusDirectional for those boundary cases.
  // Zero getBoundingClientRect calls — all look-ups are pure index arithmetic.
  navigateWithGrid(container, direction) {
    const current = container?.querySelector(".focusable.focused");
    if (!current) {
      return false;
    }
    const rowStr = current.dataset.navGridRow;
    if (rowStr === undefined || rowStr === "") {
      return false;
    }
    const grid = this._navGrids?.get(container);
    if (!grid?.rows) {
      return false;
    }

    const row = Number(rowStr);
    const col = Number(current.dataset.navGridCol || 0);
    const rows = grid.rows;
    let target = null;

    if (direction === "left") {
      target = rows[row]?.[col - 1] || null;
    } else if (direction === "right") {
      target = rows[row]?.[col + 1] || null;
    } else if (direction === "up") {
      const prevRow = rows[row - 1];
      target = prevRow ? (prevRow[Math.min(col, prevRow.length - 1)] || null) : null;
    } else if (direction === "down") {
      const nextRow = rows[row + 1];
      target = nextRow ? (nextRow[Math.min(col, nextRow.length - 1)] || null) : null;
    }

    if (!target || target === current) {
      return false;
    }

    current.classList.remove("focused");
    target.classList.add("focused");
    try {
      target.focus({ preventScroll: true });
    } catch (_) {
      try {
        target.focus();
      } catch (_) {}
    }
    return true;
  },

  // Discard the cached grid for a container so the next buildNavGrid call starts fresh.
  invalidateNavGrid(container) {
    this._navGrids?.delete(container);
  }

};
