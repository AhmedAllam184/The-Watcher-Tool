import { resolvePickId } from '../../data/pickRegistry.js';
import {
  GPS_JAM_STYLE,
  cellId,
  cellOutlineDegrees,
  cellRectangle,
  drawnCells,
} from './geometry.js';

const OUTLINE_SUFFIX = ':outline';
const OUTLINE_WIDTH_PX = 1.5;

/**
 * Ground-clamped cell fills and outlines in one CustomDataSource. Cells are
 * entities (not primitives) so one remove tears the whole layer down, as the
 * FIRMS grid does. Only medium and high cells reach the scene.
 */
export function createGpsJamRendering({
  viewer,
  cesium,
  id = 'gps-interference',
}) {
  const dataSource = new cesium.CustomDataSource(id);
  dataSource.show = false;
  viewer.dataSources.add(dataSource);
  const cellsById = new Map();
  let destroyed = false;

  const requestRender = () => {
    if (!viewer.isDestroyed?.()) viewer.scene.requestRender();
  };

  /** Replace every drawn cell with the given cells (low cells are skipped). */
  function setCells(cells) {
    if (destroyed) return;
    dataSource.entities.removeAll();
    cellsById.clear();
    for (const cell of drawnCells(cells)) {
      const style = GPS_JAM_STYLE[cell.level];
      const entityId = cellId(cell);
      const rect = cellRectangle(cell);
      cellsById.set(entityId, cell);
      dataSource.entities.add({
        id: entityId,
        rectangle: {
          coordinates: cesium.Rectangle.fromDegrees(
            rect.west,
            rect.south,
            rect.east,
            rect.north,
          ),
          material: new cesium.ColorMaterialProperty(
            cesium.Color.fromCssColorString(style.fill),
          ),
          heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
        },
      });
      dataSource.entities.add({
        id: `${entityId}${OUTLINE_SUFFIX}`,
        polyline: {
          positions: cesium.Cartesian3.fromDegreesArray(
            cellOutlineDegrees(cell),
          ),
          width: OUTLINE_WIDTH_PX,
          clampToGround: true,
          material: new cesium.ColorMaterialProperty(
            cesium.Color.fromCssColorString(style.outline),
          ),
        },
      });
    }
    requestRender();
  }

  /** Cell record for a drawn cell id, or null. */
  function cellFor(cellKey) {
    return cellsById.get(cellKey) || null;
  }

  /** Drawn-cell id for a raw pick id (fill or outline entity), or null. */
  function keyForPickId(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    const base = raw.endsWith(OUTLINE_SUFFIX)
      ? raw.slice(0, -OUTLINE_SUFFIX.length)
      : raw;
    return cellsById.has(base) ? base : null;
  }

  /** Drawn-cell id for a scene pick, or null. */
  function pickCell(picked) {
    return keyForPickId(resolvePickId(picked));
  }

  function ownsPickId(pickedId) {
    return keyForPickId(String(pickedId)) !== null;
  }

  function setVisible(visible) {
    if (!destroyed) dataSource.show = visible === true;
    requestRender();
  }

  function clear() {
    if (destroyed) return;
    dataSource.entities.removeAll();
    cellsById.clear();
    requestRender();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    cellsById.clear();
    if (!viewer.isDestroyed?.()) viewer.dataSources.remove(dataSource, true);
    else dataSource.entities.removeAll();
  }

  return {
    setCells,
    cellFor,
    pickCell,
    ownsPickId,
    setVisible,
    clear,
    destroy,
    get count() {
      return cellsById.size;
    },
    get dataSource() {
      return dataSource;
    },
  };
}
