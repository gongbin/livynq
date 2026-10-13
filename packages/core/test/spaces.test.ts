import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoAdapter, Home, pointInPolygon, polygonArea } from '@livynq/core';

test('geometry helpers', () => {
  const square: [number, number][] = [[0, 0], [4, 0], [4, 3], [0, 3]];
  assert.equal(polygonArea(square), 12);
  assert.equal(pointInPolygon(1, 1, square), true);
  assert.equal(pointInPolygon(5, 1, square), false);
});

test('levels, room outlines, placement (with automatic room), adjacency, scene docs', async () => {
  const home = new Home({ dataDir: ':memory:' });
  home.useAdapter(new DemoAdapter({ simulateSensors: false }));
  await home.start();
  const ground = home.spaces.createLevel({ name: 'Ground floor' });
  const upstairs = home.spaces.createLevel({ name: 'Upstairs' });
  assert.equal(upstairs.elevation, 3);
  const kitchen = home.registry.findRoom('Kitchen')!;
  const living = home.registry.findRoom('Living Room')!;
  home.registry.updateRoom(kitchen.id, { levelId: ground.id, polygon: [[0, 0], [4, 0], [4, 3], [0, 3]] });
  home.registry.updateRoom(living.id, { levelId: ground.id, polygon: [[4, 0], [10, 0], [10, 5], [4, 5]] });
  assert.throws(() => home.registry.updateRoom(living.id, { polygon: [[0, 0], [1, 1]] }), /polygon/);
  assert.deepEqual(home.spaces.adjacency(), { [kitchen.id]: [living.id], [living.id]: [kitchen.id] });

  // Dropping the lamp inside the living room outline moves it to that room.
  assert.equal(home.registry.requireDevice('demo:bedroom-lamp').roomId === living.id, false);
  const r = home.spaces.place('demo:bedroom-lamp', { levelId: ground.id, x: 6, y: 2, mount: 'floor' });
  assert.equal(r.roomId, living.id);
  assert.equal(home.registry.requireDevice('demo:bedroom-lamp').roomId, living.id);
  assert.equal(home.spaces.floorPlan().placements.length, 1);

  assert.throws(() => home.spaces.place('demo:bedroom-lamp', { levelId: 'nope', x: 0, y: 0 }), /Level not found/);

  const scene = { nodes: { wall1: { type: 'wall' } } };
  home.spaces.putScene(ground.id, scene);
  assert.deepEqual(home.spaces.getScene(ground.id)?.data, scene);

  home.spaces.deleteLevel(ground.id);
  assert.equal(home.registry.getRoom(kitchen.id)?.levelId, null);
  assert.equal(home.registry.requireDevice('demo:bedroom-lamp').placement, null);
  assert.equal(home.spaces.getScene(upstairs.id), null);
  await home.stop();
});
