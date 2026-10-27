/**
 * @module selectionDetailsModel
 * @description Pure translation of a shared context record into plain-language
 * rows for the selection details panel. No DOM, no Cesium, no store access.
 */
import { normalizeVesselType } from '../data/vesselLabels.js';
import { describeSquawk } from '../data/squawk.js';
import { satcatObjectTypeText } from '../data/satcatCodes.js';

const FEET_PER_METRE = 3.28084;
const KMH_PER_KNOT = 1.852;
const COMPASS_POINTS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
];

/** Inclusive run of MMSI Maritime Identification Digits. */
function span(low, high) {
  return Array.from({ length: high - low + 1 }, (_, index) => low + index);
}

/** The most common MIDs (first three digits of an MMSI) and their flag states. */
const MID_COUNTRIES = new Map(
  [
    ['Albania', [201]],
    ['Germany', [211, 218]],
    ['Denmark', [219, 220]],
    ['Spain', [224, 225]],
    ['France', span(226, 228)],
    ['United Kingdom', span(232, 235)],
    ['Gibraltar', [236]],
    ['Greece', [237, ...span(239, 241)]],
    ['Netherlands', span(244, 246)],
    ['Italy', [247]],
    ['Malta', [248, 249, 256]],
    ['Portugal', [255]],
    ['Norway', span(257, 259)],
    ['Sweden', [265, 266]],
    ['Russia', [273]],
    ['Antigua and Barbuda', [304, 305]],
    ['Bahamas', [308, 309, 311]],
    ['United States', [338, ...span(366, 369)]],
    ['Panama', [...span(351, 357), ...span(370, 373)]],
    ['China', span(412, 414)],
    ['India', [419]],
    ['Japan', [431, 432]],
    ['South Korea', [440, 441]],
    ['United Arab Emirates', [470, 471]],
    ['Saudi Arabia', [403]],
    ['Iran', [422]],
    ['Hong Kong', [477]],
    ['Indonesia', [525]],
    ['Malaysia', [533]],
    ['Marshall Islands', [538]],
    ['Singapore', span(563, 566)],
    ['Tuvalu', [572]],
    ['Vanuatu', [577]],
    ['Egypt', [622]],
    ['Liberia', [636, 637]],
  ].flatMap(([country, mids]) => mids.map((mid) => [mid, country])),
);

/**
 * Map an AIS record's 16-point compass bearing.
 * @param {number} deg Bearing in degrees; any finite value is wrapped to 0-360.
 * @returns {string} Compass word such as "NNE", or '' for a non-finite input.
 */
export function compassPoint(deg) {
  if (!Number.isFinite(deg)) return '';
  const wrapped = ((deg % 360) + 360) % 360;
  return COMPASS_POINTS[Math.round(wrapped / 22.5) % COMPASS_POINTS.length];
}

/**
 * Describe the age of a timestamp in plain words.
 * @param {number} ms Epoch milliseconds of the event.
 * @param {number} [now=Date.now()] Current epoch milliseconds.
 * @returns {string} "just now", "2 min ago", "5 h ago", "3 d ago", or '' when ms is invalid.
 */
