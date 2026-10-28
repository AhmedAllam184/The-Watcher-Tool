// src/data/aircraftIdentity.js
/**
 * Plain-language identity for an aircraft: its name, what kind of aircraft it
 * is, and the facts a member of the public can check. Pure: no DOM, Cesium or
 * store access.
 *
 * Inputs are what the ADS-B feeds already send (readsb `t`, `desc`, `year`,
 * `category`, `dbFlags`) plus adsbdb's type name. The ICAO description table
 * below holds facts written here by hand (for example "L4J" means a landplane
 * with four jet engines). No third-party aircraft-type database is bundled.
 */
import { MILITARY_TYPE_NAMES } from './militaryTypeNames.js';

/** ICAO description code, first character: what kind of aircraft. */
const DESCRIPTION_KINDS = Object.freeze({
  L: 'landplane',
  S: 'seaplane',
  A: 'amphibian',
  H: 'helicopter',
  G: 'gyrocopter',
  T: 'tiltrotor',
});

/** ICAO description code, last character: engine type. */
const ENGINE_TYPES = Object.freeze({
  J: 'jet',
  T: 'turboprop',
  P: 'piston',
  E: 'electric',
  R: 'rocket',
});

/**
 * Description codes for the military types the layer maps to names. Written
 * by hand from the public type facts (engine count and engine type).
 */
const DESCRIPTION_CODES = Object.freeze({
  C17: 'L4J',
  C5M: 'L4J',
  C130: 'L4T',
  C30J: 'L4T',
  A400: 'L4T',
  K35R: 'L4J',
  K10: 'L3J',
  KC46: 'L2J',
  E3TF: 'L4J',
  E3CF: 'L4J',
  E6: 'L4J',
  P8: 'L2J',
  P3: 'L4T',
  RC35: 'L4J',
  U2: 'L1J',
  RQ4: 'L1J',
  MQ9: 'L1T',
  B52: 'L8J',
  F16: 'L1J',
  F35: 'L1J',
  EUFI: 'L2J',
  GLF5: 'L2J',
  H60: 'H2T',
  H47: 'H2T',
  V22: 'T2T',
});

/** ADS-B emitter category → weight class and wake category (where the feed's size implies one). */
const EMITTER_WEIGHT = Object.freeze({
  A1: 'Light (under 7 t)',
  A2: 'Small (7 to 34 t)',
  A3: 'Large (34 to 136 t)',
  A4: 'Large, high-vortex (34 to 136 t)',
  A5: 'Heavy (over 136 t)',
  A6: 'High performance (fast military or aerobatic)',
});
const EMITTER_WAKE = Object.freeze({ A1: 'L', A2: 'L', A3: 'M', A5: 'H' });

/** OpenSky's integer category (state-vector index 17) → ADS-B emitter category. */
const OPENSKY_EMITTER = Object.freeze({
  2: 'A1',
  3: 'A2',
  4: 'A3',
  5: 'A4',
  6: 'A5',
  7: 'A6',
  8: 'A7',
  9: 'B1',
  10: 'B2',
  11: 'B3',
  12: 'B4',
  14: 'B6',
  15: 'B7',
});

/** Emitter category as text ("A3"), from text or OpenSky's integer; '' when unknown. */
export function emitterCategoryText(value) {
  if (typeof value === 'number') return OPENSKY_EMITTER[value] || '';
  const text = String(value ?? '')
    .trim()
    .toUpperCase();
  return /^[ABC][0-7]$/.test(text) ? text : '';
}

/**
 * Split an ICAO description code such as "L2J" into its parts.
 * @param {string|null|undefined} code Three-character description code.
 * @returns {{kind: string|null, engines: number|null, engineType: string|null}}
 */
export function parseDescriptionCode(code) {
  const text = String(code ?? '')
    .trim()
    .toUpperCase();
  if (!/^[LSAHGT]\d[JTPER]$/.test(text))
    return { kind: null, engines: null, engineType: null };
  return {
    kind: DESCRIPTION_KINDS[text[0]],
    engines: Number(text[1]),
    engineType: ENGINE_TYPES[text[2]],
  };
}

/** Upper-case type designator with no spaces, or '' when absent. */
function codeOf(typeCode) {
  return String(typeCode ?? '')
    .replace(/\s+/g, '')
    .toUpperCase();
}

/**
 * The name to show for an aircraft. Order: the feed's own description, then
 * adsbdb's type name, then the common name of a mapped military designator,
 * then the raw designator.
 * @param {{typeDescription?: string|null, typeName?: string|null, typeCode?: string|null}} input
 * @returns {{name: string|null, code: string|null, named: boolean}}
 *   `named` is false when the only text available is the raw designator.
 */
