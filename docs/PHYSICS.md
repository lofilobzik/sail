# Physics Model

Applies to everything in `src/sim/`. Read `DESIGN.md` first.

**Rule:** every constant comes from `docs/` or is marked `// TUNING GUESS`.
Do not fill in coefficient tables from memory. If a number you need is not in a reference file, ask.

Status markers used below:
- **[sourced]** value appears in a public listing or class document, still verify against the class rules
- **[ref]** must be taken from a reference file (mostly Day 2017, see `docs/INDEX.md`)
- **[tune]** tuning guess, adjust until the polar looks right

## 0. Conventions

- SI units internally (m, s, kg, N, rad). Convert knots and degrees only at the edges (UI, debug).
- Compass bearings are degrees clockwise from north. The sim uses radians internally.
- Axes: right-handed, Three.js-compatible (y up). Horizontal plane is x-z. Define the compass
  mapping in one place (`sim/frames.ts`) and use it everywhere.
- Body frame: +surge forward, +sway to starboard, yaw about vertical, heel about the longitudinal axis.
- Fixed timestep, semi-implicit Euler to start. Substep if forces get stiff.

## 1. State and inputs

State: position (x, z), heading, heel, pitch, body velocity (surge u, sway v), yaw rate, heel rate, pitch rate.
Pitch is positive bow up; heel remains absolute/gravity-relative, positive starboard rail down.
Velocity is relative to mean still water, not the instantaneous orbital flow.
Inputs, all normalized and rate-limited upstream in `input/`:
- tiller (-1..1), mapped to rudder angle
- mainsheet (0..1), mapped to boom angle limit (more sheet out = larger boom angle)
- hike (0..1), mapped to crew weight offset outboard

## 2. Layers (build in this order, one at a time)

### L1. Apparent wind
`apparentWind = trueWind(position, time) - boatVelocity` (as vectors, in the world frame),
recomputed every step. Then express it in the body frame: apparent wind speed (AWS) and
apparent wind angle (AWA). Everything downstream depends on this.

`trueWind` must come from `getWind(position, time)`. In v1 it returns a constant 6-8 kn vector
from a configurable direction. Do not hardcode wind anywhere else.

### L2. Sail as a foil
- Angle of attack alpha = AWA minus boom angle (mind the sign on each tack).
- Force magnitudes: `L = 0.5 * rhoAir * AWS^2 * A * CL(alpha)`, `D = 0.5 * rhoAir * AWS^2 * A * CD(alpha)`.
- **Coefficient source:** Day 2017, Table 1 (p3 of the PDF), "ORC Low Lift mainsail coefficients", tabulated against
  **apparent wind angle beta** (0/7/9/12/28/60/90/120/150/180 degrees), not against angle of attack. **[ref]**
  Transcribe the CL and CD rows into `data/sail-coefficients.json` from the page image, not the text layer.
- **Design decision (not from the paper):** a table indexed by beta assumes the sail is trimmed well for that angle.
  The sim has a free sheet, so bad trim must cost something. Treat the table as the **best-trim envelope**:
  lift and drag peak near the table values when the angle of attack is near its best, and fall off when the sail is
  over-sheeted (stall) or under-sheeted (luffing). The falloff shape and the best-trim angle are **[tune]**.
- Lift acts perpendicular to the apparent wind, drag along it. Project onto the body frame
  to get drive force (surge) and side force (sway), and a heeling component.
- Centre of effort height above the waterline sets heeling moment and weather helm lever arms.
  Position fore/aft sets the yaw moment. **[ref]** from the sail plan in the class rules.
- Sail area: 7.06 m^2 **[sourced]**.
- `luffAmount` (0..1): rises as alpha approaches zero or goes negative (sail not filled).
  Output for the renderer and telltales only. It also collapses lift in the model. **[tune]** thresholds.
- Light wind: no depowering needed in v1. Add it when stronger wind is introduced.

### L3. Hydrodynamic foils (daggerboard, hull lateral area, rudder)
- Lateral force from leeway angle (angle between heading and the direction of travel through the water).
  This is what lets the boat make ground upwind.
- Lift slope from foil aspect ratio and area **[ref]**, with a stall limit.
- Induced drag proportional to lift squared over aspect ratio.
- Rudder angle adds a second foil with its own lift and drag, acting at the stern.
- Daggerboard and rudder areas and positions: **[ref]** class rules / Day 2017.

### L4. Hull resistance
- Frictional resistance (ITTC-1957 style or the method Day uses) plus residuary resistance as a function
  of Froude number. **[ref]**
