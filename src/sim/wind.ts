import type { WindConfig } from './config';
import { DEG, KNOT, bearingToWorld, type Vec2 } from './frames';

/**
 * True wind velocity (where the air moves TO) at a world position and time, m/s.
 * The only source of wind in the sim. v1: constant field (DESIGN.md), so
 * position and time are unused; gusts and shifts are later drop-ins here.
 */
export function getWind(_position: Vec2, _time: number, cfg: WindConfig): Vec2 {
  const from = bearingToWorld(cfg.fromDeg * DEG);
  const speed = cfg.speedKn * KNOT;
  return { x: -from.x * speed, z: -from.z * speed };
}
