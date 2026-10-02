/** A sighting is the instrument's horizontal viewing direction, never the exact bearing to a target. */
import { worldToBearing } from '../sim/frames';
import { NAVIGATION, graduatedBearing } from './navigation';

export function sightingBearing(direction: { x: number; y: number; z: number }): number | null {
  if (![direction.x, direction.y, direction.z].every(Number.isFinite)) return null;
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (length === 0 || Math.hypot(direction.x, direction.z) / length < NAVIGATION.minSightHorizontal) return null;
  return graduatedBearing(worldToBearing(direction.x, direction.z));
}
