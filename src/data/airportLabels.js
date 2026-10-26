/**
 * Pure label copy for the bundled OurAirports layer (`local-airports`).
 * No Cesium types: the same text feeds the on-globe label, the card title and
 * the entity context label.
 */

const TRAILING_AIRPORT = /\s+(?:International\s+)?Airport$/i;

function cleanText(value) {
  const text = String(value ?? '').trim();
  return text === 'undefined' || text === 'null' ? '' : text;
}

/**
 * Format an airport as "Name (CODE)", for example "London Heathrow (LHR)".
 * The trailing " Airport" / " International Airport" is dropped for the label
 * only; the full name stays in the feature properties. The IATA code is used
 * when present, otherwise the ICAO code, otherwise no parenthesis is added.
 * @param {object} [properties] {name, iata, icao, ...} feature properties.
 * @returns {string} Label text, or '' when the feature has no name or code.
 */
export function formatAirportLabel(properties) {
  const props = properties && typeof properties === 'object' ? properties : {};
  const name = cleanText(props.name);
  const base = name.replace(TRAILING_AIRPORT, '').trim() || name;
  const code = cleanText(props.iata) || cleanText(props.icao);
  if (!base) return code;
  return code ? `${base} (${code})` : base;
}
