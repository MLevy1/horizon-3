'use strict';

const HorizonWorld = (() => {
  const COLS = 96, ROWS = 48, COUNT = COLS * ROWS, STEP = 360 / COLS;
  const RAD = Math.PI / 180, RECIPE = 'horizon-v0.1', SCHEMA = 1;
  const defaults = Object.freeze({
    radiusKm: 6371, rotationHours: 24, waterEquivalentM: 1200,
    referenceTemperatureC: 28, epochScale: 1, recipe: RECIPE
  });
  const ranges = {
    radiusKm: [64, 25000], rotationHours: [2, 200], waterEquivalentM: [300, 2000],
    referenceTemperatureC: [-30, 60], epochScale: [0.2, 2]
  };
  const wrap = lon => lon >= -180 && lon < 180 ? (lon || 0) :
    ((lon % 360 + 540) % 360) - 180;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const mix = (a, b, t) => a + (b - a) * t;
  const smooth = t => t * t * (3 - 2 * t);
  const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
  const sub = (a, b) => a.map((v, i) => v - b[i]);
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]
  ];
  const direction = (lon, lat) => {
    const c = Math.cos(lat * RAD);
    return [c * Math.cos(lon * RAD), c * Math.sin(lon * RAD), Math.sin(lat * RAD)];
  };
  const grid = (x, y) => y * COLS + (x + COLS) % COLS;
  const lonAt = x => -180 + (x + 0.5) * STEP;
  const latAt = y => -90 + (y + 0.5) * STEP;
  const coordinate = i => [lonAt(i % COLS), latAt(Math.floor(i / COLS))];
  const areas = Array.from({ length: COUNT }, (_, i) => {
    const low = (-90 + Math.floor(i / COLS) * STEP) * RAD;
    return (Math.sin(low + STEP * RAD) - Math.sin(low)) / (2 * COLS);
  });
  const neighbors = Array.from({ length: COUNT }, (_, i) => {
    const x = i % COLS, y = Math.floor(i / COLS);
    return [grid(x - 1, y), grid(x + 1, y), ...(y ? [i - COLS] : []),
      ...(y < ROWS - 1 ? [i + COLS] : [])];
  });

  function hash(value) {
    // FNV-1a/64 over UTF-8. This is a reproducible identifier, not a security hash.
    let result = 14695981039346656037n;
    for (const byte of new TextEncoder().encode(value)) {
      result = BigInt.asUintN(64, (result ^ BigInt(byte)) * 1099511628211n);
    }
    return result.toString(16).padStart(16, '0');
  }

  function unit(stream, address) {
    return Number.parseInt(hash(JSON.stringify([stream, address])).slice(0, 13), 16) / 2 ** 52;
  }

  function defineWorld(seed, options = {}) {
    if (typeof seed !== 'string' || !seed.trim()) throw Error('Enter a nonempty string seed.');
    if (!options || Object.getPrototypeOf(options) !== Object.prototype) {
      throw Error('Planet settings must be a JSON object.');
    }
    for (const key of Object.keys(options)) {
      if (!Object.hasOwn(defaults, key)) throw Error('Unknown planet setting: ' + key);
    }
    const settings = { ...defaults, ...options };
    for (const [key, [min, max]] of Object.entries(ranges)) {
      if (!Number.isFinite(settings[key]) || settings[key] < min || settings[key] > max) {
        throw Error(key + ' must be between ' + min + ' and ' + max + '.');
      }
    }
    if (settings.recipe !== RECIPE) throw Error('Unsupported generator recipe: ' + settings.recipe);
    seed = seed.trim().normalize('NFC');
    const streams = Object.freeze(Object.fromEntries(['plates', 'relief', 'refinement', 'habitat']
      .map(name => [name, hash(JSON.stringify([seed, RECIPE, name]))])));
    return Object.freeze({
      schema: SCHEMA, worldId: 'hz-' + hash(JSON.stringify([seed, settings])), seed,
      settings: Object.freeze(settings), streams,
      coordinates: 'Spherical east longitude [-180,180), north latitude [-90,90], elevation meters'
    });
  }

  function randomDirection(stream, address) {
    return direction(360 * unit(stream, [address, 'lon']),
      Math.asin(2 * unit(stream, [address, 'z']) - 1) / RAD);
  }

  function geology(config) {
    const plates = Array.from({ length: 14 }, (_, i) => ({
      id: 'plate-' + i,
      center: randomDirection(config.streams.plates, [i, 'center']),
      spin: randomDirection(config.streams.plates, [i, 'spin'])
        .map(v => v * (0.35 + 0.65 * unit(config.streams.plates, [i, 'speed']))),
      continental: i < 6,
      resistance: 0.25 + 0.65 * unit(config.streams.plates, [i, 'resistance'])
    }));
    function sample(lon, lat) {
      const p = direction(lon, lat);
      const ranked = plates.map(plate => ({ plate, score: dot(p, plate.center) }))
        .sort((a, b) => b.score - a.score);
      const first = ranked[0], second = ranked[1];
      const normal = sub(second.plate.center, first.plate.center);
      const relative = sub(cross(first.plate.spin, p), cross(second.plate.spin, p));
      const closing = dot(relative, normal) / Math.hypot(...normal);
      const gap = first.score - second.score;
      // Blend nearby interactions so a change of nearest or runner-up plate does not jump uplift.
      let uplift = 0, crust = 0, resistance = 0, total = 0;
      for (const a of ranked) {
        const weight = Math.exp((a.score - first.score) / 0.045);
        crust += weight * Number(a.plate.continental);
        resistance += weight * a.plate.resistance;
        total += weight;
      }
      for (let i = 0; i < ranked.length; i++) {
        const a = ranked[i];
        if (first.score - a.score > 0.24) break;
        for (let j = i + 1; j < ranked.length; j++) {
          const b = ranked[j], distance = 2 * first.score - a.score - b.score;
          if (distance > 0.24) break;
          const axis = sub(b.plate.center, a.plate.center);
          const velocity = cross(sub(a.plate.spin, b.plate.spin), p);
          uplift += (1 - distance / 0.24) ** 3 * dot(velocity, axis) / Math.hypot(...axis);
        }
      }
      const tangent = cross(p, normal);
      const east = [-Math.sin(lon * RAD), Math.cos(lon * RAD), 0];
      const north = cross(p, east);
      return {
        province: first.plate.id, crust: first.plate.continental ? 'continental' : 'oceanic',
        boundary: gap > 0.075 ? 'interior' : closing > 0.13 ? 'convergent' :
          closing < -0.13 ? 'divergent' : 'transform',
        bearingRad: ((Math.atan2(dot(tangent, east), dot(tangent, north)) % Math.PI) +
          Math.PI) % Math.PI,
        uplift: clamp(uplift, -1, 1) * config.settings.epochScale,
        continentalFraction: crust / total, resistance: resistance / total
      };
    }
    return Object.freeze({ sample });
  }

  function seaDatum(elevation, inventory) {
    const volume = level => elevation.reduce((sum, h, i) =>
      sum + areas[i] * Math.max(0, level - h), 0);
    let low = Math.min(...elevation), high = Math.max(...elevation) + inventory;
    for (let i = 0; i < 48; i++) {
      const mid = (high + low) / 2;
      if (volume(mid) < inventory) low = mid;
      else high = mid;
    }
    const levelM = (low + high) / 2;
    return { levelM, errorM: volume(levelM) - inventory };
  }

  function scaffold(config, geologicalState) {
    const axes = Array.from({ length: 3 }, (_, i) => ({
      axis: randomDirection(config.streams.relief, i),
      phase: 2 * Math.PI * unit(config.streams.relief, [i, 'phase'])
    }));
    const context = Array.from({ length: COUNT }, (_, i) =>
      Object.freeze(geologicalState.sample(...coordinate(i))));
    const elevation = context.map((g, i) => {
      const p = direction(...coordinate(i));
      const rolling = axes.reduce((sum, { axis, phase }) =>
        sum + 120 * Math.sin(5 * dot(p, axis) + phase), 0);
      return -3800 + 5100 * g.continentalFraction + 2600 * g.uplift + rolling;
    });
    return Object.freeze({
      context: Object.freeze(context), elevation: Object.freeze(elevation),
      sea: Object.freeze(seaDatum(elevation, config.settings.waterEquivalentM))
    });
  }

  function drainage(elevation, sea, rainfall) {
    const level = Array(COUNT).fill(Infinity), receiver = Array(COUNT).fill(-1);
    const outlet = Array(COUNT).fill(-1), order = [], queue = [];
    const less = (a, b) => level[a] < level[b] || (level[a] === level[b] && a < b);
    function push(i) {
      let pos = queue.length;
      queue.push(i);
      while (pos && less(i, queue[(pos - 1) >> 1])) {
        queue[pos] = queue[(pos - 1) >> 1];
        pos = (pos - 1) >> 1;
      }
      queue[pos] = i;
    }
    function pop() {
      const top = queue[0], end = queue.pop();
      if (!queue.length) return top;
      let pos = 0;
      while (2 * pos + 1 < queue.length) {
        let child = 2 * pos + 1;
        if (child + 1 < queue.length && less(queue[child + 1], queue[child])) child++;
        if (!less(queue[child], end)) break;
        queue[pos] = queue[child];
        pos = child;
      }
      queue[pos] = end;
      return top;
    }
    for (let i = 0; i < COUNT; i++) {
      if (elevation[i] > sea) continue;
      level[i] = sea;
      outlet[i] = i;
      push(i);
    }
    while (queue.length) {
      const from = pop();
      order.push(from);
      for (const to of neighbors[from]) {
        if (level[to] !== Infinity) continue;
        level[to] = Math.max(elevation[to], level[from]);
        receiver[to] = from;
        outlet[to] = outlet[from];
        push(to);
      }
    }
    if (order.length !== COUNT) throw Error('Drainage did not reach every cell.');
    const flow = rainfall.map((rain, i) => rain * areas[i]);
    for (let rank = order.length - 1; rank >= 0; rank--) {
      const i = order[rank], to = receiver[i];
      if (to >= 0) flow[to] += flow[i];
    }
    return { level, receiver, outlet, order, flow };
  }

  function environment(config, terrain) {
    const inventory = config.settings.waterEquivalentM;
    function climate(elevation, sea) {
      return elevation.map((h, i) => {
        const [, lat] = coordinate(i);
        const polar = Math.abs(lat) * RAD;
        const height = Math.max(0, h - sea);
        const temperatureC = config.settings.referenceTemperatureC -
          46 * Math.sin(polar) ** 2 - 0.0058 * height;
        const belt = Math.cos(3 * polar * (24 / config.settings.rotationHours) ** 0.15) ** 2;
        const waterNeighbors = neighbors[i].filter(n => elevation[n] <= sea).length;
        return { temperatureC, rainfallMm: 140 + 940 * belt * Math.cos(polar) +
          95 * waterNeighbors + Math.min(height * 0.12, 320) };
      });
    }
    const initialClimate = climate(terrain.elevation, terrain.sea.levelM);
    const initialFlow = drainage(terrain.elevation, terrain.sea.levelM,
      initialClimate.map(c => c.rainfallMm));
    const sediment = Array(COUNT).fill(0), erosion = Array(COUNT).fill(0);
    for (let i = 0; i < COUNT; i++) {
      const to = initialFlow.receiver[i];
      if (to < 0) continue;
      const gradeM = terrain.elevation[i] - initialFlow.level[to];
      if (gradeM <= 0) continue;
      const cut = Math.min(22, gradeM * 0.12,
        14 * Math.sqrt(initialFlow.flow[i]) * (1 - terrain.context[i].resistance));
      erosion[i] = cut;
      sediment[to] += cut * areas[i] / areas[to];
    }
    const elevation = terrain.elevation.map((h, i) => h - erosion[i] + sediment[i]);
    const sea = seaDatum(elevation, inventory);
    const weather = climate(elevation, sea.levelM);
    const hydro = drainage(elevation, sea.levelM, weather.map(c => c.rainfallMm));
    const diagnostics = {
      seaVolumeErrorM: sea.errorM,
      sedimentBalanceM: sediment.reduce((sum, h, i) => sum + areas[i] * (h - erosion[i]), 0),
      runoffBalanceMm: weather.reduce((sum, c, i) => sum + c.rainfallMm * areas[i] -
        (hydro.receiver[i] < 0 ? hydro.flow[i] : 0), 0),
      reroutedCells: hydro.receiver.filter((to, i) => to !== initialFlow.receiver[i]).length,
      backwaterLinks: hydro.receiver.filter((to, i) => to >= 0 && elevation[i] < elevation[to]).length
    };
    const cells = elevation.map((elevationM, i) => Object.freeze({
      id: i, elevationM, ...weather[i], ...terrain.context[i],
      receiver: hydro.receiver[i], outlet: hydro.outlet[i],
      divideNeighbors: Object.freeze(neighbors[i].filter(n => hydro.outlet[n] !== hydro.outlet[i] &&
        elevation[n] > sea.levelM && elevationM > sea.levelM)),
      waterSurfaceM: hydro.level[i], ocean: elevationM <= sea.levelM,
      flow: hydro.flow[i], sedimentM: sediment[i]
    }));
    return Object.freeze({
      cells: Object.freeze(cells), seaLevelM: sea.levelM, diagnostics: Object.freeze(diagnostics)
    });
  }

  function normalize(lon, lat) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90) {
      throw Error('Longitude must be finite and latitude must be between -90 and 90.');
    }
    return [Math.abs(lat) === 90 ? 0 : wrap(lon), lat === 0 ? 0 : lat];
  }

  function freezeWorld(config, geologyState, terrain, environmentState) {
    const { cells, seaLevelM, diagnostics } = environmentState;
    const polar = [0, ROWS - 1].map(y => {
      const ring = cells.slice(y * COLS, (y + 1) * COLS);
      return Object.fromEntries(['elevationM', 'temperatureC', 'rainfallMm', 'sedimentM',
        'resistance'].map(key => [key, ring.reduce((sum, cell) => sum + cell[key], 0) / COLS]));
    });
    function frame(lon, lat) {
      const gx = (lon + 180) / STEP - 0.5, gy = (lat + 90) / STEP - 0.5;
      const x = Math.floor(gx), y = clamp(Math.floor(gy), 0, ROWS - 2);
      return { x, y, u: gx - x, v: clamp(gy - y, 0, 1), gy };
    }
    function sample(lon, lat) {
      [lon, lat] = normalize(lon, lat);
      const { x, y, u, v, gy } = frame(lon, lat);
      const ring = [grid(x, y), grid(x + 1, y), grid(x, y + 1), grid(x + 1, y + 1)]
        .map(i => cells[i]);
      function interpolate(key) {
        const [a, b, c, d] = ring.map(cell => key === 'fillM' ?
          Math.max(0, cell.waterSurfaceM - Math.max(seaLevelM, cell.elevationM)) : cell[key]);
        const value = mix(mix(a, b, u), mix(c, d, u), v);
        if (gy < 0) return mix(value, key === 'fillM' ? 0 : polar[0][key], -2 * gy);
        if (gy > ROWS - 1) return mix(value, key === 'fillM' ? 0 : polar[1][key], 2 * (gy - ROWS + 1));
        return value;
      }
      const nearest = Math.abs(lat) === 90 ? ring[0] : ring[(v >= 0.5 ? 2 : 0) + (u >= 0.5 ? 1 : 0)];
      const elevationM = interpolate('elevationM');
      const ocean = elevationM <= seaLevelM;
      const waterDepthM = ocean ? seaLevelM - elevationM : interpolate('fillM');
      return {
        lon, lat, elevationM, waterDepthM, waterLevelM: ocean ? seaLevelM :
          waterDepthM > 0 ? elevationM + waterDepthM : null,
        ocean, temperatureC: interpolate('temperatureC'), rainfallMm: interpolate('rainfallMm'),
        sedimentM: interpolate('sedimentM'), resistance: interpolate('resistance'),
        province: nearest.province, crust: nearest.crust, basin: 'basin-' + nearest.outlet,
        cellId: nearest.id, receiver: nearest.receiver, outlet: nearest.outlet,
        boundary: nearest.boundary, divideNeighbors: nearest.divideNeighbors, runoffMm: nearest.flow
      };
    }
    return Object.freeze({
      config, schema: SCHEMA, geology: geologyState, scaffold: terrain, cells, seaLevelM,
      diagnostics, resolutionDeg: STEP, sample
    });
  }

  function refine(world) {
    const { cells, seaLevelM, config } = world;
    function corners(x, y) {
      return [grid(x, y), grid(x + 1, y), grid(x, y + 1), grid(x + 1, y + 1)]
        .map(id => cells[id]);
    }
    const monotoneGrade = pair => pair[0] * pair[1] > 0 ? Math.min(...pair.map(Math.abs)) : 0;
    let selected, best = Infinity;
    for (let y = 8; y < ROWS - 10; y++) {
      for (let x = 0; x < COLS; x++) {
        const tile = corners(x, y);
        if (tile.some(c => c.waterSurfaceM > c.elevationM || c.elevationM < seaLevelM + 90) ||
            tile.some(c => c.outlet !== tile[0].outlet)) continue;
        const low = Math.min(...tile.map(c => c.elevationM));
        const high = Math.max(...tile.map(c => c.elevationM));
        const [a, b, c, d] = tile.map(cell => cell.elevationM);
        const grade = Math.max(monotoneGrade([b - a, d - c]), monotoneGrade([c - a, d - b]));
        if (grade < 25) continue;
        const score = Math.abs(high - low - 850) + Math.abs(latAt(y)) * 1.5;
        if (score >= best) continue;
        best = score;
        selected = { x, y, tile, low, high, grade };
      }
    }
    if (!selected) throw Error('This world has no dry inland pilot tile with a shared outlet.');
    const { x, y, tile, low, high, grade } = selected;
    const id = 'pilot-' + x + '-' + y;
    const west = lonAt(x), south = latAt(y);
    const maxResidualM = Math.min(95, (low - seaLevelM) * 0.3, (high - low) * 0.14) *
      (0.45 + 0.55 * tile.reduce((sum, c) => sum + c.resistance, 0) / 4);
    const phase = Math.PI * 2 * unit(config.streams.refinement, [id, 'phase']);
    const bearing = world.geology.sample(wrap(west + STEP / 2), south + STEP / 2).bearingRad;
    // Limit the perturbation derivative along the dominant parent slope. This
    // keeps a downhill direction through the interior and leaves parent links untouched.
    const amplitudeM = Math.min(maxResidualM, 0.8 * grade / (Math.PI + 5 * Math.PI));
    const region = Object.freeze({
      id, west, south, spanDeg: STEP, amplitudeM, resolution: 40, basin: 'basin-' + tile[0].outlet
    });
    const position = (u, v) => [wrap(west + u * STEP), south + v * STEP];
    const uv = (lon, lat) => [wrap(lon - west) / STEP, (lat - south) / STEP];
    function elevation(lon, lat, parent) {
      const [u, v] = uv(lon, lat);
      if (u <= 0 || u >= 1 || v <= 0 || v >= 1) return parent;
      const envelope = Math.sin(Math.PI * u) ** 2 * Math.sin(Math.PI * v) ** 2;
      const across = u * Math.cos(bearing) - v * Math.sin(bearing);
      return parent + amplitudeM * envelope * Math.sin(5 * Math.PI * across + phase);
    }
    function sample(lon, lat) {
      const coarse = world.sample(lon, lat);
      const elevationM = elevation(coarse.lon, coarse.lat, coarse.elevationM);
      return { ...coarse, elevationM, coarseElevationM: coarse.elevationM,
        temperatureC: coarse.temperatureC - 0.0058 * (elevationM - coarse.elevationM) };
    }
    function mesh(divisions = region.resolution) {
      return Array.from({ length: divisions + 1 }, (_, row) =>
        Array.from({ length: divisions + 1 }, (_, col) => sample(...position(col / divisions, row / divisions))));
    }
    return Object.freeze({ region, sample, position, uv, mesh });
  }

  function habitat(world, local) {
    function sample(lon, lat) {
      const s = local.sample(lon, lat);
      const delta = 0.004;
      const height = (x, y) => local.sample(x, clamp(y, -90, 90)).elevationM;
      const north = (height(s.lon, s.lat + delta) - height(s.lon, s.lat - delta)) /
        (2 * delta * RAD * world.config.settings.radiusKm * 1000);
      const east = (height(s.lon + delta, s.lat) - height(s.lon - delta, s.lat)) /
        (2 * delta * RAD * world.config.settings.radiusKm * 1000 *
          Math.max(0.01, Math.cos(s.lat * RAD)));
      const slope = Math.hypot(east, north);
      const coastMoisture = world.cells[s.cellId].ocean ? 0.2 :
        0.1 * neighbors[s.cellId].filter(i => world.cells[i].ocean).length;
      const moisture = clamp(s.rainfallMm / 1400 + s.sedimentM / 180 + coastMoisture, 0, 1);
      const cover = smooth(clamp((moisture - 0.22) / 0.42, 0, 1)) *
        smooth(clamp((s.temperatureC + 3) / 14, 0, 1)) *
        smooth(clamp((0.28 - slope) / 0.22, 0, 1));
      const habitatClass = s.waterDepthM > 0 || s.ocean ? 'water' : s.temperatureC < -3 ? 'alpine' :
        slope > 0.15 || (s.resistance > 0.67 && s.sedimentM < 1) ? 'rock' :
        cover > 0.55 ? 'woodland' : 'grassland';
      return { ...s, slope, moisture, cover, habitat: habitatClass,
        substrate: habitatClass === 'water' ? 'submerged' : habitatClass === 'rock' ? 'bedrock' :
          s.sedimentM > 2 ? 'sediment' : 'soil' };
    }
    const placements = [];
    const stream = world.config.streams.habitat;
    for (let y = 0; y < 18; y++) {
      for (let x = 0; x < 18; x++) {
        const id = local.region.id + '/cover/' + x + '/' + y;
        const u = (x + unit(stream, [id, 'east'])) / 18;
        const v = (y + unit(stream, [id, 'north'])) / 18;
        const s = sample(...local.position(u, v));
        if (s.habitat === 'water' || s.slope > 0.28) continue;
        const rocky = s.habitat === 'rock' || s.habitat === 'alpine' || s.cover < 0.15;
        const density = rocky ? 0.18 + 0.1 * s.resistance : 0.68 * s.cover;
        if (unit(stream, [id, 'density']) >= density) continue;
        placements.push(Object.freeze({
          id, kind: rocky ? 'boulder' : 'plant',
          lon: s.lon, lat: s.lat, elevationM: s.elevationM
        }));
      }
    }
    return Object.freeze({ sample, placements: Object.freeze(placements) });
  }

  function createWorld(seed, options) {
    const config = defineWorld(seed, options);
    const geologicalState = geology(config);
    const terrain = scaffold(config, geologicalState);
    const world = freezeWorld(config, geologicalState, terrain, environment(config, terrain));
    const local = refine(world);
    return Object.freeze({ world, local, habitat: habitat(world, local) });
  }

  function validateStructure(model, object) {
    if (!object || object.kind !== 'cube' || object.altitudeRule !== 'ground-relative' ||
        object.offsetM !== 0 || object.sizeM !== 1000) throw Error('Invalid cube record.');
    const { lon, lat } = object;
    const [u, v] = model.local.uv(...normalize(lon, lat));
    const s = model.local.sample(lon, lat);
    if (u < 0 || u > 1 || v < 0 || v > 1 || s.ocean || s.waterDepthM > 0) {
      throw Error('Choose a dry point inside the pilot region.');
    }
    const id = 'cube-' + hash(JSON.stringify([model.world.config.worldId, s.lon, s.lat]));
    if (id !== object.id) throw Error('Cube ID does not match its anchor.');
    return Object.freeze({ id, kind: 'cube', lon: s.lon, lat: s.lat,
      altitudeRule: 'ground-relative', offsetM: 0, sizeM: 1000 });
  }

  function place(model, lon, lat) {
    [lon, lat] = normalize(lon, lat);
    return validateStructure(model, {
      id: 'cube-' + hash(JSON.stringify([model.world.config.worldId, lon, lat])),
      kind: 'cube', lon, lat, altitudeRule: 'ground-relative', offsetM: 0, sizeM: 1000
    });
  }

  function exportOverlay(model, structure) {
    const { worldId, settings } = model.world.config;
    return JSON.stringify({ schema: SCHEMA, worldId, recipe: settings.recipe,
      structures: structure ? [validateStructure(model, structure)] : [] }, null, 2);
  }

  function importOverlay(model, json) {
    const data = JSON.parse(json);
    if (!data || data.schema !== SCHEMA) throw Error('Unsupported overlay schema.');
    if (data.recipe !== model.world.config.settings.recipe) throw Error('Overlay generator recipe is incompatible.');
    if (data.worldId !== model.world.config.worldId) throw Error('Overlay belongs to a different world.');
    if (!Array.isArray(data.structures) || data.structures.length > 1) throw Error('Expected up to one cube.');
    return data.structures.length ? validateStructure(model, data.structures[0]) : null;
  }

  return Object.freeze({ defaults, defineWorld, geology, scaffold, environment, freezeWorld,
    refine, habitat, createWorld, place, exportOverlay, importOverlay, wrap });
})();

if (typeof module !== 'undefined') module.exports = HorizonWorld;
