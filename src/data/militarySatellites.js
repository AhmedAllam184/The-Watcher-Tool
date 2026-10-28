/**
 * Military satellite classification — an inference, not a registry.
 *
 * CelesTrak publishes no "military" flag in its element sets, so a satellite is
 * treated as military when either:
 *   1. its NORAD id is in CelesTrak's "military" GP group (Miscellaneous
 *      Military), which is the one list this app loads for the purpose; or
 *   2. its name matches a conservative list of military programme names.
 *
 * Every positive carries the rule that matched, so the details panel can say
 * why. Rocket bodies and debris are never military payloads: they are rejected
 * before either rule runs, even when they sit in the military list.
 *
 * GPS / NAVSTAR is deliberately NOT a military rule. It is a US Space Force
 * system, but it is a civil-usable navigation service, so GPS satellites stay
 * in the Satellites layer.
 *
 * Pure and Cesium-free so the rules can be unit-tested directly.
 */

/** CelesTrak GP group whose NORAD ids count as military (Miscellaneous Military). */
export const MILITARY_GROUP_TAG = 'military';

/** Rule text when the NORAD id is in the CelesTrak military list. */
export const MILITARY_LIST_RULE = 'CelesTrak military list';

/**
 * Programme-name rules, checked in order. `pattern` runs against the trimmed,
 * upper-cased CelesTrak name; `rule` is the text the UI shows.
 */
export const MILITARY_NAME_RULES = Object.freeze([
  {
    pattern: /^USA[ -]?\d+/,
    rule: 'name: USA-numbered (US government, mainly military)',
  },
  { pattern: /^NROL/, rule: 'name: NROL (US National Reconnaissance Office)' },
  { pattern: /^COSMOS \d+/, rule: 'name: Cosmos (Russian military series)' },
  {
    pattern: /^YAOGAN/,
    rule: 'name: Yaogan (Chinese military remote sensing)',
  },
  {
    pattern: /^TJS[ -]?\d/,
    rule: 'name: TJS (Chinese military-linked test series)',
  },
  {
    pattern: /^OFEQ|^OFEK/,
    rule: 'name: Ofek (Israeli military reconnaissance)',
  },
  {
    pattern: /^CSO[ -]?\d/,
    rule: 'name: CSO (French military optical imaging)',
  },
  { pattern: /^HELIOS/, rule: 'name: Helios (French military reconnaissance)' },
  {
    pattern: /^SAR[ -]?LUPE/,
    rule: 'name: SAR-Lupe (German military radar reconnaissance)',
  },
  {
    pattern: /^SARAH[ -]?\d/,
    rule: 'name: SARah (German military radar reconnaissance)',
  },
  { pattern: /^SKYNET/, rule: 'name: Skynet (UK military communications)' },
  {
    pattern: /^SICRAL/,
    rule: 'name: Sicral (Italian military communications)',
  },
  {
    pattern: /^SYRACUSE/,
    rule: 'name: Syracuse (French military communications)',
  },
  {
    pattern: /^WGS[ -]?\d/,
    rule: 'name: WGS (US military satellite communications)',
  },
  {
    pattern: /^AEHF/,
    rule: 'name: AEHF (US military satellite communications)',
  },
  {
    pattern: /^MILSTAR/,
    rule: 'name: Milstar (US military satellite communications)',
  },
  { pattern: /^MUOS/, rule: 'name: MUOS (US Navy satellite communications)' },
  { pattern: /^SBIRS/, rule: 'name: SBIRS (US missile warning)' },
  { pattern: /^DSP[ -]?\d/, rule: 'name: DSP (US missile warning)' },
  {
    pattern: /^GSSAP|^USA.*GSSAP/,
    rule: 'name: GSSAP (US space surveillance)',
  },
  { pattern: /^LUCH/, rule: 'name: Luch (Russian military relay)' },
  { pattern: /^KONDOR/, rule: 'name: Kondor (Russian military radar)' },
  { pattern: /^LOTOS/, rule: 'name: Lotos (Russian military)' },
  { pattern: /^PION/, rule: 'name: Pion (Russian military)' },
  { pattern: /^BARS[ -]?M/, rule: 'name: Bars-M (Russian military)' },
  { pattern: /^PERSONA/, rule: 'name: Persona (Russian military)' },
  { pattern: /^TSELINA/, rule: 'name: Tselina (Russian military)' },
  { pattern: /^RORSAT/, rule: 'name: RORSAT (Soviet naval radar)' },
  {
    pattern: /^IGS[ -]?\d/,
    rule: 'name: IGS (Japanese Information Gathering Satellite)',
  },
  {
    pattern: /^SHIYAN/,
    rule: 'name: Shiyan (Chinese experimental, likely military)',
  },
  { pattern: /^JIANBING/, rule: 'name: Jianbing (Chinese military)' },
  {
    pattern: /^ZHONGXING[ -]?2\b/,
    rule: 'name: Zhongxing-2 (Chinese military communications)',
  },
  {
    pattern: /^FIA\b|^TOPAZ/,
    rule: 'name: FIA / Topaz (Russian military series, inferred)',
  },
]);

/** Rocket bodies and debris: never military payloads, whatever list they are on. */
const NON_PAYLOAD = /\bDEB\b|\bDEBRIS\b|\bR\/B\b|ROCKET BODY/;

/**
 * Classify one catalogue entry.
 * @param {{ noradId: number, name: string, militaryNoradIds?: Set<number> }} satellite
 *   The NORAD id, CelesTrak name, and the NORAD ids from the military group.
 * @returns {{ military: boolean, rule: string|null }} The verdict and why it was reached.
 */
export function classifyMilitarySatellite({
  noradId,
  name,
  militaryNoradIds = null,
} = {}) {
  const label = String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
  if (NON_PAYLOAD.test(label)) return { military: false, rule: null };
  if (militaryNoradIds?.has(Number(noradId)))
    return { military: true, rule: MILITARY_LIST_RULE };
  for (const { pattern, rule } of MILITARY_NAME_RULES) {
    if (pattern.test(label)) return { military: true, rule };
  }
  return { military: false, rule: null };
}

/**
 * Layer filter for the military layer.
 * @param {{ military: boolean }} verdict A classifyMilitarySatellite result.
 * @returns {boolean}
 */
export function isMilitary(verdict) {
  return verdict?.military === true;
}

/**
 * Layer filter for the civil Satellites layer: everything that is not military.
 * @param {{ military: boolean }} verdict A classifyMilitarySatellite result.
 * @returns {boolean}
 */
export function isCivil(verdict) {
  return !isMilitary(verdict);
}
