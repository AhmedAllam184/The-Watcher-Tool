// src/data/militaryTypeNames.js
/**
 * Military ICAO type designators (as ADS-B feeds send them) mapped to the
 * type's common name, so the aircraft photo fallback can search for it.
 * Only designators whose meaning is unambiguous are listed; anything else is
 * searched by its raw text. Keys are upper-case with no spaces.
 */
export const MILITARY_TYPE_NAMES = Object.freeze({
  C17: 'C-17 Globemaster III',
  C5M: 'C-5M Super Galaxy',
  C130: 'C-130 Hercules',
  C30J: 'C-130 Hercules',
  K35R: 'KC-135 Stratotanker',
  KC46: 'KC-46 Pegasus',
  K10: 'KC-10 Extender',
  E3TF: 'E-3 Sentry',
  E3CF: 'E-3 Sentry',
  E6: 'E-6 Mercury',
  P8: 'P-8 Poseidon',
  RC35: 'RC-135',
  U2: 'U-2',
  GLF5: 'C-37 Gulfstream',
  C37: 'C-37 Gulfstream',
  B52: 'B-52 Stratofortress',
  F16: 'F-16 Fighting Falcon',
  F35: 'F-35 Lightning II',
  EUFI: 'Eurofighter Typhoon',
  A400: 'Airbus A400M Atlas',
  H60: 'UH-60 Black Hawk',
  H47: 'CH-47 Chinook',
  V22: 'V-22 Osprey',
  MQ9: 'MQ-9 Reaper',
  RQ4: 'RQ-4 Global Hawk',
  P3: 'P-3 Orion',
  HRON: 'IAI Heron',
});
