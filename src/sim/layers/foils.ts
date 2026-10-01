/**
 * L3 Hydrodynamic foils: daggerboard and rudder (PHYSICS.md L3).
 *
 * Lift, Day 2017 Eqs. 11-12 (PDF p6), after Keuning and Verwerft:
 *   L_k = dCL/da * c_hull * c_heel * alpha_eff,k * 1/2 rho V_k^2 * A_lat,k
 *   L_r = dCL/da * c_hull * c_heel * alpha_eff,r * 1/2 rho V_r^2 * A_lat,r
 * (Eq. 12 as printed says c_keel; read as c_heel, the same factor as Eq. 11.)
 *   dCL/da = 5.7 AR_E / (1.8 + cos(L) sqrt(AR_E^2/cos^4(L) + 4)),  AR_E = 2 b / c
 *   c_hull = 1 + 1.80 (Tc / b),  c_heel = 1 - 0.382 phi  (phi in rad)
 *   alpha_eff,k = lambda - lambda0,  lambda0 = (0.405 (Bwl/Tc) phi)^2
 *   alpha_eff,r = lambda - lambda0 - delta_r - Phi,  Phi = a0 sqrt(CL_k / AR_eff,k)
 *   V_k = boat speed, V_r = 0.9 boat speed (Day p7)
 * Stall: CL limited to clMax (Larsson & Eliasson Fig 6.6, approximate), then a
 * TUNING GUESS linear decay to zero at 90 degrees plus post-stall pressure drag.
 *
 * Drag:
 *  - Friction, ITTC-1957 line (Day p6; Larsson & Eliasson Fig 5.8, PDF p80):
 *      Cf = 0.075 / (log10(Rn) - 2)^2, Rn on the mean chord, wetted area 2 A,
 *    times a form factor (1 + k), k TUNING GUESS.
 *  - Induced, Day 2017 Eq. 16 (PDF p7): CDi = CL^2 / (pi AR_E), AR_E = AR e (Eq. 17),
 *    AR including the free-surface image, times cos^2(phi) for heel (Day p7).
 *    Day uses Eq. 16 for the rudder and the Delft Eq. 15 for the hull + board; the
 *    Eq. 15 coefficient table is not in docs/, so Eq. 16 is used for the board too.
 *
 * Side force from the canoe body is carried by c_hull ("lift carry-over"), as in Day.
 * Local inflow at each foil includes yaw rate (r x) and heel rate (p z).
 */
import type { BoatModel, FoilModel } from '../boat';
import type { EnvironmentConfig, TermToggles } from '../config';
import { DEG } from '../frames';
import type { BoatState, Controls } from '../state';

export interface FoilForce {
  fx: number;
  fy: number;
  lift: number;
  drag: number;
  cl: number;
  /** Effective angle of attack, rad. */
  alpha: number;
  stalled: boolean;
}

export interface FoilsResult {
  fx: number;
  fy: number;
  heelMoment: number;
  yawMoment: number;
  board: FoilForce;
  rudder: FoilForce;
  /** Rudder angle, rad (+ = leading edge to starboard, i.e. tiller to starboard). */
  rudderAngle: number;
  lambda0: number;
  downwash: number;
}

/** ITTC-1957 friction line. Rn is floored at 1e5 (TUNING GUESS) where the line is not valid. */
export function ittcFriction(rn: number): number {
  const l = Math.log10(Math.max(rn, 1e5)) - 2;
  return 0.075 / (l * l);
}

/** Incidence of a flow line on the foil's centreline, folded into [-pi/2, pi/2]. */
function lineAngle(u: number, v: number): number {
  let a = Math.atan2(v, u);
  if (a > Math.PI / 2) a -= Math.PI;
  else if (a < -Math.PI / 2) a += Math.PI;
  return a;
}