- v1 is displacement mode only. Hull speed is about 1.34 * sqrt(LWL in feet) knots, which is a sanity check only, not a limit to hardcode.
- Resistance also depends on heel and leeway. Add after L5.

### L5. Heel and hiking
- Heeling moment = sail heeling force x centre-of-effort height (reduced by cos(heel)).
- Righting moment = hull form stability + crew weight x hiking lever arm. Day 2017 discusses crew weight
  and decoupling heel angle from heeling moment. **[ref]**
- Sailor mass is a parameter, not a constant. **[tune]**
- v1: no capsize. Heel angle clamps at a limit. **[tune]**
- Heel feeds back: it reduces projected sail area / effective force and changes lateral resistance.

### L6. Yaw dynamics
- Yaw moment balance from sail centre of effort versus lateral plane centre, plus rudder moment.
  This gives weather helm. Day 2017 stresses yaw moment equilibrium. **[ref]**
- Include added mass in sway and yaw and rotational damping so the boat does not spin like a top.
  Values **[tune]** unless a reference gives them.

### L7. Environment and waves
- v1 wind is fixed. Gusts, shifts, and wind gradient with height are later drop-ins behind `getWind`.
- `sim/waves.ts` is the shared Gerstner model for CPU and shader. `data/waves.json` holds the spectrum,
  controls' bounds, pitch response and water mesh settings, with sources or **TUNING GUESS** labels.
- Each component uses `k = 2 pi / L`, `omega = sqrt(g k)`, and phase
  `theta = k D dot q - omega t + phase0`, where D is a compass direction **TO**, not wind FROM.
  Particle position is `(q.x + Q A D.x cos(theta), A sin(theta), q.z + Q A D.z cos(theta))`.
  Source: GPU Gems chapter 1, section 1.2.3, Eqs. 9 and 13 (web link in `INDEX.md`).
- World-position sampling inverts horizontal displacement; surface slopes account for that mapping's
  Jacobian, rather than evaluating a sine height at an undisplaced world point.
- Orbital velocity is the particle time derivative:
  `(Q A omega D.x sin(theta), -A omega cos(theta), Q A omega D.z sin(theta))`.
  At depth below the local surface, each component's amplitude decays by `exp(-k depth)`.
  Q = 1 gives circular single-component orbits with speed `A omega exp(-k depth)`;
  the current spectrum uses smaller Q for gentler horizontal displacement.
  Superposition and local-surface depth handling are approximations, not an exact nonlinear fluid solution.
- Roll target is `-atan(slope dot starboard)`; pitch target is `atan(slope dot forward)`.
  Hull-form restoring acts against heel relative to the surface. Crew righting remains gravity-relative:
  add `mass g GM [sin(heel) - sin(heel - rollTarget)]` to the existing moment.
  This local-slope buoyancy approximation is **TUNING GUESS**, not a measured response operator.
- Pitch is a damped oscillator driven by the longitudinal slope, with frequency, damping and limit in
  `waves.json` (**TUNING GUESS**). Disabling the heel layer disables both roll and pitch response.
- Board and rudder sample orbital flow separately at their transformed positions and depths.
  Ambient velocity is projected into foil axes and subtracted from local inflow before lift/drag and
  downwash evaluation. Existing foil moments produce course changes: no artificial heading kick.
  Force integration remains the existing planar model; pitch influences geometry/inflow, not full 6-DOF dynamics.
- Rendering uses interpolated sim time, the same compiled wave components and sampled surface height.
  The central 32 m patch has 0.20 m cells; outer cells grow toward the horizon. Recentring is continuous,
  not a 5 m snap. The shared GLSL kernel accepts a sampling footprint: zero reproduces CPU math;
  nonzero smoothly filters unresolved components (full at 8 samples/wavelength, zero below 4).
  Geometry uses actual adjacent cell dimensions; analytic fragment normals use pixel derivatives.
  The specular lobe broadens with pixel normal variance while preserving its integrated energy.
  These are render-only LOD/antialiasing approximations, not changes to the physical spectrum.
  Rendering has a continuous floating origin at the interpolated boat's logical x/z position.
  Boat/cameras/water/debug arrows stay render-local; fixed buoy transforms compose in JS doubles
  before matrix upload. The flat-water grid subtracts the same origin after its logical-world snap.
  CPU surface sampling, forces, integration and navigation coordinates are not rebased.
  `wavePhaseAt` reduces `k D dot origin - omega t + phase0` to [-pi, pi] in double precision.
  GLSL adds `k D dot localLabel` to that reduced phase. Its `waveMotion` uniform contains
  `(origin/time phase, choppiness)`, not omega/time; large coordinates and elapsed time never
  enter shader float32 arithmetic. This is a phase reparameterization, not a second wave field.
  Heave is kinematic only. Hull drag still uses the flat-water resistance model; no wave-added resistance,
  breaking waves, wet/dry foil area, slamming, or capsize is modeled.

