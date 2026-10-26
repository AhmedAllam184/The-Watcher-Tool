/**
 * @module rightRailCollapse
 * @description Collapsed state of the whole right-side tools pane. Collapsing
 * it leaves a slim TOOLS tab and takes every rail panel out of layout. The
 * choice is one per-browser flag, and storage can be blocked or full, so every
 * access is guarded and the expanded pane remains the default.
 */

export const RIGHT_RAIL_COLLAPSED_CLASS = 'right-rail-collapsed';
export const RIGHT_RAIL_COLLAPSED_STORAGE_KEY = 'watcher.rightRailCollapsed';

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether the viewer collapsed the tools pane on an earlier visit.
 * @param {object} [options]
 * @param {Storage|null} [options.storage] Storage to read; defaults to localStorage.
 * @returns {boolean}
 */
export function readRightRailCollapsed({ storage = defaultStorage() } = {}) {
  try {
    return storage?.getItem(RIGHT_RAIL_COLLAPSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Remember the pane's collapsed state for the next visit.
 * @param {boolean} collapsed Whether the pane is collapsed.
 * @param {object} [options]
 * @param {Storage|null} [options.storage] Storage to write; defaults to localStorage.
 */
export function writeRightRailCollapsed(
  collapsed,
  { storage = defaultStorage() } = {},
) {
  try {
    storage?.setItem(RIGHT_RAIL_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    // Storage unavailable: the pane still collapses for this visit.
  }
}

/**
 * Apply the collapsed class and the toggle's accessible name and state.
 * @param {object} options
 * @param {HTMLElement} options.rail The right-side rail that carries the class.
 * @param {HTMLElement|null} [options.button] The TOOLS toggle.
 * @param {boolean} options.collapsed Whether the pane is collapsed.
 * @returns {boolean} The applied state.
 */
export function applyRightRailCollapsed({ rail, button = null, collapsed }) {
  const next = Boolean(collapsed);
  rail?.classList.toggle(RIGHT_RAIL_COLLAPSED_CLASS, next);
  if (button) {
    const action = next ? 'Expand' : 'Collapse';
    button.setAttribute('aria-expanded', String(!next));
    button.setAttribute('aria-label', `${action} tools pane`);
    button.title = `${action} tools pane`;
    const glyph = button.querySelector?.('.material-symbols-outlined');
    if (glyph)
      glyph.textContent = next ? 'right_panel_open' : 'right_panel_close';
  }
  return next;
}