export function foilLiftCoefficient(foil: FoilModel, alpha: number, cHeel: number, clMax: number): { cl: number; stalled: boolean } {
  const slope = foil.liftSlope * foil.cHull * cHeel;
  const linear = slope * alpha;
  if (Math.abs(linear) <= clMax) return { cl: linear, stalled: false };
  const alphaStall = clMax / slope;
  const decay = Math.max(0, 1 - (Math.abs(alpha) - alphaStall) / (Math.PI / 2 - alphaStall));
  return { cl: Math.sign(alpha) * clMax * decay, stalled: true };
}

function foilForce(
  foil: FoilModel,
  u: number,
  vLocal: number,
  speedFactor: number,
  incidenceOffset: number,
  cHeel: number,
  heel: number,
  boat: BoatModel,
  env: EnvironmentConfig,
): FoilForce {
  const fc = boat.cfg.foil;
  const flowSpeed = Math.hypot(u, vLocal);
  if (flowSpeed < 1e-6) return { fx: 0, fy: 0, lift: 0, drag: 0, cl: 0, alpha: 0, stalled: false };
  const speed = flowSpeed * speedFactor;
  const alpha = lineAngle(u, vLocal) - incidenceOffset;
  const { cl, stalled } = foilLiftCoefficient(foil, alpha, cHeel, fc.clMax);

  const q = 0.5 * env.rhoWater * speed * speed;
  const cf = ittcFriction((speed * foil.chord) / env.nuWater);
  const cdFriction = 2 * cf * (1 + fc.formFactorK);
  const cdInduced = (cl * cl) / (Math.PI * foil.aspectRatioImage * foil.efficiency * Math.cos(heel) ** 2);
  const alphaStall = fc.clMax / (foil.liftSlope * foil.cHull * cHeel);
  const cdStall = stalled ? fc.postStallCdMax * (Math.sin(alpha) ** 2 - Math.sin(alphaStall) ** 2) : 0;
  const lift = q * foil.area * cl;
  const drag = q * foil.area * (cdFriction + cdInduced + Math.max(cdStall, 0));

  // Flow direction relative to the boat and the lift direction (rotated +90 deg).
  const fxDir = -u / flowSpeed;
  const fyDir = -vLocal / flowSpeed;
  return {
    fx: lift * -fyDir + drag * fxDir,
    fy: lift * fxDir + drag * fyDir,
    lift,
    drag,
    cl,
    alpha,
    stalled,
  };
}

export function foilForces(
  state: BoatState,
  controls: Controls,
  boat: BoatModel,
  env: EnvironmentConfig,
  terms: TermToggles,
): FoilsResult {
  const heel = state.heel;
  const cHeel = 1 - 0.382 * Math.abs(heel);
  const lambda0 = terms.zeroLiftDrift ? Math.sign(heel) * (0.405 * boat.cfg.hull.table2.bwlOverTc * heel) ** 2 : 0;

  const b = boat.board;
  const vBoard = state.v + state.r * b.x + state.p * b.z;
  const board = foilForce(b, state.u, vBoard, 1, lambda0, cHeel, heel, boat, env);

  const downwash = terms.downwash
    ? Math.sign(board.cl) * boat.cfg.foil.downwashA0 * Math.sqrt(Math.abs(board.cl) / (b.aspectRatioImage * b.efficiency))
    : 0;
  const rd = boat.rudder;
  const rudderAngle = controls.tiller * boat.cfg.rudder.maxAngleDeg * DEG;
  const vRudder = state.v + state.r * rd.x + state.p * rd.z;
  const rudder = foilForce(rd, state.u, vRudder, boat.cfg.rudder.inflowFactor, lambda0 + rudderAngle + downwash, cHeel, heel, boat, env);

  return {
    fx: board.fx + rudder.fx,
    fy: board.fy + rudder.fy,
    heelMoment: b.z * board.fy + rd.z * rudder.fy,
    yawMoment: b.x * board.fy + rd.x * rudder.fy,
    board,
    rudder,
    rudderAngle,
    lambda0,
    downwash,
  };
}
