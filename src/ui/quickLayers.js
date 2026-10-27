/**
 * Bottom-left map switcher, modelled on Google Maps' layers control: a square
 * thumbnail that toggles Map and Satellite in one click, and a row of tiles
 * (3D, live overlays, More) that opens on hover or tap. Map changes go through
 * the same select path as the MAP SOURCE chips, so share state and the
 * remembered choice stay correct. Overlay tiles use the Data Layers manager's
 * own enable call, so they cannot drift from the panel.
 */
import { fetchKeySetupStatus, layerHealth } from './layerPanel.js';

const PANEL_ID = 'quick-layers-panel';
const HOVER_CLOSE_MS = 180;
const KEY_STATUS_REFRESH_MS = 30000;
const ANCHOR_SELECTORS = Object.freeze([
  '#cesium-credits .cesium-credit-logoContainer',
  '#cesium-credits .cesium-credit-textContainer',
  '#intel-hud .hud-bottom-left',
  '#intel-hud .hud-bottom-bar',
  // On phones the TOOLS rail spans the full width above the credit line.
  '#right-context-rail',
]);
const ANCHOR_GAP_PX = 10;
const FALLBACK_BOTTOM_PX = 24;

/** Overlay tiles: each id is a registered Data Layers layer. */
export const QUICK_LAYER_OVERLAYS = Object.freeze([
  { id: 'flights', label: 'Flights', icon: 'flight' },
  { id: 'ais-live-vessels', label: 'Ships', icon: 'directions_boat' },
  { id: 'local-airports', label: 'Airports', icon: 'local_airport' },
  { id: 'traffic', label: 'Traffic', icon: 'traffic' },
  { id: 'weather-radar', label: 'Weather radar', icon: 'radar' },
  { id: 'local-firms', label: 'Fires', icon: 'local_fire_department' },
  { id: 'gps-interference', label: 'GPS jam', icon: 'gps_off' },
]);

/**
 * The stack one click on the thumbnail switches to: Satellite from the street
 * map, and the street map from anywhere else (Satellite, Google 3D, Bing).
 * @param {string|null} activeId Active map stack id.
 * @returns {'osm'|'esri-imagery'}
 */
export function quickLayerSwitchTarget(activeId) {
  return activeId === 'osm' ? 'esri-imagery' : 'osm';
}

function inertHandle() {
  return { refresh() {}, destroy() {} };
}

/**
 * Own the bottom-left switcher. Everything it reads or writes is passed in;
 * the shell keeps the map controller and the Data Layers manager.
 * @param {object} options
 * @param {HTMLElement} options.root Empty container the switcher fills.
 * @param {() => object|null} options.readDataManager Data Layers manager, if attached yet.
 * @param {object|null} options.mapStackController Map stack controller (getStacks, getActiveId).
 * @param {(stackId: string) => Promise<unknown>} options.selectMapStack Shared map-source select path.
 * @param {() => void} options.openDataPanel Opens the DATA LAYERS panel ("More").
 * @param {(message: string) => void} [options.showToast] Notice for a failed toggle.
 * @param {() => Promise<object|null>} [options.loadKeyStatus] Key-setup status reader.
 * @param {Document} [options.documentRef]
 * @param {Window} [options.windowRef]
 * @returns {{ refresh: () => void, destroy: () => void }}
 */
