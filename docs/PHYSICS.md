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

State: position (x, z), heading, heel, body velocity (surge u, sway v), yaw rate, heel rate.
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

### L7. Environment (deferred)
- v1 wind is fixed. Gusts, shifts, and wind gradient with height are later drop-ins behind `getWind`.
- Waves are visual only in v1. Later the same Gerstner function is evaluated in `sim/` for pitch and roll.

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
heel, `luffAmount`, current inputs. Toggle with a key. Off by default in normal play.
