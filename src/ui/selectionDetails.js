/**
 * @module selectionDetails
 * @description Plain-language details panel for the selected object. It follows
 * the shared selection events, refreshes while visible and never deselects.
 */
import { getContextStore } from '../data/contextStore.js';
import { buildSelectionDetails } from './selectionDetailsModel.js';
import { createAircraftPhotoLoader } from './aircraftPhoto.js';

const REFRESH_MS = 1000;
const KIND_LABELS = {
  flight: 'Flight',
  vessel: 'Vessel',
  fire: 'Fire',
  other: 'Object',
};

/** The record the shared store currently holds as selected, or null. */
function readSelectedRecord() {
  const store = getContextStore();
  if (!store.selectedEntityId) return null;
  return store.entities.get(store.selectedEntityId) || null;
}

/** Copy through the async clipboard API; reject when it is unavailable. */
function writeClipboard(text) {
  const clipboard = globalThis.navigator?.clipboard;
  if (!clipboard?.writeText)
    return Promise.reject(new Error('Clipboard unavailable'));
  return clipboard.writeText(text);
}

/**
 * Create the selection details panel and attach it to `root`.
 * @param {object} [options]
 * @param {HTMLElement} [options.root=document.body] Element that receives the panel.
 * @param {(lat: number, lon: number) => void} [options.flyTo] Camera action for "Fly to".
 * @param {(text: string) => Promise<void>} [options.copyText] Clipboard writer.
 * @param {() => object|null} [options.getSelected] Returns the store's selected record.
 * @param {() => number} [options.now] Clock for relative times.
 * @param {{load: (hex: string) => Promise<object|null>}} [options.photoLoader] Aircraft photo source.
 * @returns {{show: Function, hide: Function, refresh: Function, destroy: Function}}
 */