**Controls and compatibility**
- Browser waves default on; `defaultConfig()` and the polar script default off.
- Backquote / F3 opens the debug panel: waves checkbox, overall amplitude 0-2, separate `big waves`
  and `ripples` multipliers 0-2, broad period at reference wind 2-8 s, and direction TO in degrees.
- Three broad components (reference wavelengths 18/10.7/7.3 m) and eight ripple components
  (reference wavelengths 2.17/1.9/1.29/1.13/0.81/0.71/0.49/0.43 m) share the Gerstner model.
  Each component has a seeded strength factor 0.65-1.35 and an additional phase offset.
  Ripple wavelengths additionally vary by +/-18% and directions by +/-9 degrees at compilation.
  The ripple band is downwind-biased rather than widely crossing, to avoid square crosshatching;
  nearby unequal wavelengths create beat groups. Unseeded ripple height variance is approximately
  preserved by splitting each prior component's amplitude between two weaker waves. These values
  are TUNING GUESS, not a measured directional spectrum; broad components are unchanged.
  Browser seed changes on reload, not during sailing or when adjusting sea controls.
- Reference wind is 7 kn. For ratio `r = windKn / 7`, broad amplitudes scale by `r^2`, periods by
  `max(0.35, r)^0.35`; ripple amplitudes by `r^1.25`, lengths by `max(0.35, r)^0.5`.
  All these exponents, bands and spreads are **TUNING GUESS**. Dispersion remains `omega^2 = g k`.
  Broad period changes only the broad band; ripple length remains independently wind-driven.
  Direction rotates both bands and remains a separate control, permitting crossing seas.
- Wind controls cover 0-16 kn. Zero wind removes both locally generated bands; this does not model
  remote swell persisting after wind stops. Fetch, duration, remote weather and capillary dispersion
  are absent. Strong-wind boat performance is not validated.
- The overall amplitude is limited when necessary to keep `sum(Q k A) <= 0.6`, preventing horizontal
  folding and retaining contractive CPU inverse lookup. L7 shows the effective multiplier and actual
  wind-adjusted broad period. Near calm or with both layer multipliers zero, the flat-water path applies.
- Wind/period/layer changes recompile the spectrum only on control changes. Wind-setting owners call
  `setWaveWind` alongside true-wind changes: browser controls and each headless polar wind-speed run
  do this. CPU physics and GPU uniforms read the same compiled components.
- Zero amplitude and waves off take the exact pre-wave force path, with pitch/pitch rate zero.
  Switching off does not rewind motion already induced by waves; reset to compare trajectories.
- Browser checking parameters: `?waves=0`, `waveAmplitude=0..2`, `wavePeriod=2..8`, `waveDirection=degrees`.
- Polar options: `--waves`, `--wave-amplitude`, `--wave-period`, `--wave-direction`. Periodically forced
  waves-on runs are not a validated steady-state polar; `--wave-period` sets the reference-wind broad
  period. Use the script's default waves-off mode for Day comparisons.

**Layered sea status and manual checks**
- The initial layered-sea change did not run automated tests, build or headless polars, at the user's
  request at that time. A brief browser smoke loaded both bands and the new controls; changing wind
  from 7 to 12 kn updated the actual broad period from about 3.40 to 4.10 s without reported errors.
- Manual checks: at 7 kn isolate broad waves (`ripples = 0`) and then ripples (`big waves = 0`).
  Restore both to 1; compare wind 3/7/12 kn, then 0 kn. Overall amplitude 0 and waves off should
  flatten the water. Reload for a new seeded pattern; simply sailing should not regenerate it.
- Fine ripples fade with distance according to mesh/pixel filtering. Start tuning near the boat,
  not at the fog horizon. If overly busy, lower ripples; if overly striped, try big waves 0.7 and
  ripples 1.5. Global amplitude controls overall roughness; broad period does not resize ripples.
- The measurements below are historical checks of the earlier three-component spectrum,
  not verification of the new layered spectrum or wind-response calibration.