export function resolveAircraftName({
  typeDescription = null,
  typeName = null,
  typeCode = null,
} = {}) {
  const code = codeOf(typeCode) || null;
  const described = String(typeDescription ?? '').trim();
  if (described) return { name: described, code, named: true };
  const named = String(typeName ?? '').trim();
  if (named) return { name: named, code, named: true };
  if (code && Object.hasOwn(MILITARY_TYPE_NAMES, code))
    return { name: MILITARY_TYPE_NAMES[code], code, named: true };
  return { name: code, code, named: false };
}

/** Text rules, in order. The first match names the kind. */
const TEXT_RULES = Object.freeze([
  {
    pattern: /\b(heron|hermes|global hawk)\b/i,
    kind: 'surveillance drone',
    drone: true,
  },
  {
    pattern: /\b(reaper|predator|bayraktar|shahed)\b/i,
    kind: 'armed drone',
    drone: true,
  },
  { pattern: /\b(drone|uav|uas|unmanned)\b/i, kind: 'drone', drone: true },
  {
    pattern:
      /stratotanker|\bKC-|pegasus|\bMRTT\b|\btanker\b|\bextender\b|\bvoyager\b/i,
    kind: 'Air-to-air refuelling tanker',
  },
  {
    pattern:
      /globemaster|hercules|\bA400|galaxy|\bIl-76|\bY-20\b|\bC-2\b|\bC-5\b|\bC-130\b|\bC-17\b|\bC-27\b|\bC-295\b|\bC-390\b/i,
    kind: 'Military transport',
  },
  {
    pattern: /\bF-?(15|16|18|22|35)\b|typhoon|rafale|gripen|\bSu-\d|\bMiG-\d/i,
    kind: 'Fighter jet',
  },
  {
    pattern: /poseidon|orion|\bP-1\b|\bP-3\b|\bP-8\b/i,
    kind: 'Maritime patrol aircraft',
  },
  {
    pattern: /sentry|awacs|\bE-[237]\b|wedgetail|hawkeye|erieye/i,
    kind: 'Airborne early warning (radar)',
  },
  {
    pattern: /rc-135|rivet joint|artemis|\bU-2\b|\bRC-|\bEP-3\b|joint stars/i,
    kind: 'Reconnaissance / intelligence',
  },
  {
    pattern:
      /black hawk|chinook|apache|seahawk|sea king|super stallion|\bMi-(8|17|24|26)\b|\bcobra\b|\bNH90\b|\bUH-|\bAH-|\bCH-/i,
    kind: 'Helicopter',
  },
  {
    pattern:
      /\bboeing (7\d\d|7\d7)\b|\bairbus a3\d\d\b|\bembraer e|\bERJ|\bATR\b|dash 8|\bCRJ|\bA3\d\d\b/i,
    kind: 'Airliner',
    civil: true,
  },
  {
    pattern: /gulfstream|learjet|citation|challenger|\bglobal\b|\bfalcon\b/i,
    kind: 'Business jet',
  },
  {
    pattern: /cessna|piper|cirrus|diamond|mooney|bonanza/i,
    kind: 'Light private aircraft',
  },
]);

/** Type-designator rules for when the feed gave no usable text. */
const CODE_RULES = Object.freeze([
  { pattern: /^(K35[A-Z]?|K10|KC46)$/, kind: 'Air-to-air refuelling tanker' },
  { pattern: /^(C17|C5M|C30J|C130|A400|IL76)$/, kind: 'Military transport' },
  { pattern: /^(F16|F35|EUFI|F15|F18|F22)$/, kind: 'Fighter jet' },
  { pattern: /^(P8|P3)$/, kind: 'Maritime patrol aircraft' },
  { pattern: /^(E3TF|E3CF|E6)$/, kind: 'Airborne early warning (radar)' },
  { pattern: /^(RC35|U2)$/, kind: 'Reconnaissance / intelligence' },
  { pattern: /^(H60|H47|H64|UH1|AH64|MI8|MI17)$/, kind: 'Helicopter' },
  { pattern: /^(MQ9|MQ1)$/, kind: 'armed drone', drone: true },
  { pattern: /^(RQ4|HRON)$/, kind: 'surveillance drone', drone: true },
  {
    pattern:
      /^B7[0-9A-Z]{2}$|^A3\d\d$|^E(170|175|190|195)$|^AT[47]\d$|^DH8|^CRJ/,
    kind: 'Airliner',
    civil: true,
  },
  {
    pattern: /^(C172|C152|C182|C206|C210|PA28|PA32|PA34|SR22|DA40|DA42|M20P)$/,
    kind: 'Light private aircraft',
  },
]);

/** Kinds the ADS-B emitter category names outright. */
const EMITTER_KINDS = Object.freeze({
  A7: 'Helicopter',
  B1: 'Glider',
  B2: 'Balloon or airship',
  B3: 'Parachute aircraft',
  B4: 'Ultralight',
  B6: 'drone',
  B7: 'Space vehicle',
  C1: 'Ground vehicle (not an aircraft)',
  C2: 'Ground vehicle (not an aircraft)',
  C3: 'Obstacle (not an aircraft)',
});

