/**
 * Sails the boat at a fixed true wind angle and sheet setting until the speed
 * settles, then averages the last window. Used by scripts/polar.ts.
 */
import {
  DEG,
  KNOT,
  initialState,
  step,
  wrap2Pi,
  type BoatModel,
  type SimConfig,
} from '../../src/sim/index';
import { createAutopilot } from './autopilot';

export interface SteadyResult {
  twaDeg: number;
  sheet: number;
  speedKn: number;
  vmgKn: number;
  leewayDeg: number;
  heelDeg: number;
  hike: number;
  rudderDeg: number;
  awsKn: number;
  awaDeg: number;
  luffAmount: number;
  converged: boolean;
  simSeconds: number;
}

const START_SPEED = 1.5; // m/s, TUNING GUESS starting push so the foils work from t = 0
const MIN_TIME = 40; // s
const MAX_TIME = 240; // s
const WINDOW = 10; // s, averaging window and convergence span
const TOLERANCE = 0.005; // m/s change of window-mean speed between windows

export function sailToSteadyState(boat: BoatModel, cfg: SimConfig, twaDeg: number, sheet: number): SteadyResult {
  // Heading so that the wind (from cfg.wind.fromDeg) is twaDeg off the port bow:
  // starboard-tack-agnostic; port and starboard are symmetric in this model.
  const heading = wrap2Pi((cfg.wind.fromDeg + twaDeg) * DEG);
  let state = initialState(heading, START_SPEED);
  state = { ...state, boomSide: 1, crewY: -boat.cfg.crew.sitInOffset };
  const pilot = createAutopilot(heading, sheet, cfg.layers.yaw);
  const windowSteps = Math.round(WINDOW / cfg.dt);

  let sum = { speed: 0, vmg: 0, leeway: 0, heel: 0, hike: 0, rudder: 0, aws: 0, awa: 0, luff: 0 };
  let prevMean = Number.NaN;
  let n = 0;
  let converged = false;
  let mean = { ...sum };
  const maxSteps = Math.round(MAX_TIME / cfg.dt);
  for (let i = 1; i <= maxSteps; i++) {
    const controls = pilot.controls(state, cfg.dt);
    const r = step(state, controls, boat, cfg);
    state = r.state;
    const last = r.diagnostics;
    sum.speed += state.u;
    sum.vmg += last.vmg;
    sum.leeway += last.leeway;
    sum.heel += state.heel;
    sum.hike += controls.hike;
    sum.rudder += last.foils?.rudderAngle ?? 0;
    sum.aws += last.apparent.speed;
    sum.awa += Math.abs(last.apparent.angle);
    sum.luff += last.sail?.luffAmount ?? 0;
    n++;
    if (i % windowSteps === 0) {
      mean = {
        speed: sum.speed / n,
        vmg: sum.vmg / n,
        leeway: sum.leeway / n,
        heel: sum.heel / n,
        hike: sum.hike / n,
        rudder: sum.rudder / n,
        aws: sum.aws / n,
        awa: sum.awa / n,
        luff: sum.luff / n,
      };
      if (state.t >= MIN_TIME && Math.abs(mean.speed - prevMean) < TOLERANCE) {
        converged = true;
        break;
      }
      prevMean = mean.speed;
      sum = { speed: 0, vmg: 0, leeway: 0, heel: 0, hike: 0, rudder: 0, aws: 0, awa: 0, luff: 0 };
      n = 0;
    }
  }
  return {
    twaDeg,
    sheet,
    speedKn: mean.speed / KNOT,
    vmgKn: mean.vmg / KNOT,
    leewayDeg: mean.leeway / DEG,
    heelDeg: mean.heel / DEG,
    hike: mean.hike,
    rudderDeg: mean.rudder / DEG,
    awsKn: mean.aws / KNOT,
    awaDeg: mean.awa / DEG,
    luffAmount: mean.luff,
    converged,
    simSeconds: state.t,
  };
}

/** Best sheet setting for a true wind angle: coarse grid, then golden-section refinement. */
export function bestTrim(boat: BoatModel, cfg: SimConfig, twaDeg: number): SteadyResult {
  const run = (sheet: number) => sailToSteadyState(boat, cfg, twaDeg, sheet);
  const grid = [0, 0.2, 0.4, 0.6, 0.8, 1].map(run);
  let best = grid[0]!;
  let bestIndex = 0;
  grid.forEach((r, i) => {
    if (r.speedKn > best.speedKn) {
      best = r;
      bestIndex = i;
    }
  });
  let lo = Math.max(0, (bestIndex - 1) * 0.2);
  let hi = Math.min(1, (bestIndex + 1) * 0.2);
  const phi = (Math.sqrt(5) - 1) / 2;
  let a = run(hi - phi * (hi - lo));
  let b = run(lo + phi * (hi - lo));
  for (let i = 0; i < 6; i++) {
    if (a.speedKn > b.speedKn) {
      hi = b.sheet;
      b = a;
      a = run(hi - phi * (hi - lo));
    } else {
      lo = a.sheet;
      a = b;
      b = run(lo + phi * (hi - lo));
    }
  }
  for (const r of [a, b]) if (r.speedKn > best.speedKn) best = r;
  return best;
}
