/**
 * Follow or select a live object chosen from the place search. Camera work
 * runs through the shell's navigation authority, which is passed in.
 * @param {{layerId: string, kind: string, found: object}} hit - From `findLiveObject`.
 * @param {object} options
 * @param {object} options.viewer - Cesium viewer for vessel flights.
 * @param {Function} options.flyToLandmark - Camera flight helper from `locations.js`.
 * @param {() => object|null} options.readDataManager - Current data manager.
 * @param {(noun: string, navigate: () => *) => *} options.runNavigation - Explicit navigation facade.
 * @returns {boolean} Whether the object was tracked or selected.
 */
export function focusLiveObject(
  hit,
  { viewer, flyToLandmark, readDataManager, runNavigation },
) {
  const { layerId, kind, found } = hit || {};
  const module = readDataManager?.()?.layers.get(layerId)?.module;
  if (!module || !found) return false;
  if (kind === 'vessel') {
    if (!Number.isFinite(found.latitude) || !Number.isFinite(found.longitude))
      return false;
    return (
      runNavigation('vessel', () => {
        const selected = !!module.selectById?.(found.mmsi);
        flyToLandmark(viewer, found.latitude, found.longitude, {
          range: 6000,
          pitch: -45,
          heading: 0,
          buildingHeight: 0,
          duration: 2.0,
        });
        return selected;
      }) === true
    );
  }
  if (kind === 'satellite')
    return (
      runNavigation('satellite', () =>
        module.trackById?.(found.noradId, { origin: 'user' }),
      ) === true
    );
  return (
    runNavigation('contact', () =>
      module.trackById?.(found.icao24, { origin: 'user' }),
    ) === true
  );
}
