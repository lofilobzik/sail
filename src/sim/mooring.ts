/** Berths of Westcove Harbour (data/bay.json `harbour.berths`): where a new boat starts, held alongside a pontoon. */
import type { BoatModel } from './boat';
import type { SimConfig } from './config';
import { DEG } from './frames';
import { initialState, type BoatState, type Controls } from './state';
import { evaluate } from './step';
import { BAY } from './terrain';

/** One mooring (world x east, z south, m); `side` is the boat side facing the pontoon. */
export interface Berth { x: number; z: number; headingDeg: number; pontoon: number; side: 'port' | 'starboard' }

export const BERTHS: readonly Berth[] = BAY.harbour.berths as readonly Berth[];

/** The sheet fully eased, as a moored boat starts (input/controls.ts MOORED_SHEET). */
const MOORED_CONTROLS: Readonly<Controls> = { tiller: 0, sheet: 1, hike: 0 };

/**
 * A boat held at `berth`: initialState(headingDeg*DEG, 0) at t, x, z with moored true, and the boom
 * already weathervaned where the eased sheet lets it go in `cfg`'s wind, as on a boat that has lain
 * at the berth a while (a boom swinging out from the centreline would kick the hull into a long roll).
 */
export function mooredAt(berth: Berth, boat: BoatModel, cfg: SimConfig, t = 0): BoatState {
  const s: BoatState = { ...initialState(berth.headingDeg * DEG, 0), t, x: berth.x, z: berth.z, moored: true };
  const d = evaluate(s, MOORED_CONTROLS, boat, cfg);
  s.boom = d.boomTarget;
  s.boomSide = d.boomSide;
  return s;
}

/** Which berth a moored boat at (x, z) is held at (within 0.5 m), else -1. */
export function berthIndexAt(x: number, z: number): number {
  return BERTHS.findIndex((b) => Math.hypot(b.x - x, b.z - z) <= 0.5);
}

/**
 * Releases a moored boat with a small shove (data/bay.json harbour.castOff): forward, and away from
 * the pontoon when it lies at a berth. Server counterpart: CastOff in server/sim/mooring.go.
 */
export function castOff(s: BoatState): void {
  const push = BAY.harbour.castOff;
  const berth = BERTHS[berthIndexAt(s.x, s.z)];
  s.moored = false;
  s.u = push.forward;
  s.v = berth ? (berth.side === 'port' ? push.away : -push.away) : 0;
}
