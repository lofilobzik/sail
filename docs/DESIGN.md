# Sailing Sim: Design

Read this file at the start of every session. Read `PHYSICS.md` before touching anything in `sim/`.

## What this is

A first-person, realistic sailing simulator that runs in the browser as a static site.
One sailor, one boat (Laser / ILCA 7), open water, light fixed wind.
Failure is the teacher: there is no auto-trim and no auto-hiking. The world gives honest
cues (telltales, luffing, heel, water), and the player learns to read them.

Long-term direction (not v1): a cruising / navigation / management layer on a bigger boat.
Keep the boat data-driven so that is possible later.

## v1 scope

- Free sandbox in endless open water, with a few buoys to navigate between.
- Boat: Laser (ILCA 7), procedurally generated to class dimensions.
- Wind: default 7 knots, always read through `getWind(position, time)`. Debug range 0-16 kn;
  6-8 kn remains the intended light-wind sailing range, stronger settings are exploratory.
- Waves: two data-driven Gerstner bands, broad waves plus fine ripples, shared by physics and rendering.
  Wind speed controls height and length; seeded strengths/phases produce uneven crest groups without
  per-frame randomization. The browser chooses a new pattern on reload; headless runs stay deterministic.
  Surface slope rocks the boat; orbital flow at each foil can deflect the course. Overall amplitude,
  separate big-wave/ripple multipliers, broad period and direction controls are in the debug menu.
  Spectrum, wind scaling and response tuning are TUNING GUESS, not a calibrated sea-state model.
- No planing, no capsizing. Heel clamps at a limit.
- First-person camera only.
- Controls: mouse look, keyboard for tiller / sheet / hiking.
- Navigation: compass plus a paper-style chart with a drifting dead-reckoning marker,
  corrected by bearings to buoys.
- Visuals: as realistic as an integrated laptop GPU allows, with a quality setting.

## Non-goals for v1

Full wave/buoyancy dynamics, gusts and shifts, capsize and recovery, racing and AI boats,
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
  Future wake history must stay world-anchored: subtract this same origin before writing GPU vertices.

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
  Different lengths/directions and seeded random strengths/phases break up uniform wave trains.
  A uniform near-boat patch and growing
  outer grid follow continuously without moving world-space phase. Mesh-cell filtering prevents
  unresolved displacement; per-pixel normals and footprint/specular filtering prevent distant shimmer.
  Physics responds to slope and foil orbital flow; visual heave follows surface height, without a
  vertical buoyancy-force simulation.
- **Sky:** Three.js analytic Sky shader. No screen-space reflections, no heavy post-processing.
- **Boat:** procedural hull lofted from a few cross-sections using class dimensions,
  plus spars and fittings. Low triangle count.
- **Sail:** cloth-like visual (small Verlet grid, around 20x12 points, pinned along luff / foot).
  **It is visual only.** Sail forces come from the foil model in `sim/`. The sim exposes a
  `luffAmount` value (0 = trimmed, 1 = fully luffing) and the cloth reads it to flutter.
  The cloth never feeds back into forces.
- **Sailor:** v1 shows hands, tiller extension and sheet. Full body and hiking pose come later.
- **Quality setting** from the start (water grid resolution, cloth resolution, shadows).

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
4. **Cloth sail:** visual cloth driven by `luffAmount`, telltales, masthead fly.
5. **Water and sky:** shared Gerstner waves with physical rocking and orbital foil cross-flow implemented.
   Wind-responsive broad waves/ripples, separate layer controls and seeded magnitude variation implemented.
   Render-side floating origin and precision-safe world-anchored wave phases implemented.
   Analytic sky and quality setting remain planned, outside the water/waves change.
6. **Navigation:** compass, chart, buoys, dead reckoning with drift, bearing fixes.
7. **Sailor body and hiking pose.**
8. **Polish:** sound, quality settings, tuning against the polar.

Later: full wave/buoyancy response, gusts and wind shifts,
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
