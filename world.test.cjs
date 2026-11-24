const assert = require('node:assert/strict');
const { test } = require('node:test');
const H = require('./world.js');

const model = H.createWorld('Horizon');
const { world, local, habitat } = model;

test('1. Configuration canonicalizes seeds and settings and rejects invalid input', () => {
  const a = H.defineWorld(' Café ', { radiusKm: 100, rotationHours: 30 });
  const b = H.defineWorld('Cafe\u0301', { rotationHours: 30, radiusKm: 100 });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.notEqual(a.worldId, H.defineWorld(b.seed, { ...b.settings, radiusKm: 101 }).worldId);
  assert.deepEqual(a.streams, H.defineWorld(b.seed, { radiusKm: 101 }).streams);
  assert.equal(new Set(Object.values(a.streams)).size, 4);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.settings) && Object.isFrozen(a.streams));
  assert.throws(() => H.defineWorld(' ', {}), /seed/);
  assert.throws(() => H.defineWorld('a', { radiusKm: 1 }), /radiusKm/);
  assert.throws(() => H.defineWorld('a', { recipe: 'unknown' }), /recipe/);
});

test('2. Geology is deterministic, covers the sphere, and has multiple boundary regimes', () => {
  const states = world.scaffold.context;
  assert.equal(states.length, 96 * 48);
  const repeat = H.geology(world.config);
  const sample = world.geology.sample(13, 23);
  assert.deepEqual(sample, repeat.sample(13, 23));
  assert.ok(new Set(states.map(s => s.province)).size >= 10);
  assert.deepEqual(new Set(states.map(s => s.boundary)),
    new Set(['interior', 'convergent', 'divergent', 'transform']));
  assert.ok(states.every(s => s.resistance >= 0.25 && s.resistance <= 0.9 &&
    Number.isFinite(s.bearingRad) && Math.abs(s.uplift) <= 1));
});

test('3. Scaffold includes crust and uplift contributions with bounded seeded residual', () => {
  world.scaffold.elevation.forEach((height, i) => {
    const g = world.scaffold.context[i];
    assert.ok(Math.abs(height - (-3800 + 5100 * g.continentalFraction + 2600 * g.uplift)) <= 360);
  });
  assert.ok(world.cells.some(c => c.ocean));
  assert.ok(world.cells.some(c => !c.ocean));
  assert.ok(Math.abs(world.scaffold.sea.errorM) < 1e-8);
});

test('4. Environmental pass conserves budgets and every receiver chain reaches the ocean', () => {
  const { cells, diagnostics } = world;
  assert.ok(Math.abs(diagnostics.sedimentBalanceM) < 1e-10);
  assert.ok(Math.abs(diagnostics.seaVolumeErrorM) < 1e-8);
  assert.ok(Math.abs(diagnostics.runoffBalanceMm) < 1e-9);
  assert.ok(cells.some(c => c.sedimentM > 0));
  let ponded = 0;
  for (const cell of cells) {
    let cursor = cell, steps = 0;
    while (cursor.receiver >= 0) {
      const next = cells[cursor.receiver];
      assert.ok(cursor.waterSurfaceM >= next.waterSurfaceM);
      assert.ok(++steps < cells.length, 'Receiver cycle');
      cursor = next;
    }
    assert.equal(cursor.id, cell.outlet);
    assert.ok(cursor.ocean);
    if (cell.receiver >= 0 && cell.elevationM < cells[cell.receiver].elevationM) {
      assert.ok(cell.waterSurfaceM > cell.elevationM);
      ponded++;
    }
    for (const divider of cell.divideNeighbors) {
      assert.notEqual(cell.outlet, cells[divider].outlet);
      assert.ok(cells[divider].divideNeighbors.includes(cell.id));
    }
  }
  assert.equal(ponded, diagnostics.backwaterLinks);
});

test('5. Authoritative records regenerate and geographic coordinates wrap', () => {
  const repeat = H.createWorld('Horizon').world;
  assert.deepEqual(world.cells, repeat.cells);
  assert.ok(Object.isFrozen(world) && Object.isFrozen(world.cells) &&
    Object.isFrozen(world.cells[0]) && Object.isFrozen(world.cells[0].divideNeighbors));
  assert.deepEqual(world.sample(180, 1), world.sample(-180, 1));
  assert.deepEqual(world.sample(90, 90), world.sample(-120, 90));
  assert.deepEqual(world.sample(15, -90), world.sample(75, -90));
  assert.throws(() => world.sample(0, 91), /latitude/);
});

test('6. Refinement adds bounded relief and preserves edges, basin and inherited water', () => {
  let greatest = 0;
  for (let j = 0; j <= 40; j++) {
    for (let i = 0; i <= 40; i++) {
      const point = local.position(i / 40, j / 40);
      const parent = world.sample(...point), refined = local.sample(...point);
      const delta = Math.abs(refined.elevationM - parent.elevationM);
      if (i === 0 || i === 40 || j === 0 || j === 40) assert.equal(delta, 0);
      assert.equal(refined.basin, local.region.basin);
      assert.equal(refined.receiver, parent.receiver);
      assert.equal(refined.waterDepthM, parent.waterDepthM);
      assert.ok(delta <= local.region.amplitudeM);
      greatest = Math.max(greatest, delta);
    }
  }
  assert.ok(greatest > 1);
  assert.deepEqual(local.mesh(4)[1][2], local.mesh(40)[10][20]);
  assert.deepEqual(local.mesh(8), H.createWorld('Horizon').local.mesh(8));
});

test('7. Ground cover is repeatable, habitat-dependent, dry and anchored', () => {
  assert.ok(habitat.placements.length > 0);
  assert.deepEqual(habitat.placements, H.createWorld('Horizon').habitat.placements);
  assert.equal(new Set(habitat.placements.map(p => p.id)).size, habitat.placements.length);
  for (const object of habitat.placements) {
    const s = habitat.sample(object.lon, object.lat);
    assert.equal(object.elevationM, s.elevationM);
    assert.equal(s.waterDepthM, 0);
    assert.ok(s.slope <= 0.28);
    if (object.kind === 'plant') assert.ok(s.cover >= 0.15);
  }
});

test('8. Atlas probe and Explorer vertices share the same geographic sample', () => {
  const vertex = local.mesh()[19][17];
  const probe = habitat.sample(vertex.lon, vertex.lat);
  assert.equal(probe.elevationM, vertex.elevationM);
  assert.equal(probe.waterDepthM, vertex.waterDepthM);
  assert.equal(probe.basin, vertex.basin);
});

test('9. Structure round-trip preserves exact identity and anchor across regenerated models', () => {
  const structure = H.place(model, ...local.position(0.421, 0.619));
  const saved = H.exportOverlay(model, structure);
  const regenerated = H.createWorld(' Horizon ');
  const loaded = H.importOverlay(regenerated, saved);
  assert.deepEqual(loaded, structure);
  assert.equal(H.exportOverlay(regenerated, loaded), saved);
  assert.equal(local.sample(structure.lon, structure.lat).elevationM,
    regenerated.local.sample(loaded.lon, loaded.lat).elevationM);
  assert.throws(() => H.importOverlay(model, saved.replace('horizon-v0.1', 'horizon-v2')), /recipe/);
  assert.throws(() => H.importOverlay(H.createWorld('Blue'), saved), /different world/);
  assert.throws(() => H.place(model, ...local.position(0.5, 1.1)), /dry point/);
});
