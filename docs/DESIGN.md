# Sailing Sim: Design

Read this file at the start of every session. Read `PHYSICS.md` before touching anything in `sim/`.

## What this is

A first-person, realistic sailing simulator that runs in the browser as a static site.
One sailor, one boat (Laser / ILCA 7), open water, light gusty wind.
Failure is the teacher: there is no auto-trim and no auto-hiking. The world gives honest
cues (telltales, luffing, heel, water), and the player learns to read them.

Long-term direction (not v1): a cruising / navigation / management layer on a bigger boat.
Keep the boat data-driven so that is possible later.

## v1 scope

- Free sandbox in endless open water, with a few buoys to navigate between.
- Boat: Laser (ILCA 7), procedurally generated to class dimensions.
- Wind: default 7 knots mean, always read through `getWind(position, time)`. Debug range 0-16 kn;
  6-8 kn remains the intended light-wind sailing range, stronger settings are exploratory.
  In the browser the wind has seeded gusts and slow direction shifts (`?gusts=0` for a constant wind):
  gusts are patches carried downwind by the mean wind, so a patch seen darkening the water arrives at
  the boat later, and the wind direction oscillates a few degrees over minutes. Gusts veer slightly.
  Headless runs and the polar keep the constant wind. Waves and clouds follow the mean wind only.
  All gust and shift numbers are TUNING GUESS values in `data/wind.json`.
- Waves: two data-driven Gerstner bands, broad waves plus fine ripples, shared by physics and rendering.
  Wind speed controls height and length; seeded strengths/phases produce uneven crest groups without
  per-frame randomization. Ripples use eight weaker, downwind-biased components with seeded wavelength
  and direction variation rather than four widely crossing wave trains that formed a regular lattice.
  The browser chooses a new pattern on reload; headless runs stay deterministic.
  Surface slope rocks the boat; orbital flow at each foil can deflect the course. Overall amplitude,
  separate big-wave/ripple multipliers, broad period and direction controls are in the debug menu.
  Spectrum, wind scaling and response tuning are TUNING GUESS, not a calibrated sea-state model.
- No planing, no capsizing. Heel clamps at a limit.
- First-person camera only; vertical cockpit field of view 85 degrees.
- Controls: mouse look, keyboard for tiller / sheet / hiking.
- Navigation: compass plus a paper-style chart with a drifting dead-reckoning marker,
  corrected by bearings to buoys.
- Visuals: as realistic as an integrated laptop GPU allows, at one fixed quality level. There are no
  quality tiers: every effect is built cheap enough to run everywhere.

## Non-goals for v1

Full wave/buoyancy dynamics, capsize and recovery, racing and AI boats,
multiplayer, planing, other boats, a cruising or management layer, mobile and touch input,
full sailor body and hiking pose (hands, tiller extension and mainsheet only in v1).

## Stack

Vite + TypeScript + Three.js. Static build output. No backend.

## Architecture

```
src/
  sim/      Pure math. NO Three.js imports, no DOM. Deterministic.
            state + inputs + dt -> new state.
  render/   Reads sim state, draws it. Never writes to sim state.
  input/    Keys / mouse -> normalized control values (tiller, sheet, hike, look).
  nav/      Chart, dead reckoning, bearings (reads sim state, own state for DR).
  data/     Boat config (laser.json), constants. No magic numbers in code.
  debug/    Overlay: apparent wind, force vectors, speed, heel, polar plot.
scripts/
  polar.ts  Headless: sails the boat at fixed headings, dumps a polar. Runs in Node.
docs/   Source papers and rules. See INDEX.md.
```

Rules:
- The sim runs on a **fixed timestep** (start at 60 Hz, raise if unstable). Rendering interpolates.
- `sim/` must run headless under Node, so the polar script and tests work without a browser.
- Boat parameters live in `data/laser.json`, not in code. A second boat should be a new config file.
- Every constant is either sourced from `docs/` or marked `// TUNING GUESS`.
  Do not recall coefficient tables from memory.
- Water follows the boat continuously, but wave phase stays anchored to world coordinates.
  Only the flat-water debug grid snaps. Filter rendering detail to mesh/pixel resolution.
  A **render-side floating origin** follows the interpolated boat every frame, without threshold jumps.
  Simulation/navigation coordinates stay in logical-world doubles. Boat, cameras, water and debug
  arrows use small render-local coordinates; fixed buoy transforms are rebased before GPU upload.
  Reduce each wave's origin/time phase in double precision before the shader adds local spatial phase.
  Wake history is world-anchored: `render/wake/trail.ts` stores logical-world doubles and subtracts this
  same origin only when packing GPU uniforms.

