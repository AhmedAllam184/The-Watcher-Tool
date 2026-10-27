/**
 * Presentation constants for the Conflict Events layer, kept pure so the help
 * legend can read them without loading the layer or Cesium.
 */

/**
 * Colour per event class. The three legend classes are the buckets people
 * read; `news` is the fallback for a type nothing above matches.
 */
export const CONFLICT_STYLE = Object.freeze({
  battles: Object.freeze({
    label: 'Fighting / clashes',
    swatch: '#ef4444',
    color: '#ef4444',
  }),
  explosions: Object.freeze({
    label: 'Airstrikes / bombings',
    swatch: '#f97316',
    color: '#f97316',
  }),
  civilians: Object.freeze({
    label: 'Violence against people',
    swatch: '#a855f7',
    color: '#a855f7',
  }),
  news: Object.freeze({
    label: 'News report (unverified)',
    swatch: '#f59e0b',
    color: '#f59e0b',
  }),
});

/** The classes listed in the layer's legend, in order. */
export const CONFLICT_LEGEND_KEYS = Object.freeze([
  'explosions',
  'battles',
  'civilians',
]);

/** Event types (ACLED and GDELT) that fall in each class. */
const STYLE_KEY_BY_TYPE = new Map([
  ['Battles', 'battles'],
  ['Armed clash', 'battles'],
  ['Fighting', 'battles'],
  ['Explosions/Remote violence', 'explosions'],
  ['Airstrike / aerial weapons', 'explosions'],
  ['Artillery / tank fire', 'explosions'],
  ['Bombing', 'explosions'],
  ['Violence against civilians', 'civilians'],
  ['Assassination', 'civilians'],
  ['Assault', 'civilians'],
  ['Mass violence', 'civilians'],
]);

/** Style key for an event type string from the server. */
export function conflictStyleKey(type) {
  return STYLE_KEY_BY_TYPE.get(type) ?? 'news';
}
