/**
 * L2 Sail as a foil (PHYSICS.md L2), plus parasitic windage (Day 2017 section 2.5).
 *
 * Coefficients: Day 2017 Table 1 (PDF p3), ORC "Low Lift" mainsail CL and viscous CDv
 * vs apparent wind angle beta, interpolated by cubic spline (Day p3).
 *
 * Best-trim envelope (design decision in PHYSICS.md L2, not from the paper):
 * the table value at the current apparent wind angle is what a well-trimmed sail
 * produces. Trim error costs force:
 *  - Under-sheeted (boom eased past best trim) or pinching: luffing. Following Day 2017
 *    p5 (SPILL): easing the sail reduces its angle of attack, which acts like a smaller
 *    apparent wind angle on the upwind branch of Table 1. The equivalent table angle
 *    shrinks in proportion to the angle of attack, so lift follows the table's own
 *    0..beta_peak shape. On top of that, luffAmount (PHYSICS.md L2: "It also collapses
 *    lift in the model") ramps from 0 at an equivalent angle of luffStartBetaEffDeg to 1
 *    at luffFullBetaEffDeg and scales lift by (1 - luffAmount). TUNING GUESS. Viscous drag
 *    blends to the beta = 0 value (a flagging sail) with the same factor.
 *  - Over-sheeted (boom tighter than best trim): stall. TUNING GUESS shape:
 *    k = 1 / (1 + (over / stallWidth)^2); lift and drag blend from the table toward a
 *    flat plate with the Table 1 beta = 180 drag (ORC 2023 VPP doc p36: beta = 180
 *    approximates an angle of attack of 90 degrees).
 * Best trim: Day 2017 p5, the sheeting angle for maximum lift does not change from
 * beta = 0 up to the angle of maximum lift; above it the boom is eased so the angle
 * of attack stays at its value at maximum lift, until the boom reaches its limit.
 *
 * Total drag: Day 2017 Eq. 1 (PDF p4) / Eq. 6 with actual CL = f CLmax:
 *   CD = CDv + CDp + CL^2 (1 / (pi AR_E) + CDs)
 * CDp (parasitic) is modelled as separate windage forces below, not as a coefficient.
 */
import type { BoatModel } from '../boat';
import type { EnvironmentConfig, TermToggles } from '../config';
import { DEG, G, clamp, wrapPi } from '../frames';
import type { BoatState } from '../state';
import type { ApparentWind } from './apparentWind';

export interface SailCoefficients {
  cl: number;
  cdv: number;
  /** 0 = drawing, 1 = fully luffing. */
  luffAmount: number;
  /** Boom angle minus best-trim boom angle, rad (+ = eased too far). */
  trimError: number;
  /** Angle of attack, rad: apparent wind angle on the sail side minus boom angle. */
  alpha: number;
}

export interface BoomKinematics {
  boomSide: 1 | -1;
  /** Signed boom angle the boom is moving toward, rad. */
  target: number;
}

export interface Windage {
  fx: number;
  fy: number;
  heelMoment: number;
  yawMoment: number;
  drag: number;
}

export interface SailResult {
  fx: number;
  fy: number;
  /** Heeling moment, N m (+ = heels to starboard). */
  heelMoment: number;
  /** Yaw moment, N m (+ = bow to starboard). */
  yawMoment: number;
  lift: number;
  drag: number;
  cl: number;
  cd: number;
  cdv: number;
  cdi: number;
  alpha: number;
  luffAmount: number;
  trimError: number;
  /** Apparent wind in the heeled plane. */
  awsHeeled: number;
  awaHeeled: number;
  ce: { x: number; y: number; z: number };
  windage: Windage;
}

/** Wind angle measured on the side opposite the boom, wrapped to [-pi/2, 3pi/2). */
function windOnSailSide(awa: number, boomSide: 1 | -1): number {
  const w = wrapPi(-boomSide * awa);
  return w < -Math.PI / 2 ? w + 2 * Math.PI : w;
}

/**
 * Where the boom goes. Quasi-static: the wind pushes the boom to leeward until the
 * sheet stops it, or until the sail points into the wind. The boom flips sides when
 * the wind crosses the bow (tack) or gets more than gybeByTheLee past dead downwind.
 */
