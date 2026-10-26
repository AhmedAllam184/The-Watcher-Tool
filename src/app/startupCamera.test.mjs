import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { flyToStartView, START_VIEW } from '../camera.js';

function fakeViewer() {
  const log = { views: [], flights: 0, cancelled: 0 };
  log.viewer = {
    isDestroyed: () => false,
    camera: {
      setView(view) {
        log.views.push(view);
      },
      flyTo() {
        log.flights++;
      },
      cancelFlight() {
        log.cancelled++;
      },
    },
  };
  return log;
}

test('the start view is Egypt, set at once, straight down, with no flight', () => {
  assert.equal(START_VIEW.name, 'Egypt');
  const log = fakeViewer();
  flyToStartView(log.viewer);
  assert.equal(log.views.length, 1);
  assert.equal(log.flights, 0, 'there is no cinematic dive to Egypt');

  const { destination, orientation } = log.views[0];
  const place = Cesium.Cartographic.fromCartesian(destination);
  assert.ok(Math.abs(Cesium.Math.toDegrees(place.latitude) - 26.8) < 1e-6);
  assert.ok(Math.abs(Cesium.Math.toDegrees(place.longitude) - 30.8) < 1e-6);
  assert.ok(Math.abs(place.height - 2200000) < 1);
  assert.equal(orientation.pitch, Cesium.Math.toRadians(-90), 'straight down');
  assert.equal(orientation.heading, 0, 'north up');
});

test('teardown after the start view is safe and never starts a flight', () => {
  const log = fakeViewer();
  const stop = flyToStartView(log.viewer);
  stop();
  assert.equal(log.flights, 0);
  assert.equal(log.cancelled, 1);
});
