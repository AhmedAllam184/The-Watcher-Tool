// src/data/satelliteIdentity.js
/**
 * Plain-language identity for a satellite: which programme it belongs to, what
 * kind of object it is, and the facts a member of the public can check. Pure:
 * no DOM, Cesium or store access.
 *
 * Inputs are the CelesTrak name, the SATCAT object type and owner (when the
 * catalogue record has loaded), the layer's class label and the military rule.
 * The programme names and rocket-body mapping below are written here by hand.
 */

/** Rocket upper stages: name prefix → rocket, and whether the stage is large enough to see. */
const ROCKETS = Object.freeze([
  {
    pattern: /^(?:CZ|LONG MARCH)[- ]?(2C|2D|3B|4B|4C|6|7|8)(?![A-Z0-9])/,
    rocket: (m) => `Long March ${m[1]}`,
  },
  {
    pattern: /^SL-(4|6|14|16)(?!\d)/,
    rocket: (m) =>
      ({ 4: 'Soyuz', 6: 'Molniya', 14: 'Tsyklon', 16: 'Zenit' })[m[1]],
  },
  { pattern: /^FALCON 9(?![\d])/, rocket: () => 'Falcon 9' },
  { pattern: /^ATLAS 5(?!\d)/, rocket: () => 'Atlas V' },
  { pattern: /^DELTA 4(?!\d)/, rocket: () => 'Delta IV' },
  { pattern: /^ARIANE 5(?!\d)/, rocket: () => 'Ariane 5' },
  { pattern: /^ARIANE 4[02](?!\d)/, rocket: () => 'Ariane 4' },
  { pattern: /^PSLV(?![A-Z])/, rocket: () => 'PSLV' },
  { pattern: /^H-2A(?!\d)/, rocket: () => 'H-IIA' },
  { pattern: /^ELECTRON(?![A-Z])/, rocket: () => 'Electron' },
]);

/** Rocket names whose upper stage is large enough to be seen with the naked eye. */
const LARGE_ROCKETS = Object.freeze([
  'Falcon 9',
  'Atlas V',
  'Delta IV',
  'Ariane 5',
  'Long March 3B',
  'Long March 6',
  'Long March 7',
  'Long March 8',
]);

export const VISIBILITY_FACT =
  'Bright enough to see with the naked eye at dusk or dawn (it looks like a steady moving star)';
const NOT_WORKING = 'Not a working satellite';