export function createQuickLayers({
  root,
  readDataManager = () => null,
  mapStackController = null,
  selectMapStack = () => Promise.resolve(null),
  openDataPanel = () => {},
  showToast = () => {},
  loadKeyStatus = fetchKeySetupStatus,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
}) {
  if (!root || !documentRef?.createElement || !windowRef) return inertHandle();

  let destroyed = false;
  let open = false;
  let manager = null;
  let unsubscribeActivity = null;
  let keyStatus = null;
  let keyStatusRequestedAt = 0;
  let closeTimer = null;
  let placeFrame = null;
  const removers = [];
  const observers = [];

  const listen = (target, type, listener, options) => {
    target.addEventListener(type, listener, options);
    removers.push(() => target.removeEventListener(type, listener, options));
  };
  const element = (tag, className, attributes = {}) => {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    for (const [name, value] of Object.entries(attributes))
      node.setAttribute(name, String(value));
    return node;
  };
  const glyph = (name) => {
    const node = element('span', 'material-symbols-outlined');
    node.setAttribute('aria-hidden', 'true');
    node.textContent = name;
    return node;
  };
  const setUnavailable = (button, unavailable, reason) => {
    button.setAttribute('aria-disabled', String(unavailable));
    button.classList.toggle('is-unavailable', unavailable);
    if (reason) button.title = reason;
  };

  // ── Markup ────────────────────────────────────────────────────────────
  root.replaceChildren();
  root.classList.add('quick-layers');
  const switchButton = element('button', 'ql-switch', { type: 'button' });
  const swatch = element('span', 'ql-swatch');
  swatch.setAttribute('aria-hidden', 'true');
  const switchLabel = element('span', 'ql-switch-label');
  switchButton.append(swatch, switchLabel);

  const expandButton = element('button', 'ql-expand', {
    type: 'button',
    'aria-expanded': 'false',
    'aria-controls': PANEL_ID,
    'aria-label': 'Map types and layers',
    title: 'Map types and layers',
  });
  expandButton.append(glyph('layers'));

  const panel = element('div', 'ql-panel', {
    id: PANEL_ID,
    role: 'group',
    'aria-label': 'Map types and layers',
    hidden: '',
  });
  const makeTile = (label, icon) => {
    const button = element('button', 'ql-tile', { type: 'button' });
    const face = element('span', 'ql-tile-face');
    const dot = element('span', 'ql-dot');
    dot.setAttribute('aria-hidden', 'true');
    dot.hidden = true;
    face.append(glyph(icon), dot);
    const text = element('span', 'ql-tile-label');
    text.textContent = label;
    button.append(face, text);
    return { button, dot };
  };
  const mapGroup = element('div', 'ql-group', {
    role: 'group',
    'aria-label': 'Map types',
  });
  const threeD = makeTile('3D', 'view_in_ar');
  mapGroup.append(threeD.button);
  const overlayGroup = element('div', 'ql-group', {
    role: 'group',
    'aria-label': 'Overlays',
  });
  const overlays = QUICK_LAYER_OVERLAYS.map((overlay) => {
    const tile = makeTile(overlay.label, overlay.icon);
    tile.button.dataset.layerId = overlay.id;
    overlayGroup.append(tile.button);
    return { ...tile, overlay };
  });
  const moreGroup = element('div', 'ql-group');
  const more = makeTile('More', 'more_horiz');
  moreGroup.append(more.button);
  const divider = () => {
    const node = element('span', 'ql-divider');
    node.setAttribute('aria-hidden', 'true');
    return node;
  };
  panel.append(mapGroup, divider(), overlayGroup, divider(), moreGroup);
  root.append(switchButton, expandButton, panel);

  // ── Rendering ─────────────────────────────────────────────────────────
  const stacksById = () =>
    new Map((mapStackController?.getStacks?.() || []).map((s) => [s.id, s]));

  function render() {
    if (destroyed) return;
    const activeId = mapStackController?.getActiveId?.() ?? null;
    const stacks = stacksById();

    const targetId = quickLayerSwitchTarget(activeId);
    const target = stacks.get(targetId);
    const targetLabel = targetId === 'esri-imagery' ? 'Satellite' : 'Map';
    swatch.className = `ql-swatch ql-swatch--${targetId === 'esri-imagery' ? 'satellite' : 'map'}`;
    switchLabel.textContent = targetLabel;
    switchButton.setAttribute('aria-label', `Show ${targetLabel} map`);
    setUnavailable(
      switchButton,
      target?.available === false,
      target?.available === false
        ? target.unavailableReason || `${targetLabel} map is unavailable`
        : `Show ${targetLabel} map`,
    );

    const photo = stacks.get('photoreal');
    threeD.button.hidden = !photo;
    if (photo) {
      threeD.button.setAttribute(
        'aria-pressed',
        String(activeId === 'photoreal'),
      );
      setUnavailable(
        threeD.button,
        photo.available === false,
        photo.available === false
          ? photo.unavailableReason || '3D map is unavailable'
          : '3D map',
      );
    }

    const rows = manager?.getAll?.() || [];
    for (const { button, dot, overlay } of overlays) {
      const row = rows.find((item) => item.id === overlay.id);
      if (!row) {
        button.setAttribute('aria-pressed', 'false');
        setUnavailable(button, true, `${overlay.label} is not available`);
        dot.hidden = true;
        continue;
      }
      const health = layerHealth(row, keyStatus);
      const busy =
        row.lifecycleState === 'enabling' || row.lifecycleState === 'disabling';
      button.setAttribute('aria-pressed', String(row.enabled === true));
      button.setAttribute('aria-busy', String(busy));
      setUnavailable(button, false);
      dot.hidden = health !== 'key';
      const state = row.enabled === true ? 'on' : 'off';
      button.title =
        health === 'key'
          ? `${overlay.label} · ${state} · needs a key`
          : `${overlay.label} · ${state}`;
    }

    expandButton.setAttribute('aria-expanded', String(open));
    root.classList.toggle('is-open', open);
  }

  // ── Data: map stack and Data Layers activity ─────────────────────────
  function attachManager() {
    const next = readDataManager?.() ?? null;
    if (!next || next === manager) return;
    unsubscribeActivity?.();
    manager = next;
    unsubscribeActivity =
      typeof next.subscribeActivity === 'function'
        ? next.subscribeActivity((change) => {
            if (
              change?.type === 'status' ||
              change?.type === 'visibility-settled'
            )
              render();
          })
        : null;
  }

  async function requestKeyStatus() {
    if (destroyed || Date.now() - keyStatusRequestedAt < KEY_STATUS_REFRESH_MS)
      return;
    keyStatusRequestedAt = Date.now();
    const status = await Promise.resolve()
      .then(() => loadKeyStatus?.())
      .catch(() => null);
    if (destroyed) return;
    keyStatus = status ?? null;
    render();
  }

  // ── Actions ───────────────────────────────────────────────────────────
  function switchMap() {
    if (switchButton.getAttribute('aria-disabled') === 'true') return;
    const targetId = quickLayerSwitchTarget(
      mapStackController?.getActiveId?.() ?? null,
    );
    Promise.resolve(selectMapStack(targetId)).catch(() => {});
  }

  function pickThreeD() {
    if (threeD.button.getAttribute('aria-disabled') === 'true') return;
    Promise.resolve(selectMapStack('photoreal')).catch(() => {});
  }

  async function toggleOverlay(tile) {
    const { button, overlay } = tile;
    attachManager();
    if (!manager?.layers?.has?.(overlay.id)) return;
    if (
      button.getAttribute('aria-disabled') === 'true' ||
      button.getAttribute('aria-busy') === 'true'
    )
      return;
    const enabled = manager.isEnabled(overlay.id) === true;
    button.setAttribute('aria-busy', 'true');
    try {
      await manager.setEnabled(overlay.id, !enabled, { origin: 'user' });
    } catch (error) {
      console.warn(`[Data] ${overlay.id} quick toggle error:`, error);
      showToast(
        `${overlay.label} could not be turned ${enabled ? 'off' : 'on'}`,
      );
    } finally {
      button.removeAttribute('aria-busy');
      render();
    }
  }

  function setOpen(next, { focusExpand = false } = {}) {
    if (destroyed) return;
    clearTimeout(closeTimer);
    closeTimer = null;
    if (next === open) return;
    open = next;
    panel.hidden = !next;
    if (!next && focusExpand) expandButton.focus();
    if (next) {
      attachManager();
      void requestKeyStatus();
    }
    render();
  }

  // ── Hover (mouse) and tap (touch/pen) ─────────────────────────────────
  listen(root, 'pointerenter', (event) => {
    if (event.pointerType !== 'mouse') return;
    clearTimeout(closeTimer);
    closeTimer = null;
    setOpen(true);
  });
  listen(root, 'pointerleave', (event) => {
    if (event.pointerType !== 'mouse') return;
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => setOpen(false), HOVER_CLOSE_MS);
  });
  listen(
    documentRef,
    'pointerdown',
    (event) => {
      if (open && !root.contains(event.target)) setOpen(false);
    },
    true,
  );
  listen(root, 'keydown', (event) => {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false, { focusExpand: true });
  });
  listen(switchButton, 'click', switchMap);
  listen(expandButton, 'click', () => setOpen(!open));
  listen(threeD.button, 'click', pickThreeD);
  for (const tile of overlays)
    listen(tile.button, 'click', () => void toggleOverlay(tile));
  listen(more.button, 'click', () => {
    setOpen(false);
    openDataPanel();
  });
  listen(windowRef, 'gev:map-stack-changed', render);

  // ── Placement: sit above the credit line and the HUD readouts ────────
  function place() {
    placeFrame = null;
    if (destroyed) return;
    const rootRect = root.getBoundingClientRect();
    if (rootRect.width <= 0) return;
    let anchorTop = Infinity;
    for (const selector of ANCHOR_SELECTORS) {
      for (const node of documentRef.querySelectorAll(selector)) {
        const style = windowRef.getComputedStyle(node);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          Number(style.opacity) === 0
        )
          continue;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (rect.right <= rootRect.left || rect.left >= rootRect.right)
          continue;
        if (rect.top < windowRef.innerHeight * 0.5) continue;
        anchorTop = Math.min(anchorTop, rect.top);
      }
    }
    const bottom = Number.isFinite(anchorTop)
      ? Math.max(0, windowRef.innerHeight - anchorTop + ANCHOR_GAP_PX)
      : FALLBACK_BOTTOM_PX;
    root.style.setProperty('--quick-layers-bottom', `${Math.round(bottom)}px`);
  }
  function schedulePlace() {
    if (destroyed || placeFrame !== null) return;
    placeFrame =
      typeof windowRef.requestAnimationFrame === 'function'
        ? windowRef.requestAnimationFrame(place)
        : setTimeout(place, 0);
  }
  listen(windowRef, 'resize', schedulePlace);
  if (typeof windowRef.ResizeObserver === 'function') {
    const observer = new windowRef.ResizeObserver(schedulePlace);
    for (const selector of ANCHOR_SELECTORS)
      for (const node of documentRef.querySelectorAll(selector))
        observer.observe(node);
    observers.push(observer);
  }

  // ── Start ─────────────────────────────────────────────────────────────
  attachManager();
  render();
  schedulePlace();

  return {
    refresh() {
      if (destroyed) return;
      attachManager();
      render();
      schedulePlace();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(closeTimer);
      if (placeFrame !== null) {
        if (typeof windowRef.cancelAnimationFrame === 'function')
          windowRef.cancelAnimationFrame(placeFrame);
        else clearTimeout(placeFrame);
        placeFrame = null;
      }
      for (const observer of observers.splice(0)) observer.disconnect();
      unsubscribeActivity?.();
      unsubscribeActivity = null;
      for (const remove of removers.splice(0)) remove();
      root.replaceChildren();
      root.classList.remove('quick-layers', 'is-open');
      root.style.removeProperty('--quick-layers-bottom');
    },
  };
}
