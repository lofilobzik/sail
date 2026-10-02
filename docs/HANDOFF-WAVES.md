# Water rendering handoff: blinking repair and floating origin verified

## Current status

The intermittent snap-related water blinking reported after `cb6b58b` has been isolated and repaired.
The original physical wave implementation is still intact. This document supersedes the earlier
unresolved Opus handoff; see `PHYSICS.md` L7 for detailed model and verification notes.

Render-side floating origin is also implemented. It preserves logical simulation coordinates and
world-anchored waves while keeping rendered coordinates and shader phase inputs small.

The current sea now has separate broad-wave and fine-ripple bands, wind-responsive heights/lengths,
and seeded random component strengths/phases. Browser reloads choose a new pattern; sailing and
wind/sea adjustments retain it. Debug controls include `big waves`, `ripples`, overall amplitude,
reference-wind broad period, direction, and wind 0-16 kn.

For this layered-sea change, automated tests/build/polar reruns were intentionally skipped at the
user's request. A brief browser smoke loaded the surface/controls and exercised 7 -> 12 kn wind;
the L7 broad-period readout changed from about 3.40 to 4.10 s without reported shader/JS errors.
The older verification numbers below are historical, not results for the new spectrum.

The investigation browsers have been closed and the preview servers stopped.
The temporary `window.__probe` hook left by Opus was removed. No unrelated reference PDFs/text
were included in the repair.

## Cause and repair

The original 4000 m / 256-segment cubic grid had tiny centre cells but severely undersampled
waves farther out. Moving its origin in 5 m snaps abruptly changed the triangulated approximation
and interpolated vertex normals, even though the analytical wave phase was world-anchored.

A water-only browser scene isolated this from all boat/cloth animation: camera and wave time fixed,
change only water centre x from 2.49 to 2.51 m. The original default field changed 25,002 pixels by
more than 2 RGB levels; moving within the same cell changed zero pixels. At the shortest period,
the boundary changed 72,581 pixels. These measurements—not the earlier confounded screenshots—
establish the recentering discontinuity.

The repair:
- Recenter water continuously, preserving world-space phase; only the flat-water debug grid snaps.
- Use a uniform 32 m near-boat patch with 0.20 m cells and geometrically growing outer cells.
  Triangle count remains unchanged; no extra textures or heavyweight rendering passes.
- Attach actual adjacent-cell dimensions to vertices; smoothly filter geometric components that
  the mesh cannot resolve. Full detail at 8 samples/projected wavelength, zero below 4.
- Evaluate analytic wave normals per fragment instead of interpolating coarse vertex normals.
  Pixel derivatives filter unresolved shading detail.
- Broaden the sun-glint lobe using pixel normal variance, with a cosine-power energy correction.
  Filter settings and optical approximation remain TUNING GUESS.
- Keep CPU physics unfiltered. The shared GLSL kernel takes a footprint; zero footprint reproduces
  the physical model, and the actual near-boat cell footprint preserves it across allowed controls.

## Floating-origin contract

- `SceneView.origin` is the interpolated boat's logical x/z position, updated every frame.
  There is no distance threshold or discrete origin jump. Do not rebase simulation/navigation state.
- Boat x/z and water centre are render-local zero; cockpit/outside cameras and force arrows stay nearby.
  Fixed buoy transforms compose with their rebased parent in JS doubles before GPU upload/culling.
  The debug grid stays logically snapped but subtracts the render origin.
- `wavePhaseAt` folds each component's logical-origin and rendered-time phase in double precision,
  then reduces it to [-pi, pi]. GLSL adds only nearby label phase. `waveMotion` now holds
  `(reduced phase, choppiness)`; `gerstnerWave` no longer takes a time argument.
- Keep CPU wave samples, orbital flow, roll/pitch response and integration unchanged.
- Future wakes should store history in logical world coordinates, subtracting the current render
  origin before filling GPU buffers. Do not attach the historical trail to the moving boat.

## File map

- `src/render/water.ts`: grid generation, continuous recentering, geometry/pixel footprint filtering,
  per-fragment normals, antialiased sun glint, reduced phase-uniform updates.
- `src/sim/waves.ts`: unchanged CPU sampling; reduced-origin phase helper and render-local GLSL kernel.
- `src/data/waves.json`: broad/ripple bands, wind scaling, seeded variation, grid/filter/response tuning.
- `src/render/scene.ts`: shared render origin, local boat/cameras/water, rebased buoys/debug grid.
- `src/render/vectors.ts`: true-wind arrow takes the render-local boat position; body arrows follow it.
- `src/main.ts`: normal fixed-step/interpolated render loop and local arrow updates; no debug exposure.
- `src/sim/step.ts` and `layers/foils.ts`: original slope-driven rocking and depth-decayed orbital inflow.
- `src/debug/overlay.ts`: wind-to-sea updates, separate band multipliers, overall amplitude,
  reference-wind broad period, direction and effective amplitude/period readouts.

The user requested physical waves: slope must rock the boat and orbital flow at each foil must
produce side force/yaw. Do not replace that feature with purely cosmetic water or a second spectrum.
`sim/` remains pure/headless with no Three.js or DOM imports.

## Verification performed before the layered-sea change