export function formatRelativeTime(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return '';
  const seconds = Math.floor((now - ms) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/**
 * Name the flag state that issued an MMSI.
 * @param {string|number} mmsi Nine-digit MMSI; only the first three digits are used.
 * @returns {string|null} Country name, or null when the MID is not in the table.
 */
export function flagFromMmsi(mmsi) {
  const text = String(mmsi ?? '').trim();
  if (!/^\d{3}/.test(text)) return null;
  return MID_COUNTRIES.get(Number(text.slice(0, 3))) || null;
}

/** AIS epoch values arrive in seconds or milliseconds; return milliseconds. */
function epochToMs(value) {
  const number = leadingNumber(value);
  if (number === null || number <= 0) return null;
  return number < 1e11 ? number * 1000 : number;
}

/** First number in a value such as "35,000 ft"; null when there is none. */
function leadingNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const match = String(value ?? '')
    .replace(/,/g, '')
    .match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

/** Group thousands with commas and round to `digits` places. */
function formatNumber(value, digits = 0) {
  const [whole, fraction] = Number(value).toFixed(digits).split('.');
  const sign = whole.startsWith('-') ? '-' : '';
  const grouped = whole.replace('-', '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${grouped}${fraction ? `.${fraction}` : ''}`;
}

/** Knots shown as knots and km/h. */
function speedValue(knots, digits = 0) {
  return `${formatNumber(knots, digits)} kt (${formatNumber(knots * KMH_PER_KNOT)} km/h)`;
}

/** Degrees shown with their compass word, e.g. "270° (W)". */
function degreeValue(degrees) {
  const shown = ((Math.round(degrees) % 360) + 360) % 360;
  return `${shown}° (${compassPoint(degrees)})`;
}

/** Upper-case the first letter of a plain word; leave the rest alone. */
function capitalize(text) {
  const trimmed = String(text ?? '').trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

/** "lastPositionUtc" / "last_position" → "Last Position Utc". */
function humanLabel(key) {
  return String(key)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Lower-case AIS type text in sentence case: "HIGH-SPEED" → "High-speed". */
function plainType(type) {
  return capitalize(normalizeVesselType(type));
}

/** Append a row only when it has a value to show. */
function pushRow(rows, label, value) {
  if (value === null || value === undefined) return;
  const text = String(value).trim();
  if (text) rows.push({ label, value: text });
}

function finiteCoordinate(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** "51.5074° N, 0.1278° W" with four decimals. */
function coordinateText(latitude, longitude) {
  const lat = `${Math.abs(latitude).toFixed(4)}° ${latitude < 0 ? 'S' : 'N'}`;
  const lon = `${Math.abs(longitude).toFixed(4)}° ${longitude < 0 ? 'W' : 'E'}`;
  return `${lat}, ${lon}`;
}

function buildFlight(record, properties) {
  const callsign = String(properties.callsign || '').trim();
  const icao24 = String(properties.icao24 || '').trim();
  const rows = [];
  const links = [];
  const altitude = String(properties.altitude ?? '').trim();
  const altitudeFeet = leadingNumber(altitude);
  const speedKt = leadingNumber(properties.speed);
  const headingDeg = leadingNumber(properties.heading);
  // City names when the flight's route is known, else the codes-only Route row.
  const routeFrom = String(properties.routeFrom || '').trim();
  const routeTo = String(properties.routeTo || '').trim();
  const routeStatus = String(properties.routeStatus || '').trim();
  if (routeFrom || routeTo) {
    pushRow(rows, 'From', routeFrom);
    pushRow(rows, 'To', routeTo);
  } else if (routeStatus === 'pending') pushRow(rows, 'Route', 'Looking up…');
  else if (routeStatus === 'unknown')
    pushRow(
      rows,
      'Route',
      `Not published for ${callsign || icao24.toUpperCase()}`,
    );
  else pushRow(rows, 'Route', properties.route);
  pushRow(rows, 'Aircraft', properties.type);
  pushRow(rows, 'Registration', properties.registration);
  pushRow(rows, 'Airborne since', properties.airborneSince);
  if (/on ground/i.test(altitude)) pushRow(rows, 'Altitude', 'On the ground');
  else if (altitudeFeet !== null)
    pushRow(
      rows,
      'Altitude',
      `${formatNumber(altitudeFeet)} ft (${formatNumber(altitudeFeet / FEET_PER_METRE)} m)`,
    );
  else pushRow(rows, 'Altitude', altitude);
  if (speedKt !== null) pushRow(rows, 'Speed', speedValue(speedKt));
  if (headingDeg !== null) pushRow(rows, 'Heading', degreeValue(headingDeg));
  pushRow(rows, 'Holding', properties.holding);
  pushRow(rows, 'ICAO hex', icao24.toUpperCase());
  const status = String(properties.status || '').trim();
  if (/^stale/i.test(status))
    pushRow(rows, 'Status', 'Last known — missed updates');
  else if (/^live$/i.test(status)) pushRow(rows, 'Status', 'Live');
  else pushRow(rows, 'Status', status);
  const squawk = describeSquawk(properties.squawk);
  let alert = null;
  if (squawk?.emergency) {
    alert = `Emergency squawk ${squawk.code} — ${squawk.meaning}`;
    pushRow(rows, 'Squawk', `${squawk.code} — ${squawk.meaning}`);
  } else if (squawk) pushRow(rows, 'Squawk', squawk.code);
  pushRow(rows, 'Data source', record.source);
  if (callsign)
    links.push({
      label: 'FlightRadar24',
      href: `https://www.flightradar24.com/${encodeURIComponent(callsign)}`,
    });
  if (icao24)
    links.push({
      label: 'ADS-B Exchange',
      href: `https://globe.adsbexchange.com/?icao=${encodeURIComponent(icao24)}`,
    });
  return {
    kind: 'flight',
    title: callsign || String(properties.name || record.label || ''),
    subtitle: String(properties.operator || ''),
    rows,
    links,
    alert,
    // Hex for the aircraft photo lookup (lower-case, validated).
    photoHex: /^[0-9a-f]{6}$/i.test(icao24) ? icao24.toLowerCase() : null,
    // Type text for the photo's type fallback (a name, or a military code).
    photoType:
      String(properties.typeName || properties.type || '').trim() || null,
  };
}

function buildVessel(record, properties, now) {
  const entity = record.entity || {};
  const mmsi = String(properties.mmsi || entity.mmsi || '').trim();
  const imo = String(entity.imo || '').trim();
  const rows = [];
  const links = [];
  const speedKt = leadingNumber(entity.speed ?? properties.speedKt);
  const course = leadingNumber(entity.course ?? properties.course);
  const heading = leadingNumber(entity.heading);
  const type = plainType(entity.type || properties.type);
  pushRow(rows, 'Type', type);
  pushRow(rows, 'Destination', entity.destination || properties.destination);
  if (speedKt !== null) pushRow(rows, 'Speed', speedValue(speedKt, 1));
  if (course !== null) pushRow(rows, 'Course', degreeValue(course));
  // AIS sends 511 for "heading not available".
  if (heading !== null && heading >= 0 && heading < 360)
    pushRow(rows, 'Heading', degreeValue(heading));
  pushRow(rows, 'MMSI', mmsi);
  pushRow(rows, 'IMO', imo);
  pushRow(rows, 'Flag', flagFromMmsi(mmsi));
  const lastSeen = formatRelativeTime(epochToMs(entity.lastPositionEpoch), now);
  pushRow(rows, 'Last position', lastSeen);
  // A gone-dark ship is an inference from silence, not a feed fault.
  const dark = entity.dark === true;
  if (dark) {
    pushRow(rows, 'Status', 'Gone dark (inferred)');
    pushRow(rows, 'Why flagged', entity.inference);
  } else {
    const stale = (entity.missedRefreshes || 0) > 0;
    pushRow(rows, 'Status', stale ? 'Stale — missed updates' : 'Live');
  }
  if (mmsi) {
    links.push({
      label: 'MarineTraffic',
      href: `https://www.marinetraffic.com/en/ais/details/ships/mmsi:${encodeURIComponent(mmsi)}`,
    });
    links.push({
      label: 'VesselFinder',
      href: `https://www.vesselfinder.com/vessels/details/${encodeURIComponent(mmsi)}`,
    });
  }
  if (dark) {
    const silent = lastSeen ? lastSeen.replace(/ ago$/, '') : 'a while';
    return {
      kind: 'vessel',
      title: String(entity.name || record.label || ''),
      subtitle: type,
      rows,
      links,
      alert: `No AIS signal for ${silent} while under way. Inferred from silence where nearby ships still report — not confirmed.`,
      alertTone: 'warn',
    };
  }
  return {
    kind: 'vessel',
    title: String(entity.name || record.label || ''),
    subtitle: type,
    rows,
    links,
  };
}

function buildFire(properties, latitude, longitude) {
  const rows = [];
  const links = [];
  const age = String(properties.age ?? '').trim();
  let detected = '';
  if (/unknown/i.test(age)) detected = 'Unknown';
  else if (age) detected = /ago/i.test(age) ? age : `${age} ago`;
  pushRow(rows, 'Detected', detected);
  const sensor = String(properties.sensor ?? '').trim();
  if (sensor && !/^unknown$/i.test(sensor))
    pushRow(rows, 'Satellite/sensor', sensor);
  const confidence = String(properties.confidence ?? '').trim();
  if (confidence) pushRow(rows, 'Confidence', capitalize(confidence));
  const frp = leadingNumber(properties.frp);
  if (frp !== null)
    pushRow(rows, 'Fire radiative power', `${formatNumber(frp, 1)} MW`);
  if (latitude !== null && longitude !== null)
    links.push({
      label: 'NASA FIRMS map',
      href: `https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;@${longitude},${latitude},10z`,
    });
  return {
    kind: 'fire',
    title: 'Active fire',
    subtitle: 'Satellite detection (NASA FIRMS)',
    rows,
    links,
  };
}

/** Object type a designation alone reveals ("CZ-2C R/B", "COSMOS 1408 DEB"); null when it reveals none. */
function objectTypeFromName(name) {
  if (/\bR\/B\b/i.test(name)) return satcatObjectTypeText('R/B');
  if (/\bDEB\b/i.test(name)) return satcatObjectTypeText('DEB');
  return null;
}

/** "LEO · 883 km × 870 km · 98.6° · 102 min"-style summary; unknown parts are left out. */
function satelliteOrbitText(info) {
  const parts = [info.orbitClass];
  if (info.apogeeKm !== null && info.perigeeKm !== null)
    parts.push(
      `${formatNumber(info.apogeeKm)} km × ${formatNumber(info.perigeeKm)} km`,
    );
  if (info.inclinationDeg !== null)
    parts.push(`${formatNumber(info.inclinationDeg, 1)}°`);
  if (info.periodMin !== null)
    parts.push(`${formatNumber(info.periodMin)} min`);
  return parts.filter(Boolean).join(' · ');
}

/** Radar cross-section band with its square-metre value, e.g. "Small (0.05 m²)". */
function satelliteSizeText(info) {
  const digits = info.rcsM2 < 10 ? 2 : 0;
  return `${capitalize(info.rcsSize || '')} (${formatNumber(info.rcsM2, digits)} m²)`;
}

/**
 * Satellite rows: the catalogue record when it has arrived, a loading or
 * failure line while it is pending, and the live altitude and class always.
 * The name-based type hint shows before any data arrives.
 */
function buildSatellite(record, properties, satelliteInfo) {
  const norad = satelliteNoradOf(record);
  const name = String(properties.name || record.label || '').trim();
  const info =
    satelliteInfo && satelliteInfo.norad === norad ? satelliteInfo : null;
  const data = info?.status === 'ok' ? info.satellite : null;
  const typeHint = objectTypeFromName(name);
  const rows = [];
  const links = [];
  pushRow(rows, 'NORAD ID', norad);
  if (data) {
    pushRow(rows, 'Owner / country', data.owner?.name);
    pushRow(rows, 'Type', data.objectTypeText || typeHint);
    pushRow(rows, 'Status', data.statusText || data.status);
    const launched = [data.launchDate, data.launchSite?.name]
      .filter(Boolean)
      .join(' · ');
    pushRow(rows, 'Launched', launched);
    pushRow(rows, 'International ID', data.intlDesignator);
    pushRow(rows, 'Orbit', satelliteOrbitText(data));
    if (data.rcsM2 !== null) pushRow(rows, 'Size', satelliteSizeText(data));
    pushRow(rows, 'Decayed', data.decayDate);
    pushRow(rows, 'Data source', data.source || record.source);
  } else {
    pushRow(rows, 'Type', typeHint);
    if (info?.status === 'loading')
      pushRow(rows, 'Catalogue', 'Loading catalogue data…');
    else if (info?.status === 'failed')
      pushRow(rows, 'Catalogue', 'Info unavailable');
  }
  pushRow(rows, 'Class', properties.class);
  pushRow(rows, 'Altitude', properties.altitude);
  if (norad) {
    links.push({
      label: 'N2YO',
      href: `https://www.n2yo.com/satellite/?s=${encodeURIComponent(norad)}`,
    });
    links.push({
      label: 'CelesTrak',
      href: `https://celestrak.org/satcat/table-satcat.php?CATNR=${encodeURIComponent(norad)}&PAYLOAD=0`,
    });
  }
  return {
    kind: 'satellite',
    title: name,
    subtitle:
      data?.objectTypeText || typeHint || String(record.layerName || ''),
    rows,
    links,
    alert: null,
    satelliteNorad: norad,
  };
}

function buildOther(record, properties) {
  const rows = [];
  for (const [key, value] of Object.entries(properties)) {
    if (
      typeof value === 'string' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      pushRow(rows, humanLabel(key), value);
  }
  return {
    kind: 'other',
    title: String(record.label || ''),
    subtitle: String(record.layerName || ''),
    rows,
    links: [],
  };
}

/**
 * NORAD catalogue number of a satellite record as a digit string, or null when
 * the record is not a satellite or carries no usable number.
 * @param {object|null} record Shared context record.
 * @returns {string|null}
 */
export function satelliteNoradOf(record) {
  if (String(record?.layerId || '') !== 'satellites') return null;
  const id = String(record.properties?.noradId ?? record.id ?? '').trim();
  return /^\d{1,9}$/.test(id) && Number(id) > 0 ? String(Number(id)) : null;
}

/**
 * Turn a context record into the plain-language panel model.
 * @param {object|null} record Shared context record (see src/data/contextStore.js).
 * @param {{now?: number, satelliteInfo?: {norad: string, status: 'loading'|'ok'|'failed', satellite: object|null}|null}} [options]
 *   Clock used for relative times, and the catalogue lookup state for a satellite.
 * @returns {{kind: string, title: string, subtitle: string, rows: Array<{label: string, value: string}>, links: Array<{label: string, href: string}>, alert: string|null, alertTone?: string, photoHex?: string|null, satelliteNorad?: string|null, latitude: number|null, longitude: number|null}|null}
 *   `alert` is set for an emergency transponder squawk (`alertTone` unset) or a
 *   gone-dark vessel (`alertTone: 'warn'`).
 */
export function buildSelectionDetails(
  record,
  { now = Date.now(), satelliteInfo = null } = {},
) {
  if (!record || typeof record !== 'object') return null;
  const layerId = String(record.layerId || '');
  const properties = record.properties || {};
  const latitude = finiteCoordinate(record.latitude);
  const longitude = finiteCoordinate(record.longitude);

  let details;
  if (layerId === 'flights' || layerId === 'military')
    details = buildFlight(record, properties);
  else if (layerId === 'ais-live-vessels')
    details = buildVessel(record, properties, now);
  else if (layerId === 'satellites')
    details = buildSatellite(record, properties, satelliteInfo);
  else if (record.source === 'NASA FIRMS' || layerId.includes('firms'))
    details = buildFire(properties, latitude, longitude);
  else details = buildOther(record, properties);

  if (latitude !== null && longitude !== null)
    details.rows.push({
      label: 'Coordinates',
      value: coordinateText(latitude, longitude),
    });
  return { alert: null, ...details, latitude, longitude };
}
