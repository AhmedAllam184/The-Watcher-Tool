import { renderMapStackChips, syncMapStackChips } from '../mapStackChips.js';
import { writeRememberedMapStack } from '../maps/mapStackMemory.js';

const LABELS_STORAGE_KEY = 'watcher.mapLabels';

/** @returns {boolean | null} The stored choice, or null when none was saved. */
function readStoredLabels() {
  try {
    const value = globalThis.localStorage?.getItem(LABELS_STORAGE_KEY);
    return value === '1' ? true : value === '0' ? false : null;
  } catch {
    return null;
  }
}

function writeStoredLabels(enabled) {
  try {
    globalThis.localStorage?.setItem(LABELS_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // Storage can be blocked; the toggle still works for this session.
  }
}

/**
 * Own Map Source presentation and selection without constructing map providers.
 * The supplied controller remains authoritative for availability and active state.
 */
export function createMapSourceControls({
  container,
  statusElement,
  labelsToggle = null,
  controller,
  subscribe,
  claimSelection = () => {},
  onStateChanged = () => {},
  onError = () => {},
}) {
  let destroyed = false;
  let generation = 0;
  const removers = [];
  const bind = (element, type, listener) => {
    element.addEventListener(type, listener);
    removers.push(() => element.removeEventListener(type, listener));
  };
  // Kept apart from `removers`: refresh() rebinds the chips and must not drop this.
  let removeLabelsListener = null;
  function render(state) {
    if (destroyed || !state) return;
    syncMapStackChips(container, state.activeId);
    if (labelsToggle) {
      labelsToggle.checked = state.labelsEnabled !== false;
      labelsToggle.disabled = state.labelsAvailable === false;
      labelsToggle.title = labelsToggle.disabled
        ? 'This map already has labels or is 3D'
        : '';
    }
    if (statusElement) {
      const stack = state.activeStack;
      statusElement.textContent =
        state.status === 'switching'
          ? '...'
          : stack?.shortLabel || stack?.label || 'MAP';
      statusElement.classList.toggle('warn', !!state.lastError);
    }
  }
  async function select(stackId, { syncShare = true } = {}) {
    if (destroyed) return null;
    const current = ++generation;
    if (syncShare) claimSelection();
    const before = controller.getActiveId();
    render(controller.getState('switching'));
    let state;
    try {
      state = await controller.setStack(stackId);
    } catch (error) {
      if (!destroyed && current === generation) {
        render(controller.getState());
        onError(error?.message || String(error));
      }
      throw error;
    }
    if (destroyed || current !== generation) return state;
    render(controller.getState());
    if (state?.activeId === before && stackId !== before && state?.lastError)
      onError(state.lastError);
    // Only a choice the visitor made (syncShare) is remembered; scenes and
    // share restores switch stacks without it and must not overwrite it.
    if (syncShare && state?.activeId === stackId)
      writeRememberedMapStack(stackId);
    if (syncShare) onStateChanged();
    return state;
  }
  function refresh() {
    if (destroyed) return;
    for (const remove of removers.splice(0)) remove();
    renderMapStackChips(container, controller.getStacks(), {
      activeId: controller.getActiveId(),
      onSelect: (id) => {
        void select(id).catch(() => {});
      },
      bind,
    });
    render(controller.getState());
  }
  const unsubscribe = subscribe(() => {
    if (destroyed) return;
    render(controller.getState());
    onStateChanged();
  });
  if (labelsToggle) {
    const stored = readStoredLabels();
    if (stored !== null && controller.getLabelsEnabled() !== stored)
      controller.setLabelsEnabled(stored);
    const onLabelsChange = () => {
      if (destroyed) return;
      writeStoredLabels(labelsToggle.checked);
      controller.setLabelsEnabled(labelsToggle.checked);
      render(controller.getState());
    };
    labelsToggle.addEventListener('change', onLabelsChange);
    removeLabelsListener = () =>
      labelsToggle.removeEventListener('change', onLabelsChange);
  }
  refresh();
  return {
    render,
    select,
    refresh,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation++;
      unsubscribe?.();
      removeLabelsListener?.();
      for (const remove of removers.splice(0)) remove();
    },
  };
}
