/**
 * Camera line for the bottom footer. Pure string formatting, kept apart from
 * hud.js so it can be tested without Cesium or the MGRS package.
 */

/**
 * Altitude for the footer: metres below 10 km, then whole kilometres.
 * @param {number} altMslM Height above mean sea level, in metres.
 * @returns {string} e.g. `"Alt 850 m"` or `"Alt 2,200 km"`.
 */
export function formatFooterAltitude(altMslM) {
  if (!Number.isFinite(altMslM)) return 'Alt --';
  if (Math.abs(altMslM) < 10000)
    return `Alt ${Math.round(altMslM).toLocaleString('en-US')} m`;
  return `Alt ${Math.round(altMslM / 1000).toLocaleString('en-US')} km`;
}

/**
 * The footer's camera line: decimal position, MGRS and altitude.
 * @param {object} input
 * @param {number} input.latDeg Latitude in decimal degrees.
 * @param {number} input.lonDeg Longitude in decimal degrees.
 * @param {string} input.mgrs Formatted MGRS, e.g. `"36R TQ 8130 6617"`.
 * @param {number} input.altMslM Height above mean sea level, in metres.
 * @returns {string} e.g. `"26.8000° N, 30.8000° E · MGRS 36R TQ 8130 6617 · Alt 2,200 km"`.
 */
export function formatFooterPosition({ latDeg, lonDeg, mgrs, altMslM }) {
  if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return '--';
  const lat = `${Math.abs(latDeg).toFixed(4)}° ${latDeg < 0 ? 'S' : 'N'}`;
  const lon = `${Math.abs(lonDeg).toFixed(4)}° ${lonDeg < 0 ? 'W' : 'E'}`;
  return `${lat}, ${lon} · MGRS ${mgrs} · ${formatFooterAltitude(altMslM)}`;
}
