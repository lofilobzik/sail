/**
 * L4 Hull resistance (PHYSICS.md L4).
 *
 * Upright: Day 2017 section 3.2 (PDF p6) uses the Laser tank data directly instead
 * of the Delft regression. Fig. 2 (PDF p7) gives bare-hull drag area vs speed at
 * 160 kg level trim; R = 1/2 rho V^2 * dragArea. Values read off the plot are
 * APPROXIMATE. Linear interpolation; held constant outside 2-9 kn.
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
import type { EnvironmentConfig, TermToggles } from '../config';
import { G, KNOT } from '../frames';
import type { BoatState } from '../state';

export interface HullResult {
  fx: number;
  fy: number;
  yawMoment: number;
  heelMoment: number;
  upright: number;
  heelResistance: number;
  crossflow: number;
}

const CROSSFLOW_STRIPS = 8;

export function uprightDragArea(boat: BoatModel, speed: number): number {
  const t = boat.cfg.hull.uprightDragArea;
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

export function heelResistanceCoefficient(boat: BoatModel): number {
  const bwlTc = boat.cfg.hull.table2.bwlOverTc;
  const tcT = boat.tc / boat.cfg.hull.draughtBoardDown;
  return (6.747 * tcT + 2.517 * bwlTc + 3.71 * bwlTc * tcT) * 1e-3;
}

export function hullForces(state: BoatState, boat: BoatModel, env: EnvironmentConfig, terms: TermToggles): HullResult {
  const rho = env.rhoWater;
  const u = state.u;
  const q = 0.5 * rho * u * u;
  const upright = q * uprightDragArea(boat, u);

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
  return { fx, fy, yawMoment, heelMoment: (-boat.tc / 2) * fy, upright, heelResistance, crossflow: fy };
}
