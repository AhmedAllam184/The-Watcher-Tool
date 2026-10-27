/**
 * "Show readouts" switch in the DISPLAY panel: the UTC clock and camera
 * position in the bottom footer. Attribution is never hidden with them. The
 * choice is one per-browser flag; storage can be blocked or full, so every
 * access is guarded and the readouts stay on by default.
 */

export const SHOW_READOUTS_STORAGE_KEY = 'watcher.showReadouts';
export const READOUTS_HIDDEN_CLASS = 'readouts-hidden';

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether the readouts should show. Defaults to true when nothing is stored.
 * @param {{storage?: Storage|null}} [options]
 * @returns {boolean}
 */
export function readShowReadouts({ storage = defaultStorage() } = {}) {
  try {
    return storage?.getItem(SHOW_READOUTS_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

/**
 * Remember the choice for the next visit.
 * @param {boolean} shown Whether the readouts show.
 * @param {{storage?: Storage|null}} [options]
 */
export function writeShowReadouts(shown, { storage = defaultStorage() } = {}) {
  try {
    storage?.setItem(SHOW_READOUTS_STORAGE_KEY, shown ? '1' : '0');
  } catch {
    // Storage unavailable: the choice still applies for this visit.
  }
}

/**
 * Apply the choice to the page and the Display switch.
 * @param {Document} doc
 * @param {boolean} shown
 */
export function applyShowReadouts(doc, shown) {
  doc?.body?.classList.toggle(READOUTS_HIDDEN_CLASS, !shown);
  const toggle = doc?.getElementById?.('footer-readouts-toggle');
  if (toggle) toggle.checked = shown;
}

/**
 * Restore the stored choice and bind the Display switch.
 * @param {Document} [doc]
 * @returns {{destroy: () => void}}
 */
export function initFooterReadouts(doc = globalThis.document) {
  applyShowReadouts(doc, readShowReadouts());
  const toggle = doc?.getElementById?.('footer-readouts-toggle');
  const onChange = () => {
    const shown = toggle.checked === true;
    applyShowReadouts(doc, shown);
    writeShowReadouts(shown);
  };
  toggle?.addEventListener('change', onChange);
  return {
    destroy() {
      toggle?.removeEventListener('change', onChange);
    },
  };
}
