/**
 * Presentation constants for the Conflict Events layer, kept pure so the help
 * legend can read them without loading the layer or Cesium.
 */

/** Colour per event class. Anything without a verified ACLED type is a news report. */
export const CONFLICT_STYLE = Object.freeze({
  battles: Object.freeze({
    label: 'Battles',
    swatch: '#ef4444',
    color: '#ef4444',
  }),
  explosions: Object.freeze({
    label: 'Explosions / remote violence',
    swatch: '#f97316',
    color: '#f97316',
  }),
  civilians: Object.freeze({
    label: 'Violence against civilians',
    swatch: '#a855f7',
    color: '#a855f7',
  }),
  news: Object.freeze({
    label: 'News report (unverified)',
    swatch: '#f59e0b',
    color: '#f59e0b',
  }),
});

/** Style key for an event type string from the server. */
export function conflictStyleKey(type) {
  if (type === 'Battles') return 'battles';
  if (type === 'Explosions/Remote violence') return 'explosions';
  if (type === 'Violence against civilians') return 'civilians';
  return 'news';
}
