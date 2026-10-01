/**
 * L4 Hull resistance (PHYSICS.md L4).
 *
 * Upright, two models (cfg.models.uprightResistance):
 *  - 'delft' (default): friction + residuary.
 *      Friction: ITTC-1957, Rn on 0.7 Lwl, wetted area from Larsson Fig 4.2
 *      (Larsson & Eliasson p64, PDF p80, Fig 5.8): R_F = Cf 1/2 rho V^2 Sw.
 *      Residuary: Keuning & Katgert Eq. 1.7 / Table 2 (docs/bare_hull_resistance.pdf p6,
 *      = Day 2017 Eq. 10, PDF p6) with the Laser form ratios of Day Table 2:
 *        Rrh = (Rrh / (Vc rho g))(Fn) * Vc rho g, splined in Fn over 0.15-0.75, held above 0.75.
 *      Below Fn 0.15: Rrh(0.15) (Fn/0.15)^2, TUNING GUESS blend to zero.
 *  - 'tank': Day 2017 Fig. 2 (PDF p7) bare-hull tank drag area at 160 kg level trim;
 *      R = 1/2 rho V^2 * dragArea. APPROXIMATE (read off the plot). Linear interpolation,
 *      held constant outside 2-9 kn. Day uses this instead of Delft (section 3.2).
 *
 * Heel: Larsson & Eliasson p83 (PDF p99), Fig 5.26 (Delft):
 *   C_H = [6.747 (Tc/T) + 2.517 (Bwl/Tc) + 3.710 (Bwl/Tc)(Tc/T)] 1e-3
 *   R_H = 1/2 rho V^2 Sw C_H Fn^2 phi      (phi in rad)
 *
 * Crossflow: TUNING GUESS. Strip-wise drag on the canoe-body lateral area when the
 * hull slides sideways (Cd from laser.json), needed when the board is stalled or
 * the boat is stopped. Includes the yaw-rate velocity along the hull.
 */
import type { BoatModel } from '../boat';
import type { EnvironmentConfig, ModelOptions, TermToggles } from '../config';
import { G, KNOT } from '../frames';
import { ittcFriction } from '../friction';
import type { BoatState } from '../state';

export interface HullResult {
  fx: number;
  fy: number;
  yawMoment: number;
  heelMoment: number;
  upright: number;
  /** Parts of `upright` for the 'delft' model (0 for 'tank'). */
  friction: number;
  residuary: number;
  heelResistance: number;
  crossflow: number;
}

const CROSSFLOW_STRIPS = 8;

/** Linear interpolation in a {speedKn, dragAreaM2} table, held constant at the ends. */
export function tableDragArea(t: { speedKn: number[]; dragAreaM2: number[] }, speed: number): number {
  const kn = Math.abs(speed) / KNOT;
  const xs = t.speedKn;
  const ys = t.dragAreaM2;
  if (kn <= xs[0]!) return ys[0]!;
  const last = xs.length - 1;
  if (kn >= xs[last]!) return ys[last]!;
  let i = 0;
  while (kn > xs[i + 1]!) i++;
  const f = (kn - xs[i]!) / (xs[i + 1]! - xs[i]!);
  return ys[i]! + f * (ys[i + 1]! - ys[i]!);
}

/** Delft upright resistance split into friction and residuary, N (both >= 0 for forward speed). */
export function delftUpright(boat: BoatModel, speed: number, env: EnvironmentConfig): { friction: number; residuary: number } {
  const v = Math.abs(speed);
  const h = boat.cfg.hull;
  const rn = (v * h.frictionLengthFrac * boat.lwl) / env.nuWater;
  const friction = ittcFriction(rn) * 0.5 * env.rhoWater * v * v * boat.wettedArea;
  const fn = v / Math.sqrt(G * boat.lwl);
  const weight = boat.volume * env.rhoWater * G;
  const fnLow = h.residuaryBlendFn;
  const residuary =
    fn >= fnLow
      ? boat.residuaryRatio.at(fn) * weight
      : boat.residuaryRatio.at(fnLow) * weight * (fn / fnLow) ** h.residuaryBlendExponent;
  return { friction, residuary };
}

export function heelResistanceCoefficient(boat: BoatModel): number {
  const bwlTc = boat.cfg.hull.table2.bwlOverTc;
  const tcT = boat.tc / boat.cfg.hull.draughtBoardDown;
  return (6.747 * tcT + 2.517 * bwlTc + 3.71 * bwlTc * tcT) * 1e-3;
}

export function hullForces(
  state: BoatState,
  boat: BoatModel,
  env: EnvironmentConfig,
  terms: TermToggles,
  models: ModelOptions,
): HullResult {
  const rho = env.rhoWater;
  const u = state.u;
  const q = 0.5 * rho * u * u;
  let friction = 0;
  let residuary = 0;
  let upright: number;
  if (models.uprightResistance === 'delft') {
    ({ friction, residuary } = delftUpright(boat, u, env));
    upright = friction + residuary;
  } else {
    upright = q * tableDragArea(boat.cfg.hull.uprightDragArea, u);
  }

  let heelResistance = 0;
  if (terms.heelResistance) {
    const fn2 = (u * u) / (G * boat.lwl);
    heelResistance = q * boat.wettedArea * heelResistanceCoefficient(boat) * fn2 * Math.abs(state.heel);
  }

  let fy = 0;
  let yawMoment = 0;
  if (terms.crossflowDrag) {
    const dx = boat.lwl / CROSSFLOW_STRIPS;
    const k = 0.5 * rho * boat.cfg.hull.crossflowCd * boat.tc * dx;
    for (let i = 0; i < CROSSFLOW_STRIPS; i++) {
      const x = -boat.lwl / 2 + (i + 0.5) * dx;
      const vl = state.v + state.r * x;
      const f = -k * vl * Math.abs(vl);
      fy += f;
      yawMoment += x * f;
    }
  }

  const fx = -Math.sign(u) * (upright + heelResistance);
  // Crossflow acts at about half the canoe-body draft.
  return { fx, fy, yawMoment, heelMoment: (-boat.tc / 2) * fy, upright, friction, residuary, heelResistance, crossflow: fy };
}