**Ripple-pattern repair verification**
- Headless 16 m ripple-only slope maps were generated from the actual CPU surface and inspected at
  equal contrast: eight weaker, mostly downwind components reduce the former crossing lattice and
  form unequal crest groups. This is a CPU field preview, not a browser/GPU image; no browser checks
  were run at the user's request. Final lighting, filtering and target-GPU performance remain unchecked.
- At seed 1987 and 7 kn, ripple RMS height changes from 6.93 to 6.79 mm; transverse-to-downwind slope
  energy ratio drops from 0.509 to 0.0675. These are diagnostic field measurements, not realism targets.
- A 36-case seed/wind/direction smoke at maximum layer/overall controls keeps samples finite and
  sum(Q k A) <= 0.6 to floating-point precision. New regression verifies that control round-trips
  preserve the seeded ripple field and that rotating sea direction rotates its slopes and orbital flow.
- Build, lint and all 92 tests pass. Default waves-off 6/7/8-kn polars (TWA 30-180, 5-degree steps)
  have byte-identical CSV and SVG before/after. Wave-enabled motion can change because the shared
  fine-ripple spectrum changed; this is not a new empirical calibration of wave response.

**Verification (original water/waves change)**
- Pre/post waves-off CSV and SVG match byte-for-byte for 6/7/8/9 kn, TWA 30-180 in 5-degree steps.
- Regression tests cover inverse surface lookup/gradients, particle velocity derivatives, depth decay,
  zero-amplitude equivalence, signed roll/pitch, mirrored side-wave steering, distinct foil sampling and toggles.
- GPU transform-feedback smoke: 243 samples over period/direction/amplitude/time/position;
  maximum CPU/GPU position difference about 4.33e-6 m and normal-component difference about 3.16e-6.
- Isolated default single-wave slope `pi H/L = k A = 3.6 degrees`: settled roll amplitude about
  6.22 degrees and pitch about 2.35 degrees. Board/rudder side-flow peaks 0.22846/0.24154 m/s
  match `A omega exp(-k depth)` at their respective depths.
- Eighteen 60-second period/amplitude/direction scenarios remain finite and within angle clamps.
  Extreme settings can reach the heel clamp; this is not proof of realistic heavy-sea response.
  Halving dt in a default 30-second run changes heading about 0.006 degrees, heel 0.033 degrees,
  pitch 0.007 degrees and position 0.014 m.
- Browser smoke exercised moving water, outside/cockpit views, live controls, zero amplitude and off.
  These initial checks did not include distant coordinates; see the floating-origin checks below.
  No measured Laser wave-response validation or target-laptop GPU qualification has been done.

**Boat wake and bow wave (render only; not part of the physics)**
- The boat's own wake does not feed back: no added resistance, no forces on the boat or other objects.
  It only displaces the water surface and normals in `render/water.ts` on top of the shared Gerstner sea.
- Source strength comes from energy balance with the sim's own wave-making resistance: the Delft residuary
  `R_rc` at the boat's surge speed (`hull.ts` `delftUpright`) equals the energy density `1/2 rho g A^2`
  left per metre of track times an effective width (1.0 x beam, TUNING GUESS). R_rc also contains viscous
  pressure drag, so this is an upper estimate.
- Pattern: stationary Kelvin wake in trail coordinates (s behind the waterline stem, n off the track).
  Deep-water dispersion gives transverse `k = g/V^2` and cusp waves `k = g/(V cos 35.26 deg)^2`, with
  arms at the 19.47 degree half-angle. Decay exponents s^-1/3 (divergent) and s^-1/2 (transverse),
  envelope widths and age decay are TUNING GUESS. Footprint filtering matches the water grid (full at 8
  samples per wavelength, none below 4).
- Bow wave height is `bowHeadFrac V^2/2g` (`bowHeadFrac = 0.2`, TUNING GUESS fraction of stagnation
  head). The chevron and bow foam start at the foremost sampled hull/sea contact. Cached loft sections
  transform in the boat mesh's heel/pitch/yaw order; the search samples the local Gerstner surface at
  those transformed horizontal positions, including heave. The contact moves aft when the bow lifts,
  forward when it drops and sideways under heel; no clearance fade. Entirely dry sampled hulls produce
  no bow wave; a submerged stem still produces one. The stern/Kelvin trail is unchanged.
  Foam = noisy world-anchored pattern behind the transom and on the bow crest; the upright hull mask
  applies to stern foam, not the moving bow crest.
