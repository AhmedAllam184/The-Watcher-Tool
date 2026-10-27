/**
 * @module satcatCodes
 * @description Code → plain-language tables for the CelesTrak SATCAT records
 * served by /api/satellites/info. Pure data and lookups: no network, no DOM.
 * A code missing from a table is shown raw rather than guessed at.
 */

/** CelesTrak OWNER codes → the country or organisation that operates the object. */
export const SATCAT_OWNERS = Object.freeze({
  US: 'United States',
  CIS: 'Russia / USSR (CIS)',
  PRC: 'China',
  ROC: 'Taiwan',
  JPN: 'Japan',
  IND: 'India',
  ESA: 'European Space Agency',
  ESRO: 'European Space Research Organisation',
  EUME: 'EUMETSAT',
  FR: 'France',
  UK: 'United Kingdom',
  GER: 'Germany',
  IT: 'Italy',
  SPN: 'Spain',
  NETH: 'Netherlands',
  BEL: 'Belgium',
  SWED: 'Sweden',
  NOR: 'Norway',
  FIN: 'Finland',
  DEN: 'Denmark',
  POL: 'Poland',
  CZCH: 'Czech Republic',
  SWTZ: 'Switzerland',
  LUXE: 'Luxembourg',
  GREC: 'Greece',
  POR: 'Portugal',
  TURK: 'Turkey',
  HUN: 'Hungary',
  BUL: 'Bulgaria',
  UKR: 'Ukraine',
  BELA: 'Belarus',
  KAZ: 'Kazakhstan',
  ARM: 'Armenia',
  AZER: 'Azerbaijan',
  CA: 'Canada',
  MEX: 'Mexico',
  BRAZ: 'Brazil',
  ARGN: 'Argentina',
  CHLE: 'Chile',
  PERU: 'Peru',
  BOL: 'Bolivia',
  URY: 'Uruguay',
  VENZ: 'Venezuela',
  AUS: 'Australia',
  NZ: 'New Zealand',
  SKOR: 'South Korea',
  NKOR: 'North Korea',
  ISRA: 'Israel',
  IRAN: 'Iran',
  SAUD: 'Saudi Arabia',
  UAE: 'United Arab Emirates',
  EGYP: 'Egypt',
  ALG: 'Algeria',
  QAT: 'Qatar',
  BHR: 'Bahrain',
  PAKI: 'Pakistan',
  INDO: 'Indonesia',
  MALA: 'Malaysia',
  SING: 'Singapore',
  THAI: 'Thailand',
  VTNM: 'Vietnam',
  ISS: 'International Space Station partners',
  GLOB: 'Globalstar',
  ORB: 'ORBCOMM',
  SES: 'SES',
  ITSO: 'Intelsat',
  EUTE: 'Eutelsat',
  IM: 'Inmarsat',
  AB: 'Arabsat',
  NATO: 'NATO',
});

/** CelesTrak LAUNCH_SITE codes → the launch complex. */
export const SATCAT_LAUNCH_SITES = Object.freeze({
  AFETR: 'Cape Canaveral, Florida',
  AFWTR: 'Vandenberg, California',
  WLPIS: 'Wallops Island, Virginia',
  TYMSC: 'Baikonur, Kazakhstan',
  PKMTR: 'Plesetsk, Russia',
  VOSTO: 'Vostochny, Russia',
  KYMSC: 'Kapustin Yar, Russia',
  JSC: 'Jiuquan, China',
  TSC: 'Taiyuan, China',
  XICLF: 'Xichang, China',
  WSC: 'Wenchang, China',
  TNSTA: 'Tanegashima, Japan',
  KSCUT: 'Uchinoura, Japan',
  SRILR: 'Sriharikota, India',
  FRGUI: 'Kourou, French Guiana',
  NSC: 'Naro, South Korea',
  SEMLS: 'Semnan, Iran',
  YAVNE: 'Palmachim, Israel',
  RLLB: 'Mahia Peninsula, New Zealand',
  SEAL: 'Sea Launch (ocean platform)',
});

/** CelesTrak OBJECT_TYPE codes. */
export const SATCAT_OBJECT_TYPES = Object.freeze({
  PAY: 'Payload (working spacecraft)',
  'R/B': 'Rocket body — spent upper stage, not a working satellite',
  DEB: 'Debris',
  UNK: 'Unknown',
});

/** CelesTrak OPS_STATUS_CODE values. */
export const SATCAT_OPS_STATUSES = Object.freeze({
  '+': 'Operational',
  '-': 'Non-operational',
  P: 'Partially operational',
  B: 'Backup',
  S: 'Spare',
  X: 'Extended mission',
  D: 'Decayed',
  '?': 'Unknown',
});

/** Look up a code in a table; empty input is null, an unlisted code is shown raw. */
function lookup(table, code) {
  const key = String(code ?? '').trim();
  if (!key) return null;
  return Object.hasOwn(table, key) ? table[key] : key;
}

/** Owner name for an OWNER code, the raw code when unlisted, null when empty. */
export function satcatOwnerName(code) {
  return lookup(SATCAT_OWNERS, code);
}

/** Launch complex for a LAUNCH_SITE code, the raw code when unlisted, null when empty. */
export function satcatLaunchSiteName(code) {
  return lookup(SATCAT_LAUNCH_SITES, code);
}

/** Plain-language OBJECT_TYPE. */
export function satcatObjectTypeText(code) {
  return lookup(SATCAT_OBJECT_TYPES, code);
}

/** Plain-language OPS_STATUS_CODE. */
export function satcatStatusText(code) {
  return lookup(SATCAT_OPS_STATUSES, code);
}