export function boomKinematics(awa: number, state: BoatState, sheet: number, boat: BoatModel): BoomKinematics {
  const rig = boat.cfg.rig;
  let side = state.boomSide;
  let w = windOnSailSide(awa, side);
  if (w < 0 || w > Math.PI + rig.gybeByTheLeeDeg * DEG) {
    side = side === 1 ? -1 : 1;
    w = windOnSailSide(awa, side);
  }
  const limit = (rig.boomMinDeg + clamp(sheet, 0, 1) * (rig.boomMaxDeg - rig.boomMinDeg)) * DEG;
  return { boomSide: side, target: side * Math.min(limit, Math.max(w, 0)) };
}

/**
 * Sail coefficients from the best-trim envelope.
 * @param betaW apparent wind angle on the sail side, rad (0 = head to wind, pi = dead run)
 * @param delta boom angle away from the wind, rad (>= 0 when the boom is on the leeward side)
 */
export function sailCoefficients(boat: BoatModel, betaW: number, delta: number): SailCoefficients {
  const rig = boat.cfg.rig;
  const betaDeg = clamp(betaW / DEG, 0, 180);
  const clEnv = boat.clTable.at(betaDeg);
  const cdvEnv = boat.cdvTable.at(betaDeg);

  const boomMin = rig.boomMinDeg * DEG;
  const alphaOpt = boat.betaPeak - boomMin;
  const deltaOpt = clamp(betaW - alphaOpt, boomMin, rig.boomMaxDeg * DEG);
  const alphaBest = betaW - deltaOpt;
  const alpha = betaW - delta;
  const trimError = delta - deltaOpt;

  // Luffing: equivalent angle on the upwind branch of Table 1.
  const branch = Math.min(betaW, boat.betaPeak);
  let ratio = 1;
  if (alpha <= 0) ratio = 0;
  else if (trimError > 0 && alphaBest > 0) ratio = Math.min(alpha / alphaBest, 1);
  const equivDeg = (ratio * branch) / DEG;
  const branchCl = boat.clTable.at(branch / DEG);
  const kLuff = branchCl > 0 ? clamp(boat.clTable.at(equivDeg) / branchCl, 0, 1) : 0;
  const luffAmount = clamp((rig.luffStartBetaEffDeg - equivDeg) / (rig.luffStartBetaEffDeg - rig.luffFullBetaEffDeg), 0, 1);
  const kFill = kLuff * (1 - luffAmount);

  let cl = clEnv * kFill;
  let cdv = kFill * cdvEnv + (1 - kFill) * boat.cdvTable.at(0);

  // Stall: over-sheeted.
  if (trimError < 0 && alpha > 0) {
    const over = -trimError / (rig.stallWidthDeg * DEG);
    const kStall = 1 / (1 + over * over);
    const plate = boat.cdvTable.at(180);
    cl = kStall * cl + (1 - kStall) * plate * Math.sin(alpha) * Math.cos(alpha);
    cdv = kStall * cdv + (1 - kStall) * plate * Math.sin(alpha) ** 2;
  }

  return { cl, cdv, luffAmount, trimError, alpha };
}