/** Named programmes, checked in order. `wikiQuery` null means no article is searched for. */
const PROGRAMMES = Object.freeze([
  {
    pattern: /^STARLINK/,
    programme: 'Starlink',
    kindLabel: 'Starlink internet satellite',
    wikiQuery: 'Starlink',
    facts: ['Part of SpaceX’s Starlink broadband constellation'],
  },
  {
    pattern: /^ONEWEB/,
    programme: 'OneWeb',
    kindLabel: 'OneWeb internet satellite',
    wikiQuery: 'OneWeb',
    facts: ['Part of the OneWeb broadband constellation'],
  },
  {
    pattern: /^IRIDIUM/,
    programme: 'Iridium',
    kindLabel: 'Iridium satellite (phones and data)',
    wikiQuery: 'Iridium satellite constellation',
    facts: [],
  },
  {
    pattern: /^GLOBALSTAR/,
    programme: 'Globalstar',
    kindLabel: 'Globalstar satellite (phones and data)',
    wikiQuery: 'Globalstar',
    facts: [],
  },
  {
    pattern: /^ORBCOMM/,
    programme: 'ORBCOMM',
    kindLabel: 'ORBCOMM messaging satellite',
    wikiQuery: 'Orbcomm',
    facts: [],
  },
  {
    pattern: /^(GPS|NAVSTAR)\b/,
    programme: 'GPS',
    kindLabel: 'GPS navigation satellite (US)',
    wikiQuery: 'Global Positioning System',
    facts: [],
  },
  {
    pattern: /^(GALILEO|GSAT0)/,
    programme: 'Galileo',
    kindLabel: 'Galileo navigation satellite (EU)',
    wikiQuery: 'Galileo (satellite navigation)',
    facts: [],
  },
  {
    pattern: /^GLONASS|\bGLONASS\b/,
    programme: 'GLONASS',
    kindLabel: 'GLONASS navigation satellite (Russia)',
    wikiQuery: 'GLONASS',
    facts: [],
  },
  {
    pattern: /^BEIDOU|^COMPASS/,
    programme: 'BeiDou',
    kindLabel: 'BeiDou navigation satellite (China)',
    wikiQuery: 'BeiDou',
    facts: [],
  },
  {
    pattern: /^ISS\b|\bZARYA\b/,
    programme: 'ISS',
    kindLabel: 'International Space Station (crewed)',
    wikiQuery: 'International Space Station',
    facts: ['Crewed: people live and work aboard'],
    visible: true,
  },
  {
    pattern: /^TIANGONG|^CSS\b/,
    programme: 'Tiangong',
    kindLabel: 'Tiangong space station (crewed, China)',
    wikiQuery: 'Tiangong space station',
    facts: ['Crewed: people live and work aboard'],
  },
  {
    pattern: /^HST\b|HUBBLE/,
    programme: 'Hubble',
    kindLabel: 'Hubble Space Telescope',
    wikiQuery: 'Hubble Space Telescope',
    facts: [],
  },
  {
    pattern: /^NOAA\b/,
    programme: 'NOAA',
    kindLabel: 'NOAA weather satellite (US)',
    wikiQuery: 'NOAA weather satellite',
    facts: [],
  },
  {
    pattern: /^METEOR/,
    programme: 'Meteor',
    kindLabel: 'Meteor weather satellite (Russia)',
    wikiQuery: 'Meteor (satellite)',
    facts: [],
  },
  {
    pattern: /^FENGYUN|^FY-/,
    programme: 'Fengyun',
    kindLabel: 'Fengyun weather satellite (China)',
    wikiQuery: 'Fengyun',
    facts: [],
  },
  {
    pattern: /^GOES\b/,
    programme: 'GOES',
    kindLabel: 'Geostationary weather satellite (US)',
    wikiQuery: 'Geostationary Operational Environmental Satellite',
    facts: [],
  },
  {
    pattern: /^METOP/,
    programme: 'MetOp',
    kindLabel: 'MetOp weather satellite (Europe)',
    wikiQuery: 'MetOp',
    facts: [],
  },
  {
    pattern: /^HIMAWARI/,
    programme: 'Himawari',
    kindLabel: 'Himawari weather satellite (Japan)',
    wikiQuery: 'Himawari (weather satellite)',
    facts: [],
  },
  {
    pattern: /^LANDSAT/,
    programme: 'Landsat',
    kindLabel: 'Landsat Earth-observation satellite (US)',
    wikiQuery: 'Landsat program',
    facts: [],
  },
  {
    pattern: /^SENTINEL/,
    programme: 'Sentinel',
    kindLabel: 'Sentinel Earth-observation satellite (EU)',
    wikiQuery: 'Copernicus Sentinel',
    facts: [],
  },
  {
    pattern: /^WORLDVIEW/,
    programme: 'WorldView',
    kindLabel: 'WorldView Earth-observation satellite',
    wikiQuery: 'WorldView satellite',
    facts: [],
  },
  {
    pattern: /^PLANET|^SKYSAT/,
    programme: 'Planet',
    kindLabel: 'Planet Labs Earth-observation satellite',
    wikiQuery: 'Planet Labs',
    facts: [],
  },
  {
    pattern: /^GAOFEN/,
    programme: 'Gaofen',
    kindLabel: 'Gaofen Earth-observation satellite (China)',
    wikiQuery: 'Gaofen',
    facts: [],
  },
  {
    pattern: /^INTELSAT/,
    programme: 'Intelsat',
    kindLabel: 'Intelsat communications satellite',
    wikiQuery: 'Intelsat',
    facts: [],
  },
  {
    pattern: /^SES[ -]|^ASTRA/,
    programme: 'SES',
    kindLabel: 'SES communications satellite',
    wikiQuery: 'SES S.A.',
    facts: [],
  },
  {
    pattern: /^EUTELSAT/,
    programme: 'Eutelsat',
    kindLabel: 'Eutelsat communications satellite',
    wikiQuery: 'Eutelsat',
    facts: [],
  },
  {
    pattern: /^ARABSAT/,
    programme: 'Arabsat',
    kindLabel: 'Arabsat communications satellite',
    wikiQuery: 'Arabsat',
    facts: [],
  },
  {
    pattern: /^NILESAT/,
    programme: 'Nilesat',
    kindLabel: 'Nilesat communications satellite',
    wikiQuery: 'Nilesat',
    facts: [],
  },
  {
    pattern: /^YAOGAN/,
    programme: 'Yaogan',
    kindLabel: 'Yaogan Chinese military reconnaissance satellite',
    wikiQuery: 'Yaogan',
    facts: [],
  },
  {
    pattern: /^NROL|NRO\b/,
    programme: 'NRO',
    kindLabel: 'US National Reconnaissance Office satellite (classified)',
    wikiQuery: 'National Reconnaissance Office',
    facts: [],
  },
  {
    pattern: /^USA[ -]?\d+/,
    programme: 'USA',
    kindLabel: 'US government satellite (USA-numbered, mostly military)',
    wikiQuery: null,
    facts: [],
  },
  {
    pattern: /^COSMOS \d+/,
    programme: 'Cosmos',
    kindLabel: 'Kosmos satellite (Russian military series)',
    wikiQuery: 'Kosmos satellite',
    facts: [],
  },
]);