## Controls

| Input | Action |
|---|---|
| Mouse | Look around (pointer lock) |
| A / D | Tiller (hold to move, stays where released) |
| W / S | Ease mainsheet / sheet in, holds position |
| Mouse wheel up / down | Sheet in / ease mainsheet in small steps, holds position |
| Shift (hold) | Hike out (lean weight out), release to sit in |

Inputs are **continuous with rate limits**: no snapping. A tiller key ramps the tiller over a
fraction of a second and holds its position. Same idea for the sheet.

## Visuals

- **Water:** one Gerstner model in `sim/waves.ts`, with parameters in `data/waves.json`, supplies
  CPU sampling and shader displacement/analytic normals for both broad waves and ripples.
  Unequal lengths/directions and seeded strengths/phases break up wave trains; ripple spacing and
  angles also vary by seed, with nearby wavelengths producing uneven beat groups.
  A uniform near-boat patch and growing
  outer grid follow continuously without moving world-space phase. Mesh-cell filtering prevents
  unresolved displacement; per-pixel normals and footprint/specular filtering prevent distant shimmer.
  Physics responds to slope and foil orbital flow; visual heave follows surface height, without a
  vertical buoyancy-force simulation.
- **Wake and bow wave (visual only):** the water shader adds a Kelvin wake (transverse and divergent
  waves, 19.47 degree cusp), a bow wave hugging the waterline, and turbulent foam behind the transom
  and on the bow crest. Only new bow emissions follow the foremost hull/sea contact using heave,
  pitch and heel. Each emitted front retains its birth contact in logical-world doubles, propagates
  outward and fades independently; lifting/dropping the bow cannot relocate the older V. Smooth
  birth/expiry and bounded overlap blend successive contributions without a live-anchored V fallback.
  Kelvin sits at `visualGain = 0.8`; bow height uses `bowHeadFrac = 0.30` and `bowLength = 5` for a more prominent
  bow V (1.875x the previous 0.16 height, arms attenuate more slowly). Both are visual TUNING GUESS values; no sim forces change.
  Bow fronts are circular crest/trough packets whose steady-motion envelope forms a V. This is a
  nondispersive visual approximation, not calibrated pressure-wave physics or shoreline breaking.
  `render/wake/bowField.ts` rasterizes a bounded world-grid cache to a reusable float texture; water
  samples it at constant cost, with screen-derivative normals and no per-pixel history search.
  Bow foam uses its emitted front's source height/speed, with continuous crest coverage and the same
  noise patch breakup as stern foam, so both foams share one grain scale. It starts at the bow emission speed
  threshold independently of stern turbulence. Stern foam appearance remains unchanged.
  Height, foam and lifetime/resolution parameters are explicit TUNING GUESS values in `wake.json`.
  Parameters in `data/wake.json`; math in `render/wake/` (no Three.js, tested);
  debug toggles for the three components, "wake: Kelvin waves", "wake: bow V waves" and "wake: foam (bow +
  stern)", each a shader-side switch (the trail and bow field keep their history, so switching back shows
  the true wake), and `?wake=0` to start with the whole wake off.
- **Sky:** one analytic sky function (`render/sky.ts`, adapted from three's examples Sky: Preetham
  daylight scattering, sun disc, procedural clouds) is the sky for everything. The dome shades with
  it, the water reflects it per pixel and the water's distance fog blends toward its horizon colour,
  so the horizon, sun and clouds always agree. Pure atmosphere math, the horizon fog colour and sun
  light tint are in `render/skyModel.ts` (tested); parameters in `data/sky.json`.
  The sun is fixed in play (default elevation 59, bearing 124, the old light direction); set it with
  `?sunElevation=`, `?sunAzimuth=` or the debug panel. Light colour and strength follow the sun
  (warmer and dimmer low, off below the horizon). Clouds drift with the true wind (`?clouds=0..1`
  coverage, debug panel) and are the only moving part. The cloud noise is a seeded 256 px tiling
  texture read with hardware filtering rather than Sky.js's per-pixel hash, which cost about 2.8 ms
  per frame on an M1; the whole sky is about 1 ms. The dome draws last at the far plane so water and
  boat pixels skip it. No screen-space reflections, no heavy post-processing, no renderer tone mapping.
