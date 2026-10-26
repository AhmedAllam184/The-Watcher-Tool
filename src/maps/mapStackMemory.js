import { MAP_STACK_IDS } from './stackIds.js';

/**
 * The map source a visitor last picked in MAP SOURCE, kept across restarts.
 * Only the id is stored. Availability is not, because it depends on keys and
 * the session: the controller falls back to the default for a stack that is
 * unavailable right now, so a remembered Google 3D without a key does nothing.
 */
export const MAP_STACK_STORAGE_KEY = 'watcher.mapStack';

const KNOWN_STACK_IDS = new Set(MAP_STACK_IDS);

/**
 * @param {{getItem?: Function}|null} [storage] Defaults to localStorage. Injected in tests.
 * @returns {string|null} A known stack id, or null when nothing valid is stored.
 */
export function readRememberedMapStack(storage) {
  try {
    const store = storage === undefined ? globalThis.localStorage : storage;
    const value = store?.getItem?.(MAP_STACK_STORAGE_KEY);
    return KNOWN_STACK_IDS.has(value) ? value : null;
  } catch {
    // Blocked storage (private mode, policies) means no memory, not an error.
    return null;
  }
}

/**
 * Remember a visitor's explicit map-source pick. Unknown ids are ignored.
 * @param {string} id
 * @param {{setItem?: Function}|null} [storage]
 * @returns {boolean} true only if the choice was written.
 */
export function writeRememberedMapStack(id, storage) {
  if (!KNOWN_STACK_IDS.has(id)) return false;
  try {
    const store = storage === undefined ? globalThis.localStorage : storage;
    if (typeof store?.setItem !== 'function') return false;
    store.setItem(MAP_STACK_STORAGE_KEY, id);
    return true;
  } catch {
    return false;
  }
}