function windage(
  state: BoatState,
  boat: BoatModel,
  q: number,
  flowAngle: number,
  betaW: number,
  crewZ: number,
): Windage {
  const cfg = boat.cfg;
  const heel = Math.abs(state.heel);
  const sinB = Math.abs(Math.sin(betaW));
  const fwx = Math.cos(flowAngle);
  const fwy = Math.sin(flowAngle);
  let fx = 0;
  let fy = 0;
  let heelMoment = 0;
  let yawMoment = 0;
  let drag = 0;
  const add = (cdA: number, x: number, y: number, z: number): void => {
    const f = q * cdA;
    fx += f * fwx;
    fy += f * fwy;
    heelMoment += z * f * fwy;
    yawMoment += x * f * fwy - y * f * fwx;
    drag += f;
  };

  // Crew: Day 2017 Eqs. 8-9 (PDF p5). W in newtons, H in metres.
  const c = cfg.crew;
  const aDu = c.dubois.coef * (boat.crewMass * G) ** c.dubois.weightExp * c.height ** c.dubois.heightExp;
  const keep = (1 - c.clothingReduction) * (1 - c.shielding); // Day p5: -10% Cd, -20% area
  const cdAFront = c.cdFrontal * c.frontalAreaFrac * aDu * keep;
  const cdASide = c.cdSide * c.sideAreaFrac * aDu * keep;
  // Projection between frontal and side: sinusoidal as Day does for the hull (Eq. 7).
  add(cdAFront + (cdASide - cdAFront) * sinB, 0, state.crewY, boat.zHullCg + crewZ);

  // Bare mast between deck and boom, Cd 0.8; sleeve part Cd 0.15 upwind only (Day p5).
  const rig = cfg.rig;
  add(rig.bareMastCd * rig.mastDiameter * boat.boomAboveDeck, boat.xMast, 0, boat.freeboard + boat.boomAboveDeck / 2);
  if (betaW < Math.PI / 2) {
    add(rig.sleeveMastCd * rig.mastDiameter * rig.luff, boat.xMast, 0, boat.zBoom + rig.luff / 2);
  }

  // Topsides: Day 2017 Eq. 7 (PDF p5).
  //   A_F = B_OA FA,  A_S = L_OA (FA + 0.5 B_OA C_WP sin(phi))
  //   A(beta) = A_F + (A_S - A_F) sin(beta),  Z_CE = 0.66 (FA + 0.5 B_OA C_WP sin(phi))
  const fa = boat.freeboard;
  const h = cfg.hull;
  const heelRise = 0.5 * h.beam * boat.cwp * Math.sin(heel);
  const aF = h.beam * fa;
  const aS = h.loa * (fa + heelRise);
  add(h.topsidesCd * (aF + (aS - aF) * sinB), 0, 0, 0.66 * (fa + heelRise));

  return { fx, fy, heelMoment, yawMoment, drag };
}

export function sailForces(
  state: BoatState,
  aw: ApparentWind,
  crewZ: number,
  boat: BoatModel,
  env: EnvironmentConfig,
  terms: TermToggles,
): SailResult {
  const rig = boat.cfg.rig;
  // Apparent wind in the heeled plane: the cross component is reduced by cos(heel).
  const uH = aw.u;
  const vH = aw.v * Math.cos(state.heel);
  const awsHeeled = Math.hypot(uH, vH);
  const awaHeeled = Math.atan2(-vH, -uH);

  const side = state.boomSide;
  const betaW = windOnSailSide(awaHeeled, side);
  const delta = side * state.boom;
  const coef = sailCoefficients(boat, betaW, delta);

  const cdi = terms.sailInducedDrag
    ? coef.cl * coef.cl * (1 / (Math.PI * boat.sailAspectRatio) + rig.separationDragCds)
    : 0;
  const cd = coef.cdv + cdi;
  const q = 0.5 * env.rhoAir * awsHeeled * awsHeeled;
  const lift = q * rig.sailArea * coef.cl;
  const drag = q * rig.sailArea * cd;

  // Flow direction (where the air goes) and lift direction, body angles.
  const flowAngle = awaHeeled + Math.PI;
  const liftAngle = flowAngle - side * (Math.PI / 2);
  const fx = lift * Math.cos(liftAngle) + drag * Math.cos(flowAngle);
  const fyHeeled = lift * Math.sin(liftAngle) + drag * Math.sin(flowAngle);

  // Centre of effort: along the boom from the mast, at CE height above the boom.
  const ceX = boat.xMast - boat.ceAftOfMast * Math.cos(state.boom);
  const ceY = boat.ceAftOfMast * Math.sin(state.boom);
  const ceZ = boat.zBoom + boat.ceAboveBoom;

  const wind = terms.windage
    ? windage(state, boat, q, flowAngle, betaW, crewZ)
    : { fx: 0, fy: 0, heelMoment: 0, yawMoment: 0, drag: 0 };

  const cosHeel = Math.cos(state.heel);
  const fy = fyHeeled * cosHeel;
  return {
    fx: fx + wind.fx,
    fy: fy + wind.fy * cosHeel,
    heelMoment: ceZ * fyHeeled + wind.heelMoment,
    yawMoment: ceX * fy - ceY * fx + wind.yawMoment * cosHeel,
    lift,
    drag,
    cl: coef.cl,
    cd,
    cdv: coef.cdv,
    cdi,
    alpha: coef.alpha,
    luffAmount: coef.luffAmount,
    trimError: coef.trimError,
    awsHeeled,
    awaHeeled,
    ce: { x: ceX, y: ceY, z: ceZ },
    windage: wind,
  };
}
