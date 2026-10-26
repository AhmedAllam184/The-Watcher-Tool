/**
 * Map stack ids and the default one, without Cesium, so UI modules can name
 * them without pulling the renderer in. `catalog.js` owns the full descriptors;
 * a test pins that its ids match MAP_STACK_IDS.
 */

/** Every stack id the catalog defines, in catalog order. */
export const MAP_STACK_IDS = Object.freeze([
  'photoreal',
  'bing-aerial',
  'bing-labels',
  'esri-imagery',
  'osm',
]);

/**
 * The stack a visitor starts on: flat OpenStreetMap streets, roads and labels,
 * the way a street map opens. Google 3D, satellite and the rest stay one click
 * away in MAP SOURCE. Shared links and a remembered choice still win.
 */
export const DEFAULT_MAP_STACK_ID = 'osm';
