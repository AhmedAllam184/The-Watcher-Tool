/**
 * @module helpPanel
 * @description "?" help and map legend: how to get around, the keyboard
 * shortcuts, what the map colours mean, what the feed dots show and two
 * settings. It is a modal dialog built with DOM calls. It owns its listeners
 * and focus, and returns focus to whatever had it before opening.
 */
import { accentForSeverity } from '../data/firmsLabels.js';
import { SATELLITE_CLASSES } from '../data/satelliteClass.js';
import { accentForVesselType } from '../data/vesselLabels.js';
import { GPS_JAM_STYLE } from '../data/gpsJamLabels.js';
import { AIRPORT_STATUS_STYLE } from '../data/airportStatusLabels.js';
import { applyTextSize, readLargeTextPreference } from './textSize.js';

export const HELP_PANEL_ID = 'help-panel';

/**
 * Keyboard shortcuts, mirroring src/ui/applicationShortcuts.js. A test keeps
 * each listed key bound there, so the two lists cannot drift apart silently.
 */
export const HELP_SHORTCUTS = Object.freeze([
  { keys: ['1–7'], action: 'Switch map style' },
  { keys: ['/'], action: 'Search places, flights and ships' },
  { keys: ['H'], action: 'Show or hide the HUD' },
  { keys: ['O'], action: 'Toggle orbit' },
  { keys: ['V'], action: 'Toggle clean view' },
  { keys: ['F'], action: 'Open or close the data layers panel' },
  { keys: ['D'], action: 'Cycle detection mode' },
  { keys: ['C'], action: 'Toggle CCTV' },
  { keys: ['?'], action: 'Show this help' },
  { keys: ['Esc'], action: 'Close search or the open panel' },
]);

/**
 * Map colours. Ship, fire and satellite swatches are read from the modules
 * that draw them. Aircraft and earthquake colours sit beside Cesium code that
 * this panel does not import, so the values below copy them, with sources.
 */
const AIRCRAFT_CIVIL_COLOR = '#ffffff'; // src/layers/flights/rendering.js fleet billboard (Cesium.Color.WHITE)
const AIRCRAFT_MILITARY_COLOR = '#ffb800'; // src/layers/flights/policy.js MIL_TINT (matches src/layers/military/policy.js MIL_ICON_COLOR)
const EARTHQUAKE_SHALLOW_COLOR = '#ff0000'; // src/layers/earthquakes/model.js depthColor, under 70 km (Cesium.Color.RED)
const DARK_SHIP_COLOR = '#f87171'; // src/layers/vessels/dark.js DARK_COLOR

const SHIP_TYPES = Object.freeze([
  { label: 'Cargo', sample: 'Cargo' },
  { label: 'Tanker', sample: 'Tanker' },
  { label: 'Passenger', sample: 'Passenger' },
  { label: 'Fishing', sample: 'Fishing' },
  { label: 'Other', sample: 'Other' },
]);

const FEED_STATUSES = Object.freeze([
  { health: 'live', label: 'Live' },
  { health: 'working', label: 'Loading' },
  { health: 'warn', label: 'Warning: degraded or partial data' },
  { health: 'error', label: 'Failing' },
  { health: 'key', label: 'Needs an API key' },
  { health: 'off', label: 'Off' },
]);

const GETTING_AROUND = Object.freeze([
  'Click any aircraft, ship or fire to see details',
  'Press / to search places, flights or ships',
  'Drag to rotate, scroll to zoom',
  'Esc closes panels',
]);

/**
 * Create the help dialog and attach it to `root`. It starts hidden.
 * @param {object} [options]
 * @param {HTMLElement} [options.root=document.body] Element that receives the dialog.
 * @param {(() => void)|null} [options.openKeySetup] Opens the POWER UP key setup.
 * @param {(() => boolean)|null} [options.canOpenKeySetup] Whether that setup is reachable now.
 * @param {(() => void)|null} [options.openQuickStart] Reopens the first-run mission card.
 * @param {HTMLElement|null} [options.toggleButton] Toolbar button that opens and closes the dialog.
 * @returns {{open: Function, close: Function, toggle: Function, isOpen: Function, destroy: Function}}
 */
