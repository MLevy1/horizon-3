# Horizon roadmap prototype v0

Open [index.html](index.html) in a browser. The prototype runs from a local folder or a static host with no install, server, or network requests.

1. Enter a seed and select **Generate**. Planet settings accepts a JSON object with optional overrides.
2. In **Atlas**, click the planet or enter longitude and latitude to inspect a point. Select **Pilot region** to see the refined watershed patch.
3. Switch to **Explorer**. Drag or use the arrow buttons to orbit. Use the zoom buttons or scroll to change distance. Click the terrain to pick a mesh vertex. The geographic probe also accepts exact coordinates.
4. Choose a dry point in the pilot region and select **Place cube at probe**. Export the overlay, reload the page, regenerate the same seed and settings if needed, and import the file. The cube and probe return to the saved anchor.

Use **Roadmap outline** in the sandbox header to open the outline editor. The editor supports importing outline JSON and saves edits locally in your browser.

## Model contracts

The model lives in [world.js](world.js). The browser and Node tests use the same implementation. Terrain, ecological records, and overlay anchors use longitude east in `[-180, 180)`, latitude north in `[-90, 90]`, and elevation in meters against the generator's common vertical datum. The sea datum is solved from the water setting. Grid cells are 3.75° apart in a 96 × 48 cell-center raster. Longitude wraps, continuous queries interpolate toward a shared value at each pole, and categorical queries use a deterministic cell. Grid and plate addresses are meaningful within a world ID and recipe.

| Stage | Inputs and outputs | Prototype algorithm |
| --- | --- | --- |
| 1. Definition | `defineWorld(seed, settings)` → immutable config, ID and streams | Trim and NFC-normalize the seed. Validate an ordered settings record and hash it with the seed. The config includes the recipe and an independent schema version. |
| 2. Geology | `geology(config)` → global geology query | Fourteen spherical Voronoi provinces with fixed spin vectors. Relative projected velocity classifies boundaries. Blended nearby plate interactions supply uplift, crust fraction and resistance. |
| 3. Scaffold | `scaffold(config, geology)` → cell geology, elevation and initial sea datum | Crust fraction and uplift drive height. Three broad waves add at most 360 m of residual relief. An area-weighted solve matches the specified ocean-equivalent depth. |
| 4. Environment | `environment(config, scaffold)` → revised cells, climate, flow, sediment and balance diagnostics | Temperature uses latitude and elevation. Rain uses latitude, rotation, nearby ocean and elevation. Priority flood routes area-weighted runoff through four-neighbor links to ocean outlets. One erosion pass cuts at most 22 m per source and deposits the same volume at the receiver. Sea datum, climate and routing are solved again. |
| 5. World state | `freezeWorld(config, geology, scaffold, environment)` → immutable cells and coarse `sample(lon, lat)` | The frozen grid is the authority for outlet IDs, receivers, divide neighbors and environmental fields. Each land basin is identified by its ocean outlet cell. The seed and settings regenerate the state. |
| 6. Refinement | `refine(world)` → stable region address, coordinate transform, authoritative local sample and mesh | Choose one dry parent quad with a shared basin and monotone grade. A geology-oriented residual goes to zero at all edges and anchors. Its derivative is bounded below the parent grade along one axis, so it preserves a downhill direction. The coarse receivers and water are inherited. The local query delegates to the coarse state outside the pilot. |
| 7. Habitat | `habitat(world, local)` → material query and anchored plant/rock records | Slope, temperature, rainfall, water proximity, rock resistance and sediment feed explicit thresholds and smooth cover weights. Candidates are rejected on water and slopes over 0.28 m/m. |
| 8. Views | One model and shared geographic probe → Atlas and Explorer | Atlas renders the whole planet and a higher-resolution raster of the pilot. Explorer renders a 40 × 40 quad mesh with an orbit camera and shared material colors. Both views report the same authoritative probe regardless of zoom. |
| 9. Overlay | `place`, `exportOverlay`, `importOverlay` → a separately persisted cube | One 1 km cube, sized for the regional camera, has a ground-relative anchor at zero offset. Its ID hashes world ID and canonical anchor. Import validates schema, recipe, world, structure and anchor before applying it. |

Settings defaults and accepted ranges are defined in [world.js](world.js). The Earth-like default uses radius 6,371 km, rotation 24 h, ocean-equivalent inventory 1,200 m, reference temperature 28 °C and an epoch multiplier of 1. Radius sets metric scale and slope. Rotation and reference temperature feed climate proxies. The epoch multiplier scales uplift. Unknown settings and unrecognized recipes are rejected. The overlay schema starts at 1. Recipe changes require an explicit migration before older overlays can load.

## Determinism and limits

FNV-1a/64 hashes UTF-8. Named streams are derived from seed and recipe. Samples derive a unit value from the first 52 hash bits of a stream and a stable address, independent of call order.

- **Plates** uses uniform sphere directions for centers and spin axes, uniform spin speeds in 0.35–1, and rock resistance in 0.25–0.9. A fixed six of fourteen provinces are continental.
- **Relief** uses three uniform axes and phases. Each sinusoid has amplitude 120 m and one cycle per `2π/5` units of projected position on the unit sphere.
- **Refinement** uses a uniform phase addressed by pilot tile. The sinusoid has a wavelength of 0.4 parent spans along its oriented axis and a smooth edge envelope. Amplitude is at most 95 m and is further limited by dryness, relief, rock resistance and grade.
- **Habitat** uses an 18 × 18 stratified candidate grid in the pilot. Stable addresses determine within-cell offsets and a density draw. Cover and resistance cap the retention probability at 0.68.

Geology and weather are heuristic fields. Hydrology routes on the filled surface, where flat links follow priority-flood order. Links across a rising bed represent ponded drainage and appear in the diagnostics, along with rerouted cells and mass-balance residuals. The ocean inventory solve excludes inland pond storage. Climate and erosion use a single annual proxy and one sediment update. The model does not resolve river channels, changing lake storage or a physical erosion history. Refinement covers one dry inland patch with a stable address. The Explorer exaggerates relief for visibility and shows ground cover as simple symbols. An incompatible or unsupported world configuration produces an on-screen error.

## Verification

```sh
node --test world.test.cjs
node --test browser.test.cjs
```

The first suite checks invariants for all nine stages, including ocean, runoff and sediment balances, receiver termination, exact tile edges, and stable overlay anchors. The second opens the local page in headless Chrome, checks probe and anchor stability across views and camera changes, downloads an overlay, reloads, and imports the file. Set `HORIZON_CHROME` for a custom Chrome executable or `HORIZON_TMP` for an alternate writable profile parent.