/** Drone wording: the military form has no "(unmanned)" tail, the civil form does. */
const DRONE_LABELS = Object.freeze({
  military: Object.freeze({
    drone: 'Military drone (unmanned)',
    'surveillance drone': 'Military surveillance drone',
    'armed drone': 'Military armed drone',
  }),
  civil: Object.freeze({
    drone: 'Drone (unmanned)',
    'surveillance drone': 'Surveillance drone (unmanned)',
    'armed drone': 'Armed drone (unmanned)',
  }),
});

/** Wording of a non-drone kind when the aircraft is military. */
function militaryWording(kind) {
  if (kind === 'Business jet') return 'Military transport (executive jet)';
  if (kind === 'Light private aircraft')
    return 'Military light aircraft (trainer or utility)';
  if (kind === 'Helicopter') return 'Military helicopter';
  return kind;
}

/**
 * Plain-language identity for an aircraft.
 * @param {object} [input]
 * @param {string|null} [input.typeCode] ICAO type designator (readsb `t`).
 * @param {string|null} [input.typeDescription] Feed description (readsb `desc`).
 * @param {string|null} [input.typeName] adsbdb type name.
 * @param {string|number|null} [input.emitterCategory] ADS-B emitter category ("A3") or OpenSky's integer.
 * @param {number|string|null} [input.buildYear] Year of build (readsb `year`).
 * @param {boolean} [input.military] Military layer, or the feed's `dbFlags & 1`.
 * @returns {{name: string|null, kindLabel: string, facts: string[], military: boolean,
 *   confidence: 'feed'|'inferred', wakeCategory: string|null}}
 *   `confidence` is 'feed' when the kind comes from the emitter category, the
 *   military flag or a hand-written description code, and 'inferred' when a
 *   keyword or designator rule named it.
 */
export function describeAircraft({
  typeCode = null,
  typeDescription = null,
  typeName = null,
  emitterCategory = null,
  buildYear = null,
  military = false,
} = {}) {
  const isMilitary = military === true;
  const { name, code } = resolveAircraftName({
    typeDescription,
    typeName,
    typeCode,
  });
  const emitter = emitterCategoryText(emitterCategory);
  const description = parseDescriptionCode(
    code ? DESCRIPTION_CODES[code] : null,
  );
  const text = String(typeDescription || typeName || '');

  let kind = null;
  let drone = false;
  let confidence = 'inferred';
  for (const rule of TEXT_RULES) {
    if (rule.civil && isMilitary) continue;
    if (!rule.pattern.test(text)) continue;
    kind = rule.kind;
    drone = rule.drone === true;
    break;
  }
  if (!kind && code) {
    for (const rule of CODE_RULES) {
      if (rule.civil && isMilitary) continue;
      if (!rule.pattern.test(code)) continue;
      kind = rule.kind;
      drone = rule.drone === true;
      break;
    }
  }
  if (!kind && EMITTER_KINDS[emitter]) {
    kind = EMITTER_KINDS[emitter];
    drone = kind === 'drone';
    confidence = 'feed';
  }
  if (!kind && description.kind === 'helicopter') {
    kind = 'Helicopter';
    confidence = 'feed';
  }
  if (!kind && description.kind === 'tiltrotor') {
    kind = 'Tiltrotor';
    confidence = 'feed';
  }
  if (!kind && description.kind === 'gyrocopter') {
    kind = 'Gyrocopter';
    confidence = 'feed';
  }
  if (!kind) {
    kind = isMilitary ? 'Military aircraft' : 'Aircraft (type not identified)';
    confidence = 'feed';
  }

  let kindLabel = kind;
  if (drone) {
    const labels = DRONE_LABELS[isMilitary ? 'military' : 'civil'];
    kindLabel = labels[kind] || labels.drone;
  } else if (isMilitary) {
    kindLabel = militaryWording(kind);
  }

  const facts = [];
  if (drone || emitter === 'B6') facts.push('Unmanned (no pilot on board)');
  if (description.engines && description.engineType) {
    const count = description.engines;
    facts.push(
      `${count} ${description.engineType} engine${count === 1 ? '' : 's'}`,
    );
  }
  if (EMITTER_WEIGHT[emitter]) facts.push(EMITTER_WEIGHT[emitter]);
  const wakeCategory = EMITTER_WAKE[emitter] || null;
  if (wakeCategory === 'H') facts.push('Heavy wake turbulence');
  const year = Number(buildYear);
  if (Number.isInteger(year) && year >= 1903 && year <= 2100)
    facts.push(`Built ${year}`);

  return {
    name,
    kindLabel,
    facts,
    military: isMilitary,
    confidence,
    wakeCategory,
  };
}