export function createHelpPanel({
  root = document.body,
  openKeySetup = null,
  canOpenKeySetup = null,
  openQuickStart = null,
  toggleButton = null,
} = {}) {
  const doc = root.ownerDocument || document;
  let isOpenNow = false;
  let destroyed = false;
  let previouslyFocused = null;

  const panel = doc.createElement('div');
  panel.id = HELP_PANEL_ID;
  panel.className = 'help-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'help-panel-title');
  panel.hidden = true;

  const card = doc.createElement('div');
  card.className = 'help-panel__card';

  const header = doc.createElement('header');
  header.className = 'help-panel__header';
  const title = doc.createElement('h2');
  title.id = 'help-panel-title';
  title.className = 'help-panel__title';
  title.textContent = 'Help and map legend';
  const closeButton = doc.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'help-panel__close';
  closeButton.setAttribute('aria-label', 'Close help');
  closeButton.textContent = '×';
  header.append(title, closeButton);
  card.appendChild(header);

  function makeSection(heading, id) {
    const section = doc.createElement('section');
    section.className = 'help-panel__section';
    section.setAttribute('aria-labelledby', id);
    const h3 = doc.createElement('h3');
    h3.id = id;
    h3.className = 'help-panel__heading';
    h3.textContent = heading;
    section.appendChild(h3);
    card.appendChild(section);
    return section;
  }

  function makeList(section, className) {
    const list = doc.createElement('ul');
    list.className = className;
    section.appendChild(list);
    return list;
  }

  function makeItem(list, text) {
    const item = doc.createElement('li');
    item.textContent = text;
    list.appendChild(item);
    return item;
  }

  function makeSwatchItem(list, color, label, { ring = false } = {}) {
    const item = doc.createElement('li');
    item.className = 'help-panel__swatch-row';
    const swatch = doc.createElement('span');
    swatch.className = ring
      ? 'help-panel__swatch help-panel__swatch--ring'
      : 'help-panel__swatch';
    swatch.setAttribute('aria-hidden', 'true');
    if (ring) swatch.style.borderColor = color;
    else swatch.style.background = color;
    const text = doc.createElement('span');
    text.textContent = label;
    item.append(swatch, text);
    list.appendChild(item);
  }

  // 1. Getting around
  const gettingAround = makeSection(
    'Getting around',
    'help-panel-getting-around',
  );
  const gettingList = makeList(gettingAround, 'help-panel__list');
  for (const line of GETTING_AROUND) makeItem(gettingList, line);

  // 2. Keyboard shortcuts
  const shortcutSection = makeSection(
    'Keyboard shortcuts',
    'help-panel-shortcuts',
  );
  const keys = doc.createElement('dl');
  keys.className = 'help-panel__keys';
  for (const shortcut of HELP_SHORTCUTS) {
    const term = doc.createElement('dt');
    for (const key of shortcut.keys) {
      const kbd = doc.createElement('kbd');
      kbd.textContent = key;
      term.appendChild(kbd);
    }
    const value = doc.createElement('dd');
    value.textContent = shortcut.action;
    keys.append(term, value);
  }
  shortcutSection.appendChild(keys);

  // 3. Map legend
  const legend = makeSection('Map legend', 'help-panel-legend');
  const aircraftHeading = doc.createElement('h4');
  aircraftHeading.className = 'help-panel__subheading';
  aircraftHeading.textContent = 'Aircraft';
  legend.appendChild(aircraftHeading);
  const aircraftList = makeList(legend, 'help-panel__legend');
  makeSwatchItem(aircraftList, AIRCRAFT_CIVIL_COLOR, 'Commercial');
  makeSwatchItem(aircraftList, AIRCRAFT_MILITARY_COLOR, 'Military');

  const shipHeading = doc.createElement('h4');
  shipHeading.className = 'help-panel__subheading';
  shipHeading.textContent = 'Ships by type';
  legend.appendChild(shipHeading);
  const shipList = makeList(legend, 'help-panel__legend');
  for (const ship of SHIP_TYPES) {
    makeSwatchItem(
      shipList,
      `rgb(${accentForVesselType(ship.sample)})`,
      ship.label,
    );
  }

  const otherHeading = doc.createElement('h4');
  otherHeading.className = 'help-panel__subheading';
  otherHeading.textContent = 'Other layers';
  legend.appendChild(otherHeading);
  const otherList = makeList(legend, 'help-panel__legend');
  makeSwatchItem(shipList, DARK_SHIP_COLOR, 'Ship gone dark (inferred)', {
    ring: true,
  });
  makeSwatchItem(
    otherList,
    `rgb(${accentForSeverity('orange')})`,
    'Active fire',
  );
  makeSwatchItem(
    otherList,
    EARTHQUAKE_SHALLOW_COLOR,
    'Earthquake (red is shallow)',
  );
  makeSwatchItem(
    otherList,
    SATELLITE_CLASSES.nav.color,
    'Satellite (navigation)',
  );
  makeSwatchItem(
    otherList,
    GPS_JAM_STYLE.medium.swatch,
    'GPS interference, 2–10% (inferred)',
  );
  makeSwatchItem(
    otherList,
    GPS_JAM_STYLE.high.swatch,
    'GPS interference, over 10% (inferred)',
  );
  makeSwatchItem(
    otherList,
    AIRPORT_STATUS_STYLE.disrupted.swatch,
    'Airport disrupted (inferred)',
    { ring: true },
  );
  makeSwatchItem(
    otherList,
    AIRPORT_STATUS_STYLE.watch.swatch,
    'Airport watch (inferred)',
    { ring: true },
  );

  // 4. Feed status dots
  const feeds = makeSection('Feed status dots', 'help-panel-feeds');
  const feedList = makeList(feeds, 'help-panel__feeds');
  for (const status of FEED_STATUSES) {
    const item = doc.createElement('li');
    const dot = doc.createElement('span');
    dot.className = 'feed-dot';
    dot.setAttribute('data-health', status.health);
    dot.setAttribute('aria-hidden', 'true');
    const text = doc.createElement('span');
    text.textContent = status.label;
    item.append(dot, text);
    feedList.appendChild(item);
  }

  // 5. Settings
  const settings = makeSection('Settings', 'help-panel-settings');
  const largeTextLabel = doc.createElement('label');
  largeTextLabel.className = 'help-panel__option';
  const largeText = doc.createElement('input');
  largeText.type = 'checkbox';
  largeText.className = 'help-panel__check';
  const largeTextName = doc.createElement('span');
  largeTextName.textContent = 'Larger text';
  largeTextLabel.append(largeText, largeTextName);
  settings.appendChild(largeTextLabel);

  let keySetupButton = null;
  if (openKeySetup) {
    keySetupButton = doc.createElement('button');
    keySetupButton.type = 'button';
    keySetupButton.className = 'help-panel__action';
    keySetupButton.textContent = 'Add API keys (POWER UP)';
    settings.appendChild(keySetupButton);
  }

  // Appended after POWER UP so the POWER UP button stays first in the section.
  let quickStartButton = null;
  if (openQuickStart) {
    quickStartButton = doc.createElement('button');
    quickStartButton.type = 'button';
    quickStartButton.className = 'help-panel__action';
    quickStartButton.textContent = 'Quick-start missions…';
    settings.appendChild(quickStartButton);
  }

  panel.appendChild(card);
  root.appendChild(panel);

  /** Tab order inside the dialog, as the user reaches it. */
  function focusables() {
    const items = [closeButton, largeText];
    if (keySetupButton && !keySetupButton.hidden) items.push(keySetupButton);
    if (quickStartButton) items.push(quickStartButton);
    return items;
  }

  function setExpanded(value) {
    toggleButton?.setAttribute?.('aria-expanded', value ? 'true' : 'false');
  }

  function open() {
    if (destroyed || isOpenNow) return;
    previouslyFocused = doc.activeElement || null;
    largeText.checked = readLargeTextPreference();
    if (keySetupButton) {
      keySetupButton.hidden = canOpenKeySetup ? !canOpenKeySetup() : false;
    }
    isOpenNow = true;
    panel.hidden = false;
    setExpanded(true);
    closeButton.focus?.();
  }

  function close() {
    if (destroyed || !isOpenNow) return;
    isOpenNow = false;
    panel.hidden = true;
    setExpanded(false);
    const target = previouslyFocused;
    previouslyFocused = null;
    if (target && typeof target.focus === 'function') target.focus();
  }

  function toggle() {
    if (isOpenNow) close();
    else open();
  }

  function onKeyDown(event) {
    if (destroyed || !isOpenNow) return;
    if (event.key === 'Escape') {
      event.stopPropagation?.();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusables();
    const index = items.indexOf(doc.activeElement);
    let next = null;
    if (index === -1)
      next = event.shiftKey ? items[items.length - 1] : items[0];
    else if (event.shiftKey && index === 0) next = items[items.length - 1];
    else if (!event.shiftKey && index === items.length - 1) next = items[0];
    if (!next) return;
    event.preventDefault?.();
    next.focus();
  }

  function onBackdropClick(event) {
    if (event.target === panel) close();
  }

  function onLargeTextChange() {
    applyTextSize(largeText.checked);
  }

  function onKeySetupClick() {
    close();
    openKeySetup?.();
  }

  function onQuickStartClick() {
    close();
    openQuickStart?.();
  }

  function onToggleClick() {
    toggle();
  }

  doc.addEventListener('keydown', onKeyDown);
  panel.addEventListener('click', onBackdropClick);
  closeButton.addEventListener('click', close);
  largeText.addEventListener('change', onLargeTextChange);
  keySetupButton?.addEventListener('click', onKeySetupClick);
  quickStartButton?.addEventListener('click', onQuickStartClick);
  toggleButton?.addEventListener?.('click', onToggleClick);
  setExpanded(false);
  if (toggleButton) toggleButton.setAttribute?.('aria-controls', HELP_PANEL_ID);

  return {
    open,
    close,
    toggle,
    isOpen: () => isOpenNow,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      isOpenNow = false;
      doc.removeEventListener('keydown', onKeyDown);
      panel.removeEventListener('click', onBackdropClick);
      closeButton.removeEventListener('click', close);
      largeText.removeEventListener('change', onLargeTextChange);
      keySetupButton?.removeEventListener('click', onKeySetupClick);
      quickStartButton?.removeEventListener('click', onQuickStartClick);
      toggleButton?.removeEventListener?.('click', onToggleClick);
      setExpanded(false);
      panel.remove();
    },
  };
}
