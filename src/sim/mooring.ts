/** Berths of Westcove Harbour (data/bay.json `harbour.berths`): where a new boat starts, held alongside a pontoon. */
import { BAY } from './terrain';

/** One mooring (world x east, z south, m); `side` is the boat side facing the pontoon. */
export interface Berth { x: number; z: number; headingDeg: number; pontoon: number; side: 'port' | 'starboard' }

export const BERTHS: readonly Berth[] = BAY.harbour.berths as readonly Berth[];

/** Which berth a moored boat at (x, z) is held at (within 0.5 m), else -1. */
export function berthIndexAt(x: number, z: number): number {
  return BERTHS.findIndex((b) => Math.hypot(b.x - x, b.z - z) <= 0.5);
}