- The trail is a 30 m world-anchored polyline of the stem (a point per 0.75 m). The wake is straight
  segments between points, so it follows turns but is not a fluid simulation; it cannot interact with waves.
- Status: unit tests cover the trail, the pattern geometry and the source balance. A browser pass (outside
  views from the side, bow quarter and behind; 4.4 kn, wave amplitude 0.4) showed the shader compiles
  without console errors. Two fixes came out of it: the foam was a string of blobs (now boosted to a
  continuous streak) and the physical 1-3 cm Kelvin waves and bow wave were nearly invisible next to the
  sea, so `wake.json` has a render-only `visualGain` (3) on the Kelvin amplitude and `bowHeadFrac` is 0.5.
  Both are TUNING GUESS, chosen for readability, not realism. Not yet checked: cockpit view, turns/tacks,
  other speeds, frame cost.
- Current render gain is 1.5 and bowHeadFrac is 0.2, reduced after the original pass described above.
- Contact repair verification: actual `WakeView.update` exercised headlessly; at 2 m/s, 10 degrees
  bow-up moves the contact about 1.5 m aft with bow height unchanged at 0.0408 m. A deterministic
  240-frame 16-kn sea sweep retains wet contact throughout. Contact regressions cover lift/drop,
  mirrored heel, dry/submerged/re-entry transitions and world-position wave intersection. Build,
  lint and all 91 tests pass. No browser checks for this continuation, at the user's request.
  This is a sampled geometric attachment, not fluid/slamming physics; the bow chevron remains
  symmetric about a single foremost contact and its appearance has not been revalidated.

**Rendering repair verification**
- Isolated water-only scene, fixed camera and time: the original 2 cm crossing of a 5 m snap boundary
  changed 25,002 pixels by more than 2 RGB levels at default chop (mean RGB difference 0.669 on a
  0-255 scale). Within-cell motion changed zero pixels. Shortest-period crossing changed 72,581 pixels.
- With identical isolated camera/environment, the repaired default crossing changes 53 pixels,
  mean 0.00562; the neighboring 2 cm movement has mean 0.00553. Shortest-period means are
  0.02829 across the former boundary and 0.02891 next to it. No special discontinuity remains.
- A 162-case sweep covers three camera poses, periods 2/default/8 s, amplitude 0/1/2, three directions,
  and x/z crossings. Worst crossing-to-neighbor mean-change ratio is 1.091.
- Three 240-frame moving-wave/moving-mesh sequences (default and control extremes) cross multiple
  former boundaries without boundary spikes. A 6-second isolated recording and 10-second actual
  outside/cockpit recording were captured and inspected. No shader/JS errors were reported.
- GPU transform feedback: 486 samples match CPU displacement/normals at zero footprint and the
  actual near-boat 0.20 m footprint across period/direction/amplitude/time/position. Maximum errors:
  4.33e-6 m position, 3.16e-6 normal component. Filter transition/endpoints also exercised on the GPU.
- Waves-off CSV and SVG again match the pre-wave 6/7/8/9 kn baseline byte-for-byte.
  Existing 73 tests, lint, typechecking and production build pass.
- Far-field rendering is deliberately band-limited and is not an exact unfiltered surface there.
  No new empirical Laser calibration or target-GPU qualification.

**Floating-origin verification**
- Before rebasing, the actual water renderer visibly flattened out at `(1e9, -1e9)` m.
  After rebasing, the rendered surface remains present; boat x/z is zero and both cameras stay nearby.
- GPU transform feedback: 7,344 samples over periods 2/default/8 s, directions 0/90/225 degrees,
  amplitudes 0/1/2, coordinates through +/-1e9 m, and times through 1e7 s. Zero and actual 0.20 m
  footprints plus phase-wrap transitions exercised. Maximum CPU/GPU position difference 1.36e-6 m,
  normal-component difference 1.16e-6; no WebGL error.
- 324 isolated fixed-world image comparisons change only render origin (2 cm, 5 m and larger shifts),
  preserving logical camera, geometry and time. Worst mean RGB difference 0.000211 on a 0-255 scale;
  at most six pixels exceed two RGB levels. Not pixel-identical: isolated differences reach 33 levels.
- Three 120-frame moving-water sequences at +/-1e9 m and elapsed time near 1e7 s cover default chop
  and both period/amplitude extremes. Nine former grid-snap crossings and 25 reduced-phase wraps
  show no special spikes: worst crossing/neighbor change ratio 0.9992, wrap/neighbor ratio 1.0007.
  Distant water was recorded; actual-game outside/cockpit views and live wave controls were exercised.
