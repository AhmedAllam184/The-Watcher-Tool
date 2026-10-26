/**
 * Live-object lookup for the place search box. Families are searched in the
 * same order voice track_entity uses; only enabled layers with a findByQuery
 * are consulted.
 */
const SEARCHABLE_FAMILIES = Object.freeze([
  { layerId: 'flights', kind: 'aircraft', name: 'Live Flights' },
  { layerId: 'military', kind: 'aircraft', name: 'Military Flights' },
  { layerId: 'ais-live-vessels', kind: 'vessel', name: 'Live AIS Vessels' },
  { layerId: 'satellites', kind: 'satellite', name: 'Satellites' },
]);

const MIN_QUERY_LENGTH = 2;

/** Optional prefixes that force a loose (partial-name) search of one kind. */
const KIND_PREFIXES = Object.freeze({
  flight: 'aircraft',
  plane: 'aircraft',
  ship: 'vessel',
  vessel: 'vessel',
  sat: 'satellite',
  satellite: 'satellite',
});

const normalize = (value) =>
  String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();

/**
 * Whether a match names the query exactly. Layer lookups also accept partial
 * names, which would let a ship called "TOKYO EXPRESS" hijack a search for
 * the city, so a plain query only wins on an exact identity.
 */
function isExactMatch(found, text) {
  const wanted = normalize(text);
  return [
    found?.callsign,
    found?.registration,
    found?.icao24,
    found?.mmsi,
    found?.name,
    found?.noradId,
  ].some((value) => value != null && normalize(value) === wanted);
}

/**
 * Find the first enabled live object matching a free-text query. A plain
 * query must match an identity exactly; "ship:", "flight:" or "sat:" (and
 * their long forms) search one kind by partial name.
 * @param {object} dataManager - Exposes `isEnabled(layerId)` and `layers.get(layerId).module`.
 * @param {string} query - Callsign, registration, ICAO hex, MMSI, vessel name, NORAD id or satellite name.
 * @returns {{layerId: string, kind: string, found: object}|null} The match, or null.
 */
export function findLiveObject(dataManager, query) {
  let text = String(query ?? '').trim();
  const prefix = /^([a-z]+):\s*(.*)$/i.exec(text);
  const onlyKind = prefix ? KIND_PREFIXES[prefix[1].toLowerCase()] : null;
  if (onlyKind) text = prefix[2].trim();
  if (!dataManager || text.length < MIN_QUERY_LENGTH) return null;
  for (const { layerId, kind } of SEARCHABLE_FAMILIES) {
    if (onlyKind && kind !== onlyKind) continue;
    if (!dataManager.isEnabled(layerId)) continue;
    const module = dataManager.layers.get(layerId)?.module;
    // A plain query asks for an exact identity first. findByQuery returns only
    // the first partial match, so an exact record later in the list would be
    // missed behind it ("EVER GIVEN II" before "EVER GIVEN").
    if (!onlyKind && typeof module?.findExact === 'function') {
      const exact = module.findExact(text);
      if (exact) return { layerId, kind, found: exact };
    }
    if (typeof module?.findByQuery !== 'function') continue;
    const found = module.findByQuery(text);
    if (found && (onlyKind || isExactMatch(found, text)))
      return { layerId, kind, found };
  }
  return null;
}

/**
 * Searchable layer ids that are currently switched off, in search order.
 * @param {object} dataManager
 * @returns {string[]}
 */
export function searchableDisabledLayers(dataManager) {
  if (!dataManager) return [];
  return SEARCHABLE_FAMILIES.filter(
    ({ layerId }) => !dataManager.isEnabled(layerId),
  ).map(({ layerId }) => layerId);
}

/**
 * User-facing layer name for a searchable layer id.
 * @param {string} layerId
 * @returns {string}
 */
export function searchableLayerName(layerId) {
  return (
    SEARCHABLE_FAMILIES.find((family) => family.layerId === layerId)?.name ||
    layerId
  );
}

/**
 * Display name for a matched object: callsign, registration, name, then id.
 * @param {object} found - Descriptor returned by `findByQuery`.
 * @returns {string} Empty when the descriptor carries no identity.
 */
export function objectLabel(found) {
  const text = (value) => String(value ?? '').trim();
  return (
    text(found?.callsign) ||
    text(found?.registration) ||
    text(found?.name) ||
    text(found?.icao24) ||
    text(found?.mmsi) ||
    text(found?.noradId)
  );
}