- **Boat:** procedural hull lofted from a few cross-sections using class dimensions,
  plus spars and fittings. Low triangle count.
- **Sail:** cloth-like visual (small Verlet grid, around 20x12 points, pinned along luff / foot).
  **It is visual only.** Sail forces come from the foil model in `sim/`. The sim exposes a
  `luffAmount` value (0 = trimmed, 1 = fully luffing) and the cloth reads it to flutter.
  The cloth never feeds back into forces.
- **Sailor:** v1 shows hands, tiller extension and sheet. Full body and hiking pose come later.

## In-world cues (no HUD)

Telltales on the sail, sail luffing and flutter, a masthead fly or burgee, water ripples
and cat's-paws showing wind direction, heel angle, and sound (luff flap, water rush) if added.
The debug overlay is a developer tool, not a player aid, and is toggled off by default.

## Navigation

- Compass in view.
- A paper-style chart with the buoys and a **dead-reckoning (DR) marker**.
- DR integrates compass heading x logged speed over time, as if the sailor plotted it by hand.
  It **ignores leeway** and uses an imperfect speed estimate, so it drifts from the true position.
- The sailor corrects it by taking a **compass bearing to a buoy** and plotting a position line.
  Exact fix mechanics are decided in milestone 5.
- There is no "you are here" marker for the true position (a debug toggle may show it).

## Milestones

One milestone per session. Commit after each working one.

0. **Scaffold:** Vite + TS + Three.js, folder structure, fixed-timestep loop, empty scene, lint/test setup.
1. **Full physics core on flat water (one big pass):** all of layers L1-L6 from `PHYSICS.md`: apparent wind,
   sail foil using the best-trim envelope from Day Table 1, daggerboard and rudder, hull resistance, heel
   and hiking, yaw dynamics. Optional extras behind toggles: sail twist (a few vertical slices), fore/aft crew weight.
   Box placeholder boat. **Every layer has a config toggle, a debug-overlay toggle, and a unit test.** The headless
   polar script must run with any layers disabled, so a wrong result can be bisected by layer.
2. **Tuning and validation:** run the polar, compare against Day (9 kn VPP, Figs 4-7), fix the sail falloff first,
   then foils, then drag, then yaw. Do not add features in this session.
3. **Boat graphics and test HUD:** procedural Laser (hull, deck, daggerboard, rudder, tiller and extension, mast, boom, sail,
   mainsheet), hands on the tiller extension and sheet, an instrument HUD (DOM overlay), and a minimal environment so motion
   is visible: a flat plane that follows the boat on a snapped grid, a plain sky colour, and a few buoys.
4. **Cloth sail:** visual cloth driven by `luffAmount`, telltales, masthead fly. Done.
5. **Water and sky:** shared Gerstner waves with physical rocking and orbital foil cross-flow implemented.
   Wind-responsive broad waves/ripples, separate layer controls and seeded magnitude variation implemented.
   Render-side floating origin and precision-safe world-anchored wave phases implemented.
   Analytic sky (sun, clouds, water reflection, horizon fog) implemented.
6. **Navigation:** compass, chart, buoys, dead reckoning with drift, bearing fixes.
7. **Sailor body and hiking pose.**
8. **Polish:** sound, tuning against the polar.

Later: full wave/buoyancy response, wind gradient with height and gusts that build the sea,
capsize, planing and stronger wind, third-person camera, cruising / management layer.

## Working agreement for the coding agent

- Read `DESIGN.md` and `PHYSICS.md` first. Do only the requested milestone.
- Keep `sim/` pure. If a change needs Three.js inside `sim/`, stop and ask.
- No invented constants. Cite a reference file or mark `// TUNING GUESS`.
- Keep a debug overlay up to date with whatever you add to the physics.
- After a physics change, run `scripts/polar.ts` and report the result.
- Every physics layer must be individually toggleable. Never merge two layers into one function that cannot be disabled.
- Prefer small files with clear names over large mixed ones.

## Open questions

- Exact chart fix mechanic (plot a line, snap DR to it, or free placement).
- Heel clamp value and what the clamp feels like at the limit.
- Wave response magnitudes are sanity-checked, not calibrated against measured Laser wave data.
  Tune by feel for now; measured response would be needed for calibration.