export function createSelectionDetailsPanel({
  root = document.body,
  flyTo = null,
  copyText = writeClipboard,
  getSelected = readSelectedRecord,
  now = () => Date.now(),
  photoLoader = createAircraftPhotoLoader(),
} = {}) {
  const doc = root.ownerDocument || document;
  const win = doc.defaultView || globalThis;
  let current = null;
  let notice = '';
  let details = null;
  let timer = null;
  let token = 0;
  let destroyed = false;
  let photoHex = null;
  let photoToken = 0;
  let shownImage = null;

  const el = doc.createElement('aside');
  el.id = 'selection-details';
  el.className = 'selection-details';
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', 'Selected object details');
  el.hidden = true;

  const header = doc.createElement('header');
  header.className = 'selection-details__header';
  const heading = doc.createElement('div');
  heading.className = 'selection-details__heading';
  const kindBadge = doc.createElement('span');
  kindBadge.className = 'selection-details__kind';
  const title = doc.createElement('h2');
  title.className = 'selection-details__title';
  const subtitle = doc.createElement('p');
  subtitle.className = 'selection-details__subtitle';
  heading.append(kindBadge, title, subtitle);
  const closeButton = doc.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'selection-details__close';
  closeButton.setAttribute('aria-label', 'Close details');
  closeButton.textContent = '×';
  header.append(heading, closeButton);

  // Aircraft photo under the header. Set only when the selected hex changes:
  // the panel re-renders every second and the photo must not flicker.
  const photoBox = doc.createElement('figure');
  photoBox.className = 'selection-details__photo';
  photoBox.hidden = true;

  const alertLine = doc.createElement('p');
  alertLine.className = 'selection-details__alert';
  alertLine.setAttribute('role', 'alert');
  alertLine.hidden = true;

  const noticeLine = doc.createElement('p');
  noticeLine.className = 'selection-details__notice';
  noticeLine.hidden = true;

  const list = doc.createElement('dl');
  list.className = 'selection-details__rows';

  const actions = doc.createElement('div');
  actions.className = 'selection-details__actions';
  const flyButton = doc.createElement('button');
  flyButton.type = 'button';
  flyButton.className = 'selection-details__action';
  flyButton.textContent = 'Fly to';
  const copyButton = doc.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'selection-details__action';
  copyButton.textContent = 'Copy coordinates';
  const linkRow = doc.createElement('div');
  linkRow.className = 'selection-details__links';
  actions.append(flyButton, copyButton, linkRow);

  const feedback = doc.createElement('p');
  feedback.className = 'selection-details__feedback';
  feedback.setAttribute('role', 'status');

  el.append(header, photoBox, alertLine, noticeLine, list, actions, feedback);
  root.appendChild(el);

  function hasCoordinates() {
    return (
      Number.isFinite(details?.latitude) && Number.isFinite(details?.longitude)
    );
  }

  function clearPhoto() {
    shownImage = null;
    photoBox.textContent = '';
    photoBox.hidden = true;
  }

  function showPhotoStatus(text) {
    photoBox.textContent = '';
    const status = doc.createElement('p');
    status.className = 'selection-details__photo-status';
    status.textContent = text;
    photoBox.append(status);
    photoBox.hidden = false;
  }

  function renderPhoto(photo, subjectTitle) {
    photoBox.textContent = '';
    const image = doc.createElement('img');
    image.className = 'selection-details__photo-image';
    image.setAttribute('src', photo.src);
    image.setAttribute('alt', `Photo of ${subjectTitle || 'aircraft'}`);
    image.setAttribute('loading', 'lazy');
    image.setAttribute('referrerpolicy', 'no-referrer');
    // A photo that fails to load is no photo: drop the block, keep the panel.
    shownImage = image;
    image.addEventListener('error', () => {
      if (shownImage === image) clearPhoto();
    });
    let media = image;
    if (photo.link) {
      const anchor = doc.createElement('a');
      anchor.className = 'selection-details__photo-link';
      anchor.href = photo.link;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.append(image);
      media = anchor;
    }
    const credit = doc.createElement('figcaption');
    credit.className = 'selection-details__photo-credit';
    const parts = [
      photo.photographer ? `© ${photo.photographer}` : '',
      photo.source,
    ].filter(Boolean);
    credit.textContent = parts.join(' · ');
    photoBox.append(media, credit);
    photoBox.hidden = false;
  }

  /** Load the photo when the selected aircraft changes; no-op otherwise. */
  function syncPhoto(hex, subjectTitle) {
    if (hex === photoHex) return;
    photoHex = hex;
    photoToken += 1;
    const token = photoToken;
    clearPhoto();
    if (!hex) return;
    showPhotoStatus('Loading aircraft photo…');
    Promise.resolve()
      .then(() => photoLoader.load(hex))
      .then(
        (photo) => {
          if (destroyed || token !== photoToken) return;
          if (photo) renderPhoto(photo, subjectTitle);
          else clearPhoto();
        },
        () => {
          if (token === photoToken) clearPhoto();
        },
      );
  }

  function render() {
    if (!current) return;
    details = buildSelectionDetails(current.record, { now: now() });
    if (!details) {
      hide();
      return;
    }
    el.className = `selection-details selection-details--${details.kind}`;
    kindBadge.className = `selection-details__kind selection-details__kind--${details.kind}`;
    kindBadge.textContent = KIND_LABELS[details.kind] || KIND_LABELS.other;
    title.textContent = details.title;
    subtitle.textContent = details.subtitle;
    subtitle.hidden = !details.subtitle;
    syncPhoto(details.photoHex || null, details.title);

    // Set only on change: the panel re-renders every second and a repeated
    // role=alert text would be announced again.
    const alertText = details.alert || '';
    if (alertLine.textContent !== alertText) alertLine.textContent = alertText;
    alertLine.hidden = !alertText;
    const alertClass =
      details.alertTone === 'warn'
        ? 'selection-details__alert selection-details__alert--warn'
        : 'selection-details__alert';
    if (alertLine.className !== alertClass) alertLine.className = alertClass;

    noticeLine.textContent = notice;
    noticeLine.hidden = !notice;

    list.textContent = '';
    for (const row of details.rows) {
      const term = doc.createElement('dt');
      term.textContent = row.label;
      const value = doc.createElement('dd');
      value.textContent = row.value;
      list.append(term, value);
    }

    flyButton.disabled = !flyTo || !hasCoordinates();
    copyButton.disabled = !hasCoordinates();

    linkRow.textContent = '';
    for (const link of details.links) {
      const anchor = doc.createElement('a');
      anchor.className = 'selection-details__link';
      anchor.href = link.href;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.textContent = link.label;
      linkRow.appendChild(anchor);
    }
  }

  // A live refresh only runs while the panel is shown AND the tab is visible:
  // a background tab has nothing to repaint and should not poll the store.
  function syncTimer() {
    const wantsTimer =
      Boolean(current?.live) && !el.hidden && !destroyed && !doc.hidden;
    if (wantsTimer && timer === null) {
      timer = win.setInterval(refresh, REFRESH_MS);
    } else if (!wantsTimer && timer !== null) {
      win.clearInterval(timer);
      timer = null;
    }
  }

  function setCurrent(next) {
    token += 1;
    current = next;
    notice = '';
    feedback.textContent = '';
    el.hidden = false;
    render();
    syncTimer();
  }

  function hide() {
    token += 1;
    current = null;
    details = null;
    photoHex = null;
    photoToken += 1;
    clearPhoto();
    el.hidden = true;
    feedback.textContent = '';
    syncTimer();
  }

  /** Show the record, or a minimal stand-in when the store has none. */
  function show(record) {
    if (destroyed || !record) return;
    setCurrent({
      id: String(record.id),
      layerId: record.layerId,
      record,
      live: true,
    });
  }

  /** Re-read the selected record; keep the last values when it is gone. */
  function refresh() {
    if (destroyed || !current?.live) return;
    const latest = getSelected();
    if (latest && String(latest.id) === current.id) {
      current.record = latest;
    } else {
      current.live = false;
      notice = 'No longer updating';
    }
    render();
    syncTimer();
  }

  function markEvicted() {
    if (!current) return;
    current.live = false;
    notice = 'No longer updating';
    render();
    syncTimer();
  }

  function onEntitySelected(event) {
    show(event.detail);
  }

  function onEntitySelectionCleared(event) {
    const detail = event.detail || {};
    if (!current || detail.layerId !== current.layerId) return;
    if (detail.reason === 'evicted') markEvicted();
    else hide();
  }

  function onAwarenessSelected(event) {
    const detail = event.detail || {};
    const id = String(detail.id ?? '');
    const expected = (token += 1);
    // The subject record is registered right after this event is dispatched.
    const resolve = () => {
      if (destroyed || expected !== token) return;
      const record = getSelected();
      if (record && String(record.id) === id) {
        show(record);
        return;
      }
      setCurrent({
        id,
        layerId: detail.layerId,
        record: {
          id,
          layerId: detail.layerId,
          label: detail.label,
          properties: {},
        },
        live: false,
      });
    };
    if (typeof win.requestAnimationFrame === 'function')
      win.requestAnimationFrame(resolve);
    else queueMicrotask(resolve);
  }

  function onAwarenessCleared(event) {
    const detail = event.detail || {};
    if (current && detail.layerId === current.layerId) hide();
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    hide();
  }

  function setFeedback(message) {
    feedback.textContent = message;
  }

  const listeners = [
    ['gev:entity-selected', onEntitySelected],
    ['gev:entity-selection-cleared', onEntitySelectionCleared],
    ['gev:awareness-subject-selected', onAwarenessSelected],
    ['gev:awareness-subject-cleared', onAwarenessCleared],
  ];
  for (const [type, handler] of listeners) win.addEventListener(type, handler);
  // Returning to a visible tab restarts the timer and refreshes at once, so the
  // panel is not stale for up to a second after the tab comes back.
  const onVisibilityChange = () => {
    syncTimer();
    if (!doc.hidden) refresh();
  };
  doc.addEventListener?.('visibilitychange', onVisibilityChange);

  closeButton.addEventListener('click', hide);
  el.addEventListener('keydown', onKeyDown);
  flyButton.addEventListener('click', () => {
    if (!flyButton.disabled) flyTo?.(details.latitude, details.longitude);
  });
  copyButton.addEventListener('click', () => {
    if (!hasCoordinates()) return;
    const text = `${details.latitude.toFixed(4)}, ${details.longitude.toFixed(4)}`;
    new Promise((resolve) => resolve(copyText(text))).then(
      () => setFeedback('Coordinates copied'),
      () => setFeedback('Copy failed'),
    );
  });

  return {
    show,
    hide,
    refresh,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const [type, handler] of listeners)
        win.removeEventListener(type, handler);
      doc.removeEventListener?.('visibilitychange', onVisibilityChange);
      if (timer !== null) win.clearInterval(timer);
      timer = null;
      current = null;
      el.remove();
    },
  };
}
