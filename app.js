'use strict';

(() => {
  const H = HorizonWorld;
  const $ = id => document.getElementById(id);
  const canvas = $('scene'), ctx = canvas.getContext('2d');
  const W = canvas.width, HEIGHT = canvas.height;
  const map = document.createElement('canvas'), mapCtx = map.getContext('2d');
  const RAD = Math.PI / 180;
  const blend = (a, b, t) => a.map((channel, i) => channel + (b[i] - channel) * t);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  let model, structure, point, mode = 'atlas', scale = 'planet', mesh, meshBounds, cacheKey;
  let angle = -0.54, pitch = 0.55, zoom = 1, projected = [], drag;

  function values(target, entries) {
    $(target).replaceChildren(...entries.flatMap(([label, value]) => {
      const term = document.createElement('dt'), description = document.createElement('dd');
      term.textContent = label;
      description.textContent = value;
      return [term, description];
    }));
  }

  function color(s) {
    if (s.ocean || s.waterDepthM > 0) {
      return blend([81, 134, 147], [23, 51, 73], clamp(s.waterDepthM / 4100, 0, 1));
    }
    const relativeM = s.elevationM - model.world.seaLevelM;
    const base = blend([139, 153, 105], [69, 112, 89], clamp(s.rainfallMm / 1100, 0, 1));
    const high = s.temperatureC < -5 ? [220, 223, 212] : [188, 160, 117];
    if (s.substrate === 'bedrock') return blend([128, 119, 101], high, clamp(relativeM / 4700, 0, 1));
    return blend(base, high, clamp((relativeM - 300) / 4400, 0, 1));
  }

  function css(rgb, shade = 1) {
    return 'rgb(' + rgb.map(c => Math.round(c * shade)).join(',') + ')';
  }

  function generateMap() {
    const key = model.world.config.worldId + '/' + scale;
    if (cacheKey === key) return;
    cacheKey = key;
    map.width = scale === 'planet' ? 360 : 240;
    map.height = scale === 'planet' ? 180 : 120;
    const image = mapCtx.createImageData(map.width, map.height);
    const samples = [];
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const u = (x + 0.5) / map.width, v = 1 - (y + 0.5) / map.height;
        samples.push(scale === 'planet' ?
          model.world.sample(u * 360 - 180, v * 180 - 90) :
          model.local.sample(...model.local.position(u, v)));
      }
    }
    samples.forEach((s, i) => {
      const x = i % map.width, y = Math.floor(i / map.width);
      const left = samples[i - Number(x > 0)].elevationM;
      const north = samples[i - (y > 0 ? map.width : 0)].elevationM;
      const strength = scale === 'planet' ? 0.00045 : 0.017;
      const shade = s.waterDepthM > 0 ? 1 :
        clamp(1 + (s.elevationM - north + (s.elevationM - left) * 0.45) * strength, 0.73, 1.22);
      const offset = i * 4;
      color(s).forEach((c, ch) => { image.data[offset + ch] = c * shade; });
      image.data[offset + 3] = 255;
    });
    mapCtx.putImageData(image, 0, 0);
  }

  function marker(x, y, fill, radius = 6) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI);
    ctx.fillStyle = fill;
    ctx.strokeStyle = '#172020';
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
  }

  function mapPoint(lon, lat) {
    const [u, v] = scale === 'planet' ? [(lon + 180) / 360, (lat + 90) / 180] :
      model.local.uv(lon, lat);
    return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? [u * W, (1 - v) * HEIGHT] : null;
  }

  function drawAtlas() {
    generateMap();
    ctx.drawImage(map, 0, 0, W, HEIGHT);
    if (scale === 'planet') {
      ctx.strokeStyle = '#e1e6d42c';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 1; x < 12; x++) {
        ctx.moveTo(x * W / 12, 0);
        ctx.lineTo(x * W / 12, HEIGHT);
      }
      for (let y = 1; y < 6; y++) {
        ctx.moveTo(0, y * HEIGHT / 6);
        ctx.lineTo(W, y * HEIGHT / 6);
      }
      ctx.stroke();
      const [x, y] = mapPoint(...model.local.position(0.5, 0.5));
      ctx.strokeStyle = '#efd792';
      ctx.lineWidth = 2;
      ctx.strokeRect(x - 7, y - 7, 14, 14);
    }
    if (structure) {
      const xy = mapPoint(structure.lon, structure.lat);
      if (xy) marker(...xy, '#eaac55', 5);
    }
    const xy = mapPoint(...point);
    if (xy) marker(...xy, '#fff9e1', 4);
  }

  function drawExplorer() {
    const gradient = ctx.createLinearGradient(0, 0, 0, HEIGHT);
    gradient.addColorStop(0, '#273a3c');
    gradient.addColorStop(1, '#121b1b');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, W, HEIGHT);
    const region = model.local.region, [, centerLat] = model.local.position(0.5, 0.5);
    const widthM = region.spanDeg * RAD * model.world.config.settings.radiusKm * 1000;
    const cosLat = Math.cos(centerLat * RAD);
    const span = Math.max(200, meshBounds.max - meshBounds.min);
    const scale = 500 * zoom, vertical = Math.min(0.19 / span, 30 / widthM);
    const sin = Math.sin(angle), cos = Math.cos(angle);
    const tilt = Math.sin(pitch), rise = Math.cos(pitch);
    function project(u, v, elevationM) {
      const x = (u - 0.5) * cosLat, y = v - 0.5;
      const across = x * cos - y * sin, along = x * sin + y * cos;
      const z = (elevationM - meshBounds.middle) * vertical;
      return {
        x: W / 2 + across * scale, y: HEIGHT / 2 - (along * tilt + z * rise) * scale,
        depth: along * rise - z * tilt
      };
    }
    const surface = s => s.waterLevelM ?? s.elevationM;
    const size = mesh.length - 1;
    const vertices = mesh.map((row, v) => row.map((s, u) => ({
      ...project(u / size, v / size, surface(s)), sample: s
    })));
    projected = vertices.flat();
    const faces = [];
    function face(points, fill, stroke = fill) {
      faces.push({ points, fill, stroke,
        depth: points.reduce((sum, p) => sum + p.depth, 0) / points.length });
    }
    function triangle(a, b, c) {
      const [s, t, r] = [a.sample, b.sample, c.sample];
      const shade = clamp(1 + (surface(b.sample) - surface(a.sample)) * 0.0025 -
        (surface(c.sample) - surface(a.sample)) * 0.0015, 0.72, 1.23);
      face([a, b, c], css(blend(blend(color(s), color(t), 0.5), color(r), 1 / 3), shade));
    }
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const a = vertices[y][x], b = vertices[y][x + 1];
        const c = vertices[y + 1][x], d = vertices[y + 1][x + 1];
        triangle(a, b, c);
        triangle(d, c, b);
      }
    }
    for (const object of model.habitat.placements) {
      const [u, v] = model.local.uv(object.lon, object.lat);
      const base = project(u, v, object.elevationM), plant = object.kind === 'plant';
      // Symbols make the placement records visible at a regional camera scale.
      const height = plant ? 5 : 3;
      face([{ ...base, x: base.x - 2 }, { ...base, x: base.x + 2 },
        { ...base, y: base.y - height }], plant ? '#284b3c' : '#a99a83');
    }
    if (structure) {
      const [u, v] = model.local.uv(structure.lon, structure.lat);
      const ground = model.local.sample(structure.lon, structure.lat).elevationM + structure.offsetM;
      const half = structure.sizeM / (2 * widthM);
      const footprint = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      const base = footprint.map(([x, y]) => project(u + x * half / cosLat, v + y * half, ground));
      const top = footprint.map(([x, y]) =>
        project(u + x * half / cosLat, v + y * half, ground + structure.sizeM));
      for (let i = 0; i < 4; i++) {
        const next = (i + 1) % 4;
        face([base[i], base[next], top[next], top[i]], i % 2 ? '#b9743e' : '#d29955', '#60462a');
      }
      face(top, '#f4d28d', '#60462a');
    }
    faces.sort((a, b) => b.depth - a.depth);
    ctx.lineJoin = 'round';
    ctx.lineWidth = 0.65;
    for (const { points, fill, stroke } of faces) {
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (const p of points.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.strokeStyle = stroke;
      ctx.fill();
      ctx.stroke();
    }
    const [u, v] = model.local.uv(...point);
    if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
      const p = project(u, v, surface(model.local.sample(...point)));
      marker(p.x, p.y, '#fff9e1', 4);
    }
  }

  function paint() {
    if (mode === 'atlas') drawAtlas();
    else drawExplorer();
  }

  function update() {
    const s = model.habitat.sample(...point);
    $('lon').value = s.lon;
    $('lat').value = s.lat;
    $('world-id').textContent = model.world.config.worldId;
    for (const [id, state] of [['atlas', mode === 'atlas'], ['explorer', mode === 'explorer'],
      ['planet', scale === 'planet'], ['pilot', scale === 'pilot']]) {
      $(id).setAttribute('aria-pressed', String(state));
    }
    $('explorer-controls').hidden = mode !== 'explorer';
    $('atlas-controls').hidden = mode !== 'atlas';
    const region = model.local.region;
    $('view-note').textContent = mode === 'explorer' ? 'Drag to orbit · Click terrain to probe' :
      scale === 'planet' ? 'Equirectangular map · Click to probe' : 'Refined relief · Click to probe';
    const [u, v] = model.local.uv(s.lon, s.lat);
    const inRegion = u >= 0 && u <= 1 && v >= 0 && v <= 1;
    values('sample', [
      ['Elevation', s.elevationM.toFixed(2) + ' m'],
      ['Water depth', s.waterDepthM.toFixed(2) + ' m'],
      ['Parent elevation', s.coarseElevationM.toFixed(2) + ' m'],
      ['Temperature', s.temperatureC.toFixed(1) + ' °C'],
      ['Precipitation', s.rainfallMm.toFixed(0) + ' mm/yr'],
      ['Basin', s.basin],
      ['Province', s.province],
      ['Habitat', s.habitat],
      ['Model spacing', inRegion ? (region.spanDeg / region.resolution).toFixed(3) + '° local' :
        model.world.resolutionDeg.toFixed(2) + '° global']
    ]);
    $('place').disabled = mode !== 'explorer' || !inRegion || s.ocean || s.waterDepthM > 0;
    $('export').disabled = !structure;
    $('structure').textContent = structure ?
      'Ground-anchored cube · ' + structure.lon.toFixed(4) + '°, ' + structure.lat.toFixed(4) + '°' :
      mode === 'explorer' ? 'Select a dry point to place a cube.' : 'Open Explorer to place a cube.';
    values('diagnostics', [
      ['Seed', model.world.config.seed],
      ['Recipe', model.world.config.settings.recipe],
      ['Pilot tile', region.id],
      ['Refinement amplitude', region.amplitudeM.toFixed(2) + ' m'],
      ['Sea datum', model.world.seaLevelM.toFixed(2) + ' m'],
      ['Ocean inventory error', model.world.diagnostics.seaVolumeErrorM.toExponential(2) + ' m'],
      ['Sediment balance', model.world.diagnostics.sedimentBalanceM.toExponential(2) + ' m'],
      ['Runoff balance', model.world.diagnostics.runoffBalanceMm.toExponential(2) + ' mm'],
      ['Rerouted cells after erosion', model.world.diagnostics.reroutedCells],
      ['Ponded links across rising bed', model.world.diagnostics.backwaterLinks],
      ['Ground-cover objects', model.habitat.placements.length]
    ]);
    paint();
  }

  function build() {
    const next = H.createWorld($('seed').value, JSON.parse($('settings').value));
    if (model?.world.config.worldId !== next.world.config.worldId) structure = null;
    model = next;
    mesh = model.local.mesh().map(row => row.map(s => model.habitat.sample(s.lon, s.lat)));
    const heights = mesh.flat().map(s => s.waterLevelM ?? s.elevationM);
    const min = Math.min(...heights), max = Math.max(...heights);
    meshBounds = { min, max, middle: (min + max) / 2 };
    point = model.local.position(0.5, 0.5);
    mode = 'atlas';
    scale = 'planet';
    angle = -0.54;
    pitch = 0.55;
    zoom = 1;
    update();
  }

  function action(callback) {
    try {
      $('status').textContent = '';
      callback();
    } catch (error) {
      $('status').textContent = error.message;
    }
  }

  function view(nextMode, nextScale = scale) {
    mode = nextMode;
    scale = nextScale;
    update();
  }

  function setZoom(factor) {
    zoom = clamp(zoom * factor, 0.55, 2.4);
    paint();
  }

  $('settings').value = JSON.stringify(H.defaults, null, 2);
  $('generate').addEventListener('submit', e => {
    e.preventDefault();
    action(build);
  });
  $('probe').addEventListener('submit', e => {
    e.preventDefault();
    action(() => {
      const s = model.local.sample($('lon').valueAsNumber, $('lat').valueAsNumber);
      point = [s.lon, s.lat];
      update();
    });
  });
  $('atlas').onclick = () => view('atlas');
  $('explorer').onclick = () => view('explorer');
  $('planet').onclick = () => view('atlas', 'planet');
  $('pilot').onclick = () => view('atlas', 'pilot');
  $('left').onclick = () => { angle -= 0.25; paint(); };
  $('right').onclick = () => { angle += 0.25; paint(); };
  $('closer').onclick = () => setZoom(1.23);
  $('farther').onclick = () => setZoom(1 / 1.23);
  canvas.addEventListener('wheel', e => {
    if (mode !== 'explorer') return;
    e.preventDefault();
    setZoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
  }, { passive: false });
  canvas.addEventListener('pointerdown', e => {
    if (!e.isPrimary || e.button !== 0) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', e => {
    if (drag?.id !== e.pointerId || mode !== 'explorer') return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: true };
    angle += dx * 0.012;
    pitch = clamp(pitch + dy * 0.008, 0.15, 1.5);
    paint();
  });
  canvas.addEventListener('pointercancel', () => { drag = null; });
  canvas.addEventListener('pointerup', e => {
    if (drag?.id !== e.pointerId) return;
    const moved = drag.moved;
    drag = null;
    if (moved) return;
    const rect = canvas.getBoundingClientRect();
    const u = (e.clientX - rect.left) / rect.width, v = 1 - (e.clientY - rect.top) / rect.height;
    if (u < 0 || u > 1 || v < 0 || v > 1) return;
    if (mode === 'atlas') {
      point = scale === 'planet' ? [u * 360 - 180, v * 180 - 90] : model.local.position(u, v);
    } else {
      let nearest, distance = 20 * 20;
      for (const p of projected) {
        const d = (p.x - u * W) ** 2 + (p.y - (1 - v) * HEIGHT) ** 2;
        if (d >= distance) continue;
        distance = d;
        nearest = p.sample;
      }
      if (!nearest) return;
      point = [nearest.lon, nearest.lat];
    }
    update();
  });

  $('place').onclick = () => action(() => {
    structure = H.place(model, ...point);
    update();
    $('status').textContent = 'Cube placed.';
  });
  $('export').onclick = () => action(() => {
    const blob = new Blob([H.exportOverlay(model, structure)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = model.world.config.worldId + '-overlay.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('status').textContent = 'Overlay exported.';
  });
  $('import').onclick = () => $('overlay-file').click();
  $('overlay-file').onchange = async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const target = model;
    try {
      const json = await file.text();
      if (target !== model) throw Error('The world changed while reading the overlay. Import it again.');
      structure = H.importOverlay(model, json);
      if (structure) point = [structure.lon, structure.lat];
      view('explorer');
      $('status').textContent = 'Overlay loaded.';
    } catch (error) {
      $('status').textContent = error.message;
    }
  };
  action(build);
})();