/** Generic kind by class label, when no programme name matches. */
const CLASS_KINDS = Object.freeze([
  { pattern: /^STATION/, kindLabel: 'Crewed space station' },
  { pattern: /^NAV/, kindLabel: 'Navigation satellite' },
  {
    pattern: /^GEO/,
    kindLabel: 'Geostationary satellite (fixed over the equator)',
  },
  {
    pattern: /^COMMS/,
    kindLabel: 'Communications satellite (broadband shell)',
  },
  { pattern: /^MILITARY/, kindLabel: 'Military satellite' },
]);

/** Name upper-cased with single spaces. */
function normalizedName(name) {
  return String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

/** The rocket a rocket body belongs to, or null. */
function rocketOf(label) {
  for (const { pattern, rocket } of ROCKETS) {
    const match = pattern.exec(label);
    if (match) return rocket(match);
  }
  return null;
}

/** The programme entry a name belongs to, or null. */
function programmeOf(label) {
  return PROGRAMMES.find(({ pattern }) => pattern.test(label)) || null;
}

/**
 * Plain-language identity for a satellite.
 * @param {object} [input]
 * @param {string} [input.name] CelesTrak name, e.g. "STARLINK-1007" or "CZ-2C R/B".
 * @param {string|null} [input.objectType] SATCAT object type code: "PAY", "R/B", "DEB", "TBA", "PLA" or "OBJ".
 * @param {{name?: string|null}|null} [input.owner] SATCAT owner record.
 * @param {string} [input.classLabel] Layer class label, e.g. "NAV · GPS" or "STATION · ISS".
 * @param {string} [input.militaryRule] Why the military layer counts it; '' when civil.
 * @returns {{programme: string|null, kindLabel: string, facts: string[], wikiQuery: string|null}}
 */
export function describeSatellite({
  name = '',
  objectType = null,
  owner = null,
  classLabel = '',
  militaryRule = '',
} = {}) {
  const label = normalizedName(name);
  const type = String(objectType ?? '')
    .trim()
    .toUpperCase();
  const ownerName = String(owner?.name ?? '').trim();
  const facts = [];
  let programme = null;
  let kindLabel = null;
  let wikiQuery = null;
  let visible = false;

  const isDebris = /\bDEB\b|\bDEBRIS\b/.test(label) || type === 'DEB';
  const isRocketBody =
    !isDebris &&
    (/\bR\/B\b/.test(label) || /KICK STAGE/.test(label) || type === 'R/B');

  if (isDebris) {
    programme = 'Debris';
    kindLabel =
      'Debris: a fragment from a past break-up, explosion or collision; not a working satellite';
    facts.push(NOT_WORKING);
  } else if (isRocketBody) {
    const rocket = rocketOf(label);
    programme = rocket || 'Rocket body';
    kindLabel = rocket
      ? `Rocket body — the spent upper stage of a ${rocket} rocket; space junk, not a working satellite`
      : 'Rocket body — a spent rocket stage; space junk, not a working satellite';
    wikiQuery = rocket;
    facts.push(NOT_WORKING);
    visible = LARGE_ROCKETS.includes(rocket);
  } else {
    const known = programmeOf(label);
    if (known) {
      programme = known.programme;
      kindLabel = known.kindLabel;
      wikiQuery = known.wikiQuery;
      facts.push(...known.facts);
      visible = known.visible === true;
    } else {
      const generic = CLASS_KINDS.find(({ pattern }) =>
        pattern.test(normalizedName(classLabel)),
      );
      kindLabel =
        generic?.kindLabel ||
        (militaryRule ? 'Military satellite' : 'Satellite');
    }
  }

  if (ownerName) facts.push(`Operated by ${ownerName}`);
  if (/^VISUAL/.test(normalizedName(classLabel))) visible = true;
  if (visible) facts.push(VISIBILITY_FACT);

  return { programme, kindLabel, facts, wikiQuery };
}
