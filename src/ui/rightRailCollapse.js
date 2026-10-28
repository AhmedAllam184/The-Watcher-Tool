/**
 * @module rightRailCollapse
 * @description The TOOLS card now collapses through the same disclosure key as
 * every other left-column card. The old tab-style pane kept one per-browser
 * flag; this module only reads that flag once so a saved choice survives the
 * change. Storage can be blocked or full, so every access is guarded.
 */

export const RIGHT_RAIL_COLLAPSED_STORAGE_KEY = 'watcher.rightRailCollapsed';

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Read and retire the legacy TOOLS collapse flag.
 * @param {object} [options]
 * @param {Storage|null} [options.storage] Storage to use; defaults to localStorage.
 * @returns {boolean|null} true or false when a choice was saved, null when none was.
 */
export function takeLegacyRightRailCollapsed({
  storage = defaultStorage(),
} = {}) {
  try {
    const raw = storage?.getItem(RIGHT_RAIL_COLLAPSED_STORAGE_KEY);
    if (raw === null || raw === undefined) return null;
    storage.removeItem(RIGHT_RAIL_COLLAPSED_STORAGE_KEY);
    return raw === '1';
  } catch {
    return null;
  }
}
