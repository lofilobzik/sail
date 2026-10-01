# Water rendering handoff: blinking repair verified

## Current status

The intermittent snap-related water blinking reported after `cb6b58b` has been isolated and repaired.
The original physical wave implementation is still intact. This document supersedes the earlier
unresolved Opus handoff; see `PHYSICS.md` L7 for detailed model and verification notes.

The investigation browser has been closed and the `sail-water-repair` preview server stopped.
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

## File map

- `src/render/water.ts`: grid generation, continuous recentering, geometry/pixel footprint filtering,
  per-fragment normals, antialiased sun glint.
- `src/sim/waves.ts`: unchanged CPU sampling; shared GLSL now accepts the render footprint.
- `src/data/waves.json`: grid/filter choices plus original wave spectrum and response parameters.
- `src/render/scene.ts`: water creation/update, boat surface-height following, snapped debug grid.
- `src/main.ts`: normal fixed-step/interpolated render loop; no temporary debug exposure.
- `src/sim/step.ts` and `layers/foils.ts`: original slope-driven rocking and depth-decayed orbital inflow.
- `src/debug/overlay.ts`: existing waves toggle, amplitude, primary period, and propagation direction.

The user requested physical waves: slope must rock the boat and orbital flow at each foil must
produce side force/yaw. Do not replace that feature with purely cosmetic water or a second spectrum.
`sim/` remains pure/headless with no Three.js or DOM imports.

## Verification performed

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
The reflected sky is still a color gradient, not scene/environment reflections. No new empirical
Laser calibration, long-session/floating-origin proof, or target-laptop GPU performance qualification.
A floating origin has not been implemented.

Wave defaults remain TUNING GUESS. Primary wave A = 0.12 m, L = 12 m, period about 2.77 s; two smaller
crossing components. The existing physical response has no measured Laser wave data: local-slope
roll approximation, tuned pitch oscillator, kinematic heave, planar force integration, flat-water hull
resistance, no slamming/breaking-wave/wet-dry foil model. These limits were not expanded by the repair.

References are recorded in `INDEX.md` and `waves.json`; start each session with `DESIGN.md` and
`PHYSICS.md`. Preserve exact flat-water compatibility when changing physics.
