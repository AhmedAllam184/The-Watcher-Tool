/**
 * @module textSize
 * @description "Larger text" preference. It is one class on the document
 * element, which readability.css scales, and one per-browser flag. Storage can
 * be blocked or full, so every access is guarded and the default size remains.
 */

export const LARGE_TEXT_CLASS = 'watcher-large-text';
export const LARGE_TEXT_STORAGE_KEY = 'watcher.largeText';

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether the viewer chose larger text on an earlier visit.
 * @param {object} [options]
 * @param {Storage|null} [options.storage] Storage to read; defaults to localStorage.
 * @returns {boolean}
 */
export function readLargeTextPreference({ storage = defaultStorage() } = {}) {
  try {
    return storage?.getItem(LARGE_TEXT_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Apply the larger-text class and remember the choice for the next visit.
 * @param {boolean} large Whether larger text is on.
 * @param {object} [options]
 * @param {HTMLElement} [options.root=document.documentElement] Element that carries the class.
 * @param {Storage|null} [options.storage] Storage to write; defaults to localStorage.
 * @returns {boolean} The applied state.
 */
export function applyTextSize(
  large,
  { root = document.documentElement, storage = defaultStorage() } = {},
) {
  const on = Boolean(large);
  root.classList.toggle(LARGE_TEXT_CLASS, on);
  try {
    storage?.setItem(LARGE_TEXT_STORAGE_KEY, on ? '1' : '0');
  } catch {
    // The class still applies for this page view; only the memory is lost.
  }
  return on;
}

/**
 * Apply the saved preference without writing it back. Runs once at startup.
 * @param {object} [options] Same options as applyTextSize.
 * @returns {boolean} The applied state.
 */
export function applyStoredTextSize(options = {}) {
  const on = readLargeTextPreference(options);
  const root = options.root ?? document.documentElement;
  root.classList.toggle(LARGE_TEXT_CLASS, on);
  return on;
}
