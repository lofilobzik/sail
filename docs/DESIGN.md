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
| C | Centre tiller at its normal movement rate |
| W / S | Ease mainsheet / sheet in, holds position |
| Mouse wheel up / down | Sheet in / ease mainsheet in small steps, holds position |
| Shift (hold) | Hike out (lean weight out), release to sit in |
| F (hold) | Take a reading; where you look decides which. Looking astern at the wake (no buoy under the crosshair) judges boat speed. Anything else raises the yellow hand-bearing compass for a bearing: the buoy under the crosshair names itself, and lined up with the bow, tilted down, the bearing is your course. A buoy astern is still a bearing |
| R | Reckon, with the chart in view: plot bearings taken since the last plot (a fix), otherwise the dead-reckoning leg |
| H | Toggle test instruments (hidden by default) |

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
  **Sail designs:** printed sails are generated procedurally, never loaded from an image. Each design in
  `data/sail-designs.json` is a stack of layers (fill, gradient, polygon, stripes, rays, star, circle,
  tiled pattern) in sail space (x across from the luff, y from the foot up), drawn once onto a canvas by
  `render/sailDesign.ts` and cached by `render/sailPaint.ts`. The cloth grid carries UVs in true cloth
  metres, so a circle stays round as the cloth moves. A design may set its own opacity and glow; a seeded
  panel-seam and speckle finish goes over all of them. Pick one with the debug panel's "sail design"
  dropdown or `?sail=<id>`; edit or add designs in the JSON (a typo throws an error naming the design and
  layer). Printed cloth is mirrored on its reverse side, as real printed sailcloth is, so text such as
  `:3` reads backwards when seen from the other side. The default is the plain white class sail.
- **Sailor:** v1 shows hands, tiller extension and sheet. Full body and hiking pose come later.

## In-world cues (no HUD)

Telltales on the sail, sail luffing and flutter, a masthead fly or burgee, water ripples
and cat's-paws showing wind direction, heel angle, and sound (luff flap, water rush) if added.
The debug overlay is a developer tool, not a player aid, and is toggled off by default.

## Navigation

- A physical paper-style chart on the sailor's lap, following the sailor between sides and while
  hiking. It is always there: look down to see it. No minimap, chart overlay, automatic camera
  movement or chart raised into view. It is read-only and driven entirely by the keyboard: the mouse
  only looks around (and clicks the debug panel). The chart frames the marker, its track, the course
  line and all the buoys by itself.
- **No instrument tells you where you are.** The boat has no log, GPS or deck compass. The only
  instruments are a yellow hand-bearing compass (modelled on a Plastimo Iris 50) and the sailor's
  eyes. There is no live position: the chart shows only the last position pencilled onto it, how
  long ago, and the sailor's doubt about it in metres (no circle is drawn).
- **Readings take time.** Hold `F` to raise the compass and hold it on a mark (a ring fills; pointing
  at the sky, or straying more than 10 degrees from your own recent mean aim, restarts it) to record
  a bearing. The boat rocks in the waves, which swings the aim a few degrees either way; the
  recorded bearing is the mean over the last 1.5 s, so a slow track on a buoy works. The buoy that
  was under the crosshair for most of the hold (at least 30% of it, so a rocking boat is forgiven)
  is named automatically. Lining the compass up with the boat's centreline, tilted down at least 8
  degrees toward the bow for most of the hold, takes a bow bearing, which is remembered as the
  course. Speed comes from the wake: press `F` looking astern (within about 50 degrees of straight
  back) with no buoy under the crosshair; the kind of reading is fixed when the key goes down, and
  turning away from the wake restarts the ring. A remembered speed older than two minutes is flagged
  OLD on the chart, so the sailor knows to look at the wake again. A value is only taken when the
  ring completes, is not repeated until the key is released, and is kept with its age.
- **Remembered values are shown as faint text** in the lower-right corner (course, speed, and each
  bearing with its buoy), never as an instrument. They are exactly true for now; no instrument
  error, magnetic variation or deviation is modelled.
- **One reckoning key.** `R`, with the chart in view, plots the bearings taken since the last plot if
  there are any named ones (a fix, about 4 s per line), and otherwise the dead-reckoning leg
  (about 5 s). Pencil work only progresses while you look at the paper; looking away pauses it
  where it was. A leg carries the last pencilled position forward by the remembered course and
  speed over the time since the last plot, ignoring leeway and anything that changed since the
  readings. A fix takes the newest named note of each buoy, up to two: one projects the marker onto
  its line, leaving along-line error; two adequately separated bearings give an intersection fix.
  The marker only moves when the pencil work finishes. The doubt figure in the header grows with the
  length of each leg plotted on memory and shrinks again on a fix.
- **What the chart tells you, and nothing more.** The last plotted position is a simple pencil dot.
  Every earlier plotted position stays as a dot on a thin pencilled
  track. A dashed course line runs ahead of the dot with ticks at 1, 2 and 5 minutes at the
  remembered speed, and a little triangle points where the last bow reading says we are heading.
  Every buoy always shows the bearing and distance from the last plotted position, so the chart says
  what to steer for; those figures go stale as the boat sails on until the next plot. Bearing lines
  are drawn only for notes the next plot will use; plotted ones are rubbed out. There are no grid
  numbers, track times or arrival times.
- **Buoys identify themselves to the eye.** A sailor can read the painted ID of the buoy they are
  looking at, so a buoy within 7 degrees of the line of sight counts as under the crosshair. This
  uses only what the eye sees: the bearing still comes from the compass, and the boat's position is
  never used. There is no manual selection: a note taken with no buoy under the crosshair stays
  unnamed and is not used for fixes. Buoys have matching physical painted IDs,
  distinctive colours and topmarks; these are sandbox landmarks, not an IALA-marked course.
- **Bearing lines on the chart.** Each named note draws a pencil line from its buoy back along the
  bearing, labelled with its angle; the ones the next plot will use are darker, and where two of
  them cross the crossing is marked. Lines are advanced by the remembered course and speed, so
  sailing between sightings is accounted for. Bearings expire after 180 simulated seconds;
  near-parallel lines (within 15 degrees), unnamed notes and bearings pointing away from their
  chosen buoys cannot provide a fix. These limits are TUNING GUESS values.
- There is no "you are here" marker for the true position (a debug toggle may show it).
  The navigation estimator receives only instrument readings, never the true boat position;
  logical navigation coordinates are independent of the render-side floating origin.

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
6. **Navigation:** yellow hand-bearing compass, wake speed reading, timed readings and plotting, faint
   remembered values, physical lap chart with doubt circle and bearing lines, identifiable buoys.
   Pure navigation tests cover timed holds, remembered values, leg plotting, bearing geometry, fixes and
   chart projection. Browser smoke checked pointer-locked readings, the memory text, plotting and lines.
7. **Sailor body and hiking pose (post-v1, as scoped above).**
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

- Lap chart placement/readability and navigation drift tuning await player feedback on the preview.
- Heel clamp value and what the clamp feels like at the limit.
- Wave response magnitudes are sanity-checked, not calibrated against measured Laser wave data.
  Tune by feel for now; measured response would be needed for calibration.