- 24 scene-consumer cases check cameras, logical buoy anchors (including a distant marker), true-wind
  and body-force arrows, wave heave, waves-off grid bounds, and no mutation of state/config/diagnostics.
- Waves-off CSV/SVG remain byte-identical to the original 6/7/8/9 kn baseline. All 75 tests pass,
  including new distant/long-time phase and phase-wrap regressions; lint, typechecking and build pass.
- Coordinates/time were exercised synthetically, not by running a multi-month sailing session.
  CPU double precision is still finite; this is not an unlimited-distance guarantee or target-GPU
  performance qualification. Physical wave-response calibration and far-field filtering limits remain.

## 3. Boat parameters (`data/laser.json`)

| Parameter | Value | Status |
|---|---|---|
| Length overall | 4.23 m | [sourced] |
| Waterline length | 3.81 m | [sourced] |
| Beam | 1.37 m | [sourced] |
| Draught, daggerboard down | 0.787 m | [sourced] |
| Sail area | 7.06 m^2 | [sourced] |
| Boat mass without sail | 79.5 kg measured | [ref] Day 2017 p8 (hull-only about 58-59 kg per listings) |
| Mast, boom, sail edges | upper mast max 3600 mm, ILCA 7 lower mast max 2865 mm (p33), boom max 2740 mm (p34), sail edges luff 5130 / leech 5570 / foot 2740 mm for MKI (p36) | [ref] ILCA class rules (MKII on p37) |
| Hull shape for procedural generation | | Not in class rules (they defer to the ILCA Build Manual). Approximate from length, beam, waterline, draught. |
| Daggerboard and rudder geometry | board max 680 x 341, max thickness 33 mm, R=60 (p28); rudder p28 | [ref] ILCA class rules. Rudder drawing is ambiguous about which edge each length follows, so verify. |
| Sail coefficients CL, CD | Table 1, indexed by apparent wind angle | [ref] Day 2017 p3 |
| Air density | 1.225 kg/m^3 | standard, configurable |
| Water density | 1025 kg/m^3 (sea) or 1000 (fresh) | configurable |
| Sailor mass | | [tune], parameter |

## 4. Dead reckoning (nav, not sim)

The DR marker lives in `nav/`, separate from the true state.
- Integrates compass heading x logged speed over time.
- **Ignores leeway** and applies a small speed-log bias and noise **[tune]**, so it drifts.
- Corrected by a bearing fix to a buoy (mechanic defined in milestone 5).
- It must never read the true position except for the debug toggle.

## 5. Validation

Do not tune by feel. Validate against numbers.

`scripts/polar.ts` (headless, Node):
1. Fix true wind at 7 kn (and test 6 and 8).
2. For each true wind angle from 30 to 180 degrees in steps, hold a fixed heading with the sheet set to the
   best trim for that angle (search over sheet), run to steady state, record boat speed and leeway.
3. Output a CSV and a plot of speed vs true wind angle.

Checks:
- **No-go zone:** the boat cannot hold speed pointing too close to the wind. Expected close-hauled
  true wind angle is around 40-45 degrees, to be compared with Day 2017's VPP results (Figs 4-7, 9 and 12 kn). **[ref]**
- **Peak speed** is on a beam to broad reach, and dead downwind is slightly slower than the peak.
- **In irons:** pointing into the wind, the boat slows and eventually drifts backward.
- **Tack and gybe:** speed is lost and recovered plausibly. No instant turns.
- **Stability:** no energy growth, no jitter at rest, results do not change with the timestep.
- **Absolute speeds:** Day 2017 has no results at 6-8 kn. It has measured data at 12-12.5 kn (Fig 3) and VPP output at 9 and 12 kn
  (Figs 4-7, where upwind agreement is reported as excellent). Validate shape and upwind speed at 9 kn, with 6-8 kn as
  extrapolation. Planing is not modeled in v1, so do not expect a match on fast reaches at 12 kn.

If the polar shape is wrong, fix the sail curves (L2) first, then the foils (L3), before touching anything else.

## 6. Debug overlay (always keep current)

Apparent wind vector, true wind vector, sail force components, foil forces, hull drag, boat speed, leeway angle,
heel, `luffAmount`, current inputs. Wave diagnostics include surface height, roll/pitch targets,
pitch, wave roll moment and separate board/rudder orbital inflows. Toggle with a key. Off by default in normal play.
