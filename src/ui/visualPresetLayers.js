/**
 * QUICK LAYERS section of the VISUAL PRESETS tray: one chip per common overlay
 * (on/off state, purple dot when the layer needs a provider key), plus an
 * "All layers" chip that opens DATA LAYERS. Map source stays in the MAP SOURCE
 * chips above it. Chips write through the Data Layers manager's own enable
 * call, so they cannot drift from the panel.
 */
import { fetchKeySetupStatus, layerHealth } from './layerPanel.js';

const KEY_STATUS_REFRESH_MS = 30000;

/** Overlay chips: each id is a registered Data Layers layer. */
export const PRESET_LAYER_OVERLAYS = Object.freeze([
  { id: 'flights', label: 'Flights' },
  { id: 'ais-live-vessels', label: 'Ships' },
  { id: 'local-airports', label: 'Airports' },
  { id: 'traffic', label: 'Traffic' },
  { id: 'weather-radar', label: 'Weather radar' },
  { id: 'local-firms', label: 'Fires' },
  { id: 'gps-interference', label: 'GPS jam' },
  { id: 'conflict-events', label: 'Conflicts' },
]);

function inertHandle() {
  return { refresh() {}, destroy() {} };
}

/**
 * Fill the QUICK LAYERS chip row and keep its state current.
 * @param {object} options
 * @param {HTMLElement} options.root Empty chip row the section fills.
 * @param {HTMLElement|null} [options.allButton] "All layers" chip that opens DATA LAYERS.
 * @param {HTMLElement|null} [options.trayToggle] VISUAL PRESETS tab; opening it refreshes the chips.
 * @param {HTMLElement|null} [options.statusNode] Shows how many chips are on.
 * @param {() => object|null} options.readDataManager Data Layers manager, if attached yet.
 * @param {() => void} options.openDataPanel Opens the DATA LAYERS panel.
 * @param {(message: string) => void} [options.showToast] Notice for a failed toggle.
 * @param {() => Promise<object|null>} [options.loadKeyStatus] Key-setup status reader.
 * @param {Document} [options.documentRef]
 * @param {Window} [options.windowRef]
 * @returns {{ refresh: () => void, destroy: () => void }}
 */
export function createVisualPresetLayers({
  root,
  allButton = null,
  trayToggle = null,
  statusNode = null,
  readDataManager = () => null,
  openDataPanel = () => {},
  showToast = () => {},
  loadKeyStatus = fetchKeySetupStatus,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
}) {
  if (!root || !documentRef?.createElement || !windowRef) return inertHandle();

  let destroyed = false;
  let manager = null;
  let unsubscribeActivity = null;
  let keyStatus = null;
  let keyStatusRequestedAt = 0;
  const removers = [];

  const listen = (target, type, listener) => {
    if (!target) return;
    target.addEventListener(type, listener);
    removers.push(() => target.removeEventListener(type, listener));
  };

  // ── Markup ────────────────────────────────────────────────────────────
  root.replaceChildren();
  const chips = PRESET_LAYER_OVERLAYS.map((overlay) => {
    const button = documentRef.createElement('button');
    button.type = 'button';
    button.className = 'quick-layer-chip';
    button.dataset.layerId = overlay.id;
    button.setAttribute('aria-pressed', 'false');
    const label = documentRef.createElement('span');
    label.className = 'quick-layer-chip-label';
    label.textContent = overlay.label;
    const dot = documentRef.createElement('span');
    dot.className = 'quick-layer-dot';
    dot.setAttribute('aria-hidden', 'true');
    dot.hidden = true;
    button.append(label, dot);
    root.append(button);
    return { button, dot, overlay };
  });

  // ── Rendering ─────────────────────────────────────────────────────────
  function render() {
    if (destroyed) return;
    // The Data Layers manager may attach after this section starts.
    attachManager();
    const rows = manager?.getAll?.() || [];
    let on = 0;
    for (const { button, dot, overlay } of chips) {
      const row = rows.find((item) => item.id === overlay.id);
      if (!row) {
        button.setAttribute('aria-pressed', 'false');
        button.setAttribute('aria-disabled', 'true');
        button.title = `${overlay.label} is not available`;
        dot.hidden = true;
        continue;
      }
      const health = layerHealth(row, keyStatus);
      const busy =
        row.lifecycleState === 'enabling' || row.lifecycleState === 'disabling';
      const enabled = row.enabled === true;
      if (enabled) on += 1;
      button.setAttribute('aria-pressed', String(enabled));
      button.setAttribute('aria-busy', String(busy));
      button.setAttribute('aria-disabled', 'false');
      dot.hidden = health !== 'key';
      const state = enabled ? 'on' : 'off';
      button.title =
        health === 'key'
          ? `${overlay.label} · ${state} · needs a key`
          : `${overlay.label} · ${state}`;
    }
    if (statusNode) statusNode.textContent = `${on} on`;
  }

  // ── Data: Data Layers activity ────────────────────────────────────────
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
  async function toggleOverlay({ button, overlay }) {
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

  for (const chip of chips) {
    listen(chip.button, 'click', () => void toggleOverlay(chip));
  }
  listen(allButton, 'click', () => {
    openDataPanel();
  });
  listen(trayToggle, 'click', () => {
    void requestKeyStatus();
    render();
  });
  listen(windowRef, 'gev:map-stack-changed', render);

  // ── Start ─────────────────────────────────────────────────────────────
  attachManager();
  render();
  void requestKeyStatus();

  return {
    refresh() {
      if (destroyed) return;
      attachManager();
      render();
      void requestKeyStatus();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribeActivity?.();
      unsubscribeActivity = null;
      for (const remove of removers.splice(0)) remove();
      root.replaceChildren();
    },
  };
}
