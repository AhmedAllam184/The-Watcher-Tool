/**
 * @module selectionDetails
 * @description Plain-language details panel for the selected object. It follows
 * the shared selection events, refreshes while visible and never deselects.
 */
import { getContextStore } from '../data/contextStore.js';
import {
  buildSelectionDetails,
  satelliteNoradOf,
} from './selectionDetailsModel.js';
import { createAircraftPhotoLoader } from './aircraftPhoto.js';
import { createSatelliteInfoLoader } from '../sources/satelliteInfo.js';
import { createIdentifyLoader } from '../sources/identifyInfo.js';

const REFRESH_MS = 1000;
const KIND_LABELS = {
  flight: 'Flight',
  vessel: 'Vessel',
  fire: 'Fire',
  satellite: 'Satellite',
  other: 'Object',
};
/** Badge colour per kind; the satellite violet is not in the stylesheet's kind rules. */
const KIND_COLOURS = {
  satellite: '#a78bfa',
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
 * The photo box's view of a Wikipedia image: the caption says whose photo it is.
 * An aircraft type's image is not this airframe; a satellite's shows its programme.
 */
function articlePhoto(article, identity) {
  const isSatellite = identity.wikiKind === 'satellite';
  const caption = isSatellite
    ? `Illustration/photo of ${identity.programme || article.title} (Wikipedia)`
    : 'Photo of the type (Wikipedia) — not this exact aircraft';
  return {
    src: article.image,
    link: article.link,
    photographer: null,
    source: 'Wikipedia',
    kind: 'article',
    title: article.title,
    caption,
  };
}

/**
 * Create the selection details panel and attach it to `root`.
 * @param {object} [options]
 * @param {HTMLElement} [options.root=document.body] Element that receives the panel.
 * @param {(lat: number, lon: number) => void} [options.flyTo] Camera action for "Fly to".
 * @param {() => void} [options.onClose] Called when the operator closes the panel.
 * @param {(text: string) => Promise<void>} [options.copyText] Clipboard writer.
 * @param {() => object|null} [options.getSelected] Returns the store's selected record.
 * @param {() => number} [options.now] Clock for relative times.
 * @param {{load: (hex: string, options?: {type?: string|null}) => Promise<object|null>}} [options.photoLoader] Aircraft photo source.
 * @param {{load: (norad: string) => Promise<{satellite: object|null}>}} [options.satelliteInfoLoader] Satellite catalogue source.
 * @param {{load: (kind: string, query: string) => Promise<object|null>}} [options.identifyLoader] Wikipedia article source.
 * @returns {{show: Function, hide: Function, refresh: Function, destroy: Function}}
 */
export function createSelectionDetailsPanel({
  root = document.body,
  flyTo = null,
  onClose = null,
  copyText = writeClipboard,
  getSelected = readSelectedRecord,
  now = () => Date.now(),
  photoLoader = createAircraftPhotoLoader(),
  satelliteInfoLoader = createSatelliteInfoLoader(),
  identifyLoader = createIdentifyLoader(),
} = {}) {
  const doc = root.ownerDocument || document;
  const win = doc.defaultView || globalThis;
  let current = null;
  let notice = '';
  let details = null;
  let timer = null;
  let token = 0;
  let destroyed = false;
  // Airframe photo of the selected hex: null until its lookup settles.
  let photoHex = null;
  let photoToken = 0;
  let airframePhoto = null;
  let airframeLoaded = false;
  // Wikipedia article for the selected identity: its key, token and article.
  let identityKey = null;
  let identityToken = 0;
  let identityArticle = null;
  let identityLoaded = false;
  let currentIdentity = null;
  let currentTitle = '';
  // What the photo box shows now, so a one-second re-render never re-creates it.
  let shownPhotoKey = null;
  let shownImage = null;
  // Catalogue lookup for the selected satellite: { norad, status, satellite }.
  let satelliteState = null;
  let satelliteToken = 0;

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

  // "What is it?": the kind, checkable facts and the Wikipedia summary.
  const identityBox = doc.createElement('section');
  identityBox.className = 'selection-details__identity';
  identityBox.hidden = true;

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

  el.append(
    header,
    identityBox,
    photoBox,
    alertLine,
    noticeLine,
    list,
    actions,
    feedback,
  );
  root.appendChild(el);

  function hasCoordinates() {
    return (
      Number.isFinite(details?.latitude) && Number.isFinite(details?.longitude)
    );
  }

  function clearPhoto() {
    shownImage = null;
    shownPhotoKey = null;
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
    const isArticlePhoto = photo.kind === 'article';
    const isTypePhoto = photo.kind === 'type' || isArticlePhoto;
    image.setAttribute(
      'alt',
      isArticlePhoto
        ? photo.caption
        : isTypePhoto
          ? `Photo of a ${photo.title || 'similar aircraft'}, not this aircraft`
          : `Photo of ${subjectTitle || 'aircraft'}`,
    );
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
    if (isTypePhoto) {
      // An image from a Wikipedia article: say what it shows, and link the article.
      const label =
        photo.kind === 'article'
          ? photo.caption
          : `Type photo: ${photo.title || 'aircraft type'} (Wikipedia) — not this exact aircraft`;
      if (photo.link) {
        const anchor = doc.createElement('a');
        anchor.href = photo.link;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.textContent = label;
        credit.append(anchor);
      } else credit.textContent = label;
    } else {
      const parts = [
        photo.photographer ? `© ${photo.photographer}` : '',
        photo.source,
      ].filter(Boolean);
      credit.textContent = parts.join(' · ');
    }
    photoBox.append(media, credit);
    photoBox.hidden = false;
  }

  /**
   * The photo box shows the airframe's own photo when there is one, else the
   * Wikipedia image of the type or programme. Re-rendering with the same choice
   * changes nothing, so the image is not re-created every second.
   */
  function renderPhotoBlock() {
    if (photoHex && !airframeLoaded) {
      if (shownPhotoKey !== 'loading') {
        showPhotoStatus('Loading aircraft photo…');
        shownPhotoKey = 'loading';
      }
      return;
    }
    if (airframePhoto) {
      const key = `airframe|${airframePhoto.src}`;
      if (key !== shownPhotoKey) {
        shownPhotoKey = key;
        renderPhoto(airframePhoto, currentTitle);
      }
      return;
    }
    if (identityArticle?.image && currentIdentity) {
      const key = `article|${identityArticle.image}`;
      if (key !== shownPhotoKey) {
        shownPhotoKey = key;
        renderPhoto(
          articlePhoto(identityArticle, currentIdentity),
          currentTitle,
        );
      }
      return;
    }
    if (identityKey && !identityLoaded) {
      if (shownPhotoKey !== 'loading') {
        showPhotoStatus('Loading photo…');
        shownPhotoKey = 'loading';
      }
      return;
    }
    clearPhoto();
  }

  /** Load the selected aircraft's airframe photo when the hex changes; no-op otherwise. */
  function syncPhoto(hex) {
    if (hex === photoHex) return;
    photoHex = hex;
    photoToken += 1;
    const token = photoToken;
    airframePhoto = null;
    airframeLoaded = !hex;
    if (!hex) return;
    Promise.resolve()
      .then(() => photoLoader.load(hex))
      .then(
        (photo) => {
          if (destroyed || token !== photoToken) return;
          airframePhoto = photo || null;
          airframeLoaded = true;
          renderPhotoBlock();
        },
        () => {
          if (destroyed || token !== photoToken) return;
          airframePhoto = null;
          airframeLoaded = true;
          renderPhotoBlock();
        },
      );
  }

  /** Load the Wikipedia article when the identity's query changes; no-op otherwise. */
  function syncIdentity(identity) {
    const key = identity?.wikiQuery
      ? `${identity.wikiKind}|${identity.wikiQuery.toLowerCase()}`
      : null;
    if (key === identityKey) return;
    identityKey = key;
    identityToken += 1;
    const token = identityToken;
    identityArticle = null;
    identityLoaded = !key;
    if (!key) return;
    Promise.resolve()
      .then(() => identifyLoader.load(identity.wikiKind, identity.wikiQuery))
      .then(
        (article) => settle(token, article),
        () => settle(token, null),
      );
  }

  function settle(token, article) {
    if (destroyed || token !== identityToken) return;
    identityArticle = article;
    identityLoaded = true;
    renderIdentity();
    renderPhotoBlock();
  }

  /** The "What is it?" block: kind, facts, then the article summary and link. */
  function renderIdentity() {
    identityBox.textContent = '';
    const identity = currentIdentity;
    if (!identity) {
      identityBox.hidden = true;
      return;
    }
    const heading = doc.createElement('p');
    heading.className = 'selection-details__identity-heading';
    heading.textContent = 'What is it?';
    const kind = doc.createElement('strong');
    kind.className = 'selection-details__identity-kind';
    kind.textContent = identity.kindLabel;
    identityBox.append(heading, kind);
    if (identity.facts.length) {
      const chips = doc.createElement('ul');
      chips.className = 'selection-details__chips';
      for (const fact of identity.facts) {
        const chip = doc.createElement('li');
        chip.className = 'selection-details__chip';
        chip.textContent = fact;
        chips.append(chip);
      }
      identityBox.append(chips);
    }
    if (identityArticle) {
      const from = doc.createElement('p');
      from.className = 'selection-details__identity-source';
      from.textContent = `From the Wikipedia article “${identityArticle.title}”`;
      identityBox.append(from);
      if (identityArticle.summary) {
        const summary = doc.createElement('p');
        summary.className = 'selection-details__summary';
        summary.textContent = identityArticle.summary;
        identityBox.append(summary);
      }
      if (identityArticle.link) {
        const more = doc.createElement('a');
        more.className = 'selection-details__wiki';
        more.href = identityArticle.link;
        more.target = '_blank';
        more.rel = 'noopener noreferrer';
        more.textContent = 'Read more on Wikipedia';
        identityBox.append(more);
      }
    } else if (identityKey && !identityLoaded) {
      const status = doc.createElement('p');
      status.className = 'selection-details__photo-status';
      status.textContent = 'Looking up the article…';
      identityBox.append(status);
    }
    identityBox.hidden = false;
  }

  /**
   * Fetch the catalogue record when the selected satellite changes. The
   * panel re-renders when it lands; a superseded lookup is ignored.
   */
  function syncSatelliteInfo(norad) {
    if (norad === (satelliteState?.norad ?? null)) return;
    satelliteToken += 1;
    const token = satelliteToken;
    satelliteState = norad
      ? { norad, status: 'loading', satellite: null }
      : null;
    if (!norad) return;
    const settle = (next) => {
      if (destroyed || token !== satelliteToken) return;
      satelliteState = { norad, ...next };
      if (current && satelliteNoradOf(current.record) === norad) render();
    };
    Promise.resolve()
      .then(() => satelliteInfoLoader.load(norad))
      .then(
        ({ satellite }) => settle({ status: 'ok', satellite }),
        () => settle({ status: 'failed', satellite: null }),
      );
  }

  function render() {
    if (!current) return;
    syncSatelliteInfo(satelliteNoradOf(current.record));
    details = buildSelectionDetails(current.record, {
      now: now(),
      satelliteInfo: satelliteState,
    });
    if (!details) {
      hide();
      return;
    }
    el.className = `selection-details selection-details--${details.kind}`;
    el.style?.setProperty?.(
      '--selection-kind',
      KIND_COLOURS[details.kind] || '',
    );
    kindBadge.className = `selection-details__kind selection-details__kind--${details.kind}`;
    kindBadge.textContent = KIND_LABELS[details.kind] || KIND_LABELS.other;
    title.textContent = details.title;
    subtitle.textContent = details.subtitle;
    subtitle.hidden = !details.subtitle;
    currentTitle = details.title;
    currentIdentity = details.identity || null;
    syncPhoto(details.photoHex || null);
    syncIdentity(currentIdentity);
    renderIdentity();
    renderPhotoBlock();

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
    airframePhoto = null;
    airframeLoaded = false;
    identityKey = null;
    identityToken += 1;
    identityArticle = null;
    identityLoaded = false;
    currentIdentity = null;
    clearPhoto();
    renderIdentity();
    syncSatelliteInfo(null);
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

  closeButton.addEventListener('click', () => {
    hide();
    onClose?.();
  });
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