- Same isolated camera/environment after repair: default boundary mean RGB difference 0.00562,
  neighboring 2 cm movement 0.00553; 53 pixels exceed 2 levels. Previously the mean was 0.669.
  Shortest-period means: boundary 0.02829, neighbor 0.02891, versus original boundary 2.115.
- 162 cases: three camera poses, period 2/default/8 s, amplitude 0/1/2, directions 0/90/225 degrees,
  x/z boundary crossings. Maximum boundary-to-neighbor mean-change ratio 1.091.
- Three 240-frame moving-time/moving-mesh sequences (default and extremes): no spikes at former
  snap boundaries. Six-second isolated and ten-second actual outside/cockpit recordings captured
  and inspected. Final actual game smoke also exercised shortest-period/max-amplitude and waves off.
- GPU transform feedback: 486 samples, zero and 0.20 m footprints, multiple period/direction/amplitude,
  times and positions. Max CPU/GPU errors about 4.33e-6 m position and 3.16e-6 normal component.
  Filter endpoints and midpoint also checked on the GPU; no WebGL error.
- Waves-off polar CSV and SVG byte-identical to the original 6/7/8/9 kn baseline, TWA 30-180 in 5-degree steps.
- Existing 73 tests / 12 files pass, lint/typechecking/build pass. Vite still reports the bundle-size warning.
- No reported shader/JS errors during the browser checks.

Local recordings: `/tmp/sail-water-continuity.webm` and `/tmp/sail-water-game.webm`.
Polar comparison: `/tmp/sail-flat-before` vs `/tmp/sail-water-repair-polar`.
These are temporary local evidence, not committed fixtures. GPU/image checks ran as throwaway browser
experiments; the ordinary test suite alone does not verify visual continuity.

### Floating-origin checks

- Reproduced visible distant-water precision loss at `(1e9, -1e9)` m before the change.
- 7,344 GPU/CPU samples through +/-1e9 m and 1e7 s; max position/normal-component errors
  1.36e-6 m / 1.16e-6, no WebGL error. Allowed controls, near-boat footprints and phase wraps covered.
- 324 fixed-world/render-origin image comparisons: worst mean RGB change 0.000211 (0-255 scale),
  at most six pixels above two levels; not bit-exact, with isolated differences up to 33 levels.
- Three 120-frame distant moving-water sequences cover default and control extremes. Nine former
  snap crossings and 25 phase wraps have no boundary spikes; worst neighbor ratios 0.9992 / 1.0007.
- 24 consumer checks preserve buoy anchors, nearby cameras/arrows, heave and flat-grid placement.
  Rendering leaves simulation state/config/diagnostics unchanged.
- Actual-game cockpit/outside views, zero amplitude, wave toggle and live period/direction controls
  exercised. A six-second actual-game recording was captured. No reported shader/JS errors.
- Original 6/7/8/9 kn waves-off CSV/SVG still match byte-for-byte; 75 tests, lint/typecheck/build pass.
  The existing Vite bundle-size warning remains.

Local floating-origin evidence: `/tmp/sail-floating-origin-water.webm`,
`/tmp/sail-floating-origin-game.webm`, `/tmp/sail-floating-origin-polar`.
No browser harness or temporary app hook was added to the repository.

## Rechecking a future renderer change

For a clean visual comparison, import `createWater` into an isolated scene and render only water/sky:
- Use a fixed camera, fixed wave time, and fixed scene lighting/fog.
- Compare equal 2 cm origin changes on both sides of former x/z snap boundaries.
- Compare frame sequences with both time and origin advancing at constant increments.
- Cover default light chop, 2 s / 2x amplitude, long periods, and different headings/camera angles.
- Hold the entire camera transform fixed—not just its x position. Exclude boat/cloth animation.
- Do not freeze or override the real app's `requestAnimationFrame` to perform the experiment.

Useful game views after starting your own dev server:
`/?view=outside`, `/?waves=0`,
`/?view=outside&waveAmplitude=2&wavePeriod=2&waveDirection=225`.
V switches cockpit/outside view, H toggles test HUD, F3/Backquote opens wave controls.

## Remaining limits

The far field is a deliberately filtered approximation, not the exact unfiltered CPU surface.
The reflected sky is the shared analytic sky (`render/sky.ts`: sun, clouds, haze), not scene/environment
reflections: the boat, buoys and wake are not mirrored. No new empirical
Laser calibration or target-laptop GPU performance qualification. Distant coordinates and long elapsed
times were exercised synthetically, not through a multi-month session. CPU doubles remain finite;
the floating origin is not an unlimited-distance guarantee.

Wave defaults and wind scaling remain TUNING GUESS. At 7 kn the primary broad wavelength is 18 m,
period about 3.40 s, amplitude 0.12 m before seeded variation and control multipliers. Two further
broad components and four fine ripple components create a varied field. No fetch, duration, remote
swell or capillary dispersion is modeled. The physical response has no measured Laser wave data: local-slope
roll approximation, tuned pitch oscillator, kinematic heave, planar force integration, flat-water hull
resistance, no slamming/breaking-wave/wet-dry foil model. These limits were not expanded by the repair.

References are recorded in `INDEX.md` and `waves.json`; start each session with `DESIGN.md` and
`PHYSICS.md`. Preserve exact flat-water compatibility when changing physics.
