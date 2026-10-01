/**
 * One fixed simulation step: state + controls + dt -> new state. Deterministic.
 * Forces from each layer are summed in the body frame and integrated with
 * semi-implicit Euler over `cfg.substeps` substeps (PHYSICS.md section 0).
 */
import type { BoatModel } from './boat';
import type { SimConfig } from './config';
import { DEG, bearingToWorld, bodyToWorld, clamp, type Vec2 } from './frames';
import { apparentWind, type ApparentWind } from './layers/apparentWind';
import { foilForces, type FoilsResult } from './layers/foils';
import { CREW_CROSSING_SPEED, crewPosition, rightingMoment } from './layers/heel';
import { hullForces, type HullResult } from './layers/hull';
import { boomKinematics, sailForces, type SailResult } from './layers/sail';
import { munkMoment } from './layers/yaw';
import type { BoatState, Controls } from './state';
import { getWind } from './wind';

export interface HeelDiagnostics {
  aeroMoment: number;
  hydroMoment: number;
  rightingMoment: number;
  crewY: number;
  crewTargetY: number;
  crewZ: number;
}

export interface YawDiagnostics {
  sail: number;
  foils: number;
  hull: number;
  munk: number;
  damping: number;
  total: number;
}

export interface Diagnostics {
  trueWind: Vec2;
  apparent: ApparentWind;
  /** null when the layer is disabled. */
  sail: SailResult | null;
  foils: FoilsResult | null;
  hull: HullResult | null;
  heel: HeelDiagnostics;
  yaw: YawDiagnostics;
  /** Total body-frame force, N, and moments, N m. */
  total: { fx: number; fy: number; yaw: number; heel: number };
  speed: number;
  /** Leeway angle, rad (+ = sliding to starboard). */
  leeway: number;
  /** Velocity made good toward the wind, m/s. */
  vmg: number;
  /** Signed target boom angle the boom is swinging to, rad. */
  boomTarget: number;
  boomSide: 1 | -1;
  controls: Controls;
}

const ZERO_SAIL_LIKE = { fx: 0, fy: 0, heelMoment: 0, yawMoment: 0 };

/** Evaluates every enabled layer at the current state. */
export function evaluate(state: BoatState, controls: Controls, boat: BoatModel, cfg: SimConfig): Diagnostics {
  const L = cfg.layers;
  const trueWind = getWind({ x: state.x, z: state.z }, state.t, cfg.wind);
  const apparent = apparentWind(state, trueWind, L.apparentWind);
  const crew = crewPosition(state, controls, boat);

  const sail = L.sail ? sailForces(state, apparent, crew.z, boat, cfg.env, cfg.terms) : null;
  const foils = L.foils ? foilForces(state, controls, boat, cfg.env, cfg.terms) : null;
  const hull = L.hull ? hullForces(state, boat, cfg.env, cfg.terms) : null;
  const s = sail ?? ZERO_SAIL_LIKE;
  const f = foils ?? ZERO_SAIL_LIKE;
  const h = hull ?? ZERO_SAIL_LIKE;

  const righting = L.heel ? rightingMoment(state.heel, state.crewY, crew.z, boat) : 0;
  const heelTotal = s.heelMoment + f.heelMoment + h.heelMoment + righting;

  const munk = L.yaw && cfg.terms.munkMoment ? munkMoment(state, boat, cfg.env) : 0;
  const damping = -boat.cfg.dynamics.yawDamping * state.r;
  const yawTotal = s.yawMoment + f.yawMoment + h.yawMoment + munk + damping;

  // Boom kinematics run even with the sail layer off so the rig still moves.
  const cosHeel = Math.cos(state.heel);
  const awaHeeled = Math.atan2(-apparent.v * cosHeel, -apparent.u);
  const boom = boomKinematics(awaHeeled, state, controls.sheet, boat);

  const speed = Math.hypot(state.u, state.v);
  const vel = bodyToWorld(state.heading, state.u, state.v);
  const windFrom = bearingToWorld(cfg.wind.fromDeg * DEG);

  return {
    trueWind,
    apparent,
    sail,
    foils,
    hull,
    heel: {
      aeroMoment: s.heelMoment,
      hydroMoment: f.heelMoment + h.heelMoment,
      rightingMoment: righting,
      crewY: state.crewY,
      crewTargetY: crew.targetY,
      crewZ: crew.z,
    },
    yaw: { sail: s.yawMoment, foils: f.yawMoment, hull: h.yawMoment, munk, damping, total: yawTotal },
    total: { fx: s.fx + f.fx + h.fx, fy: s.fy + f.fy + h.fy, yaw: yawTotal, heel: heelTotal },
    speed,
    leeway: speed > 1e-3 ? Math.atan2(state.v, Math.abs(state.u)) : 0,
    vmg: vel.x * windFrom.x + vel.z * windFrom.z,
    boomTarget: boom.target,
    boomSide: boom.boomSide,
    controls,
  };
}

function integrate(state: BoatState, d: Diagnostics, boat: BoatModel, cfg: SimConfig, h: number): BoatState {
  const dyn = boat.cfg.dynamics;
  const m = boat.mass;
  const mu = m * (1 + dyn.surgeAddedMassFrac);
  const mv = m + dyn.swayAddedMass;
  const { fx, fy } = d.total;

  const u = state.u + ((fx + m * state.v * state.r) / mu) * h;
  const v = state.v + ((fy - m * state.u * state.r) / mv) * h;

  let r = 0;
  if (cfg.layers.yaw) {
    const izz = boat.yawInertia * (1 + dyn.yawAddedInertiaFrac);
    r = state.r + (d.total.yaw / izz) * h;
  }

  let heel = 0;
  let p = 0;
  if (cfg.layers.heel) {
    p = state.p + ((d.total.heel - dyn.rollDamping * state.p) / boat.rollInertia) * h;
    heel = state.heel + p * h;
    const limit = dyn.heelLimitDeg * DEG;
    if (Math.abs(heel) > limit) {
      heel = Math.sign(heel) * limit;
      if (p * heel > 0) p = 0;
    }
  }

  const heading = state.heading + r * h;
  const vel = bodyToWorld(heading, u, v);

  const boomSide = d.boomSide;
  const boom = state.boom + (d.boomTarget - state.boom) * (1 - Math.exp(-h / boat.cfg.rig.boomTimeConstant));

  const maxMove = CREW_CROSSING_SPEED * h;
  const crewY = state.crewY + clamp(d.heel.crewTargetY - state.crewY, -maxMove, maxMove);

  return {
    t: state.t + h,
    x: state.x + vel.x * h,
    z: state.z + vel.z * h,
    heading,
    u,
    v,
    r,
    heel,
    p,
    boom,
    boomSide,
    crewY,
  };
}

export interface StepResult {
  state: BoatState;
  diagnostics: Diagnostics;
}

export function step(state: BoatState, controls: Controls, boat: BoatModel, cfg: SimConfig): StepResult {
  const c: Controls = {
    tiller: clamp(controls.tiller, -1, 1),
    sheet: clamp(controls.sheet, 0, 1),
    hike: clamp(controls.hike, 0, 1),
  };
  const h = cfg.dt / cfg.substeps;
  let s = state;
  let diagnostics = evaluate(s, c, boat, cfg);
  for (let i = 0; i < cfg.substeps; i++) {
    if (i > 0) diagnostics = evaluate(s, c, boat, cfg);
    s = integrate(s, diagnostics, boat, cfg, h);
  }
  return { state: s, diagnostics };
}
