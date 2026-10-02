import type { WindConfig } from './config';
import { DEG, KNOT, bearingToWorld, type Vec2 } from './frames';
import windData from '../data/wind.json';

export const WIND_PARAMETERS = windData;

/** Deterministic lattice value in [0, 1) for an integer cell and seed (integer hash). */
function lattice(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smoothed value noise in [-1, 1] with a quintic fade. */
function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = lattice(ix, iy, seed);
  const b = lattice(ix + 1, iy, seed);
  const c = lattice(ix, iy + 1, seed);
  const d = lattice(ix + 1, iy + 1, seed);
  const bottom = a + (b - a) * ux;
  return (bottom + (c + (d - c) * ux - bottom) * uy) * 2 - 1;
}

/**
 * Mean wind velocity (where the air moves TO), m/s. The gust field is carried along this vector,
 * and slow consumers (cloud drift) use it directly.
 */
export function meanWind(cfg: WindConfig): Vec2 {
  const from = bearingToWorld(cfg.fromDeg * DEG);
  const speed = cfg.speedKn * KNOT;
  return { x: -from.x * speed, z: -from.z * speed };
}

/** Gust field value n in about [-1, 1] at a world position and time, carried downwind. */
function gustNoise(x: number, z: number, t: number, cfg: WindConfig, seed: number): number {
  const mean = meanWind(cfg);
  const px = x - mean.x * t;
  const pz = z - mean.z * t;
  const p = WIND_PARAMETERS;
  const coarse = valueNoise(px / p.gustLengthM, pz / p.gustLengthM, seed);
  const fine = valueNoise(px / p.fineLengthM + 17.3, pz / p.fineLengthM - 9.1, seed + 1);
  return (coarse + p.fineWeight * fine) / (1 + p.fineWeight);
}

/**
 * Wind speed multiplier at a position and time (1 when gusts are off). The sim, the debug readouts
 * and the water's gust patches all read this one function.
 */
export function windSpeedFactor(position: Vec2, time: number, cfg: WindConfig): number {
  const gusts = cfg.gusts;
  if (!gusts?.enabled) return 1;
  const n = gustNoise(position.x, position.z, time, cfg, gusts.seed);
  return Math.max(WIND_PARAMETERS.minFactor, 1 + WIND_PARAMETERS.gustAmplitude * gusts.gustScale * n);
}

/** Slow position-independent oscillation of the wind direction, degrees (clockwise positive). */
export function windShiftDeg(time: number, cfg: WindConfig): number {
  const gusts = cfg.gusts;
  if (!gusts?.enabled) return 0;
  let shift = 0;
  WIND_PARAMETERS.shifts.forEach((s, k) => {
    const phase = 2 * Math.PI * lattice(k, 0, gusts.seed + 99);
    shift += s.amplitudeDeg * Math.sin((2 * Math.PI * time) / s.periodS + phase);
  });
  return shift * gusts.shiftScale;
}

/**
 * True wind velocity (where the air moves TO) at a world position and time, m/s.
 * The only source of wind in the sim (PHYSICS.md L1). With gusts disabled this is the constant
 * mean wind exactly. With them enabled, speed follows the downwind-carried gust field, the
 * direction veers with gust strength and shifts slowly with time.
 */
export function getWind(position: Vec2, time: number, cfg: WindConfig): Vec2 {
  const gusts = cfg.gusts;
  if (!gusts?.enabled) return meanWind(cfg);
  const n = gustNoise(position.x, position.z, time, cfg, gusts.seed);
  const factor = Math.max(WIND_PARAMETERS.minFactor, 1 + WIND_PARAMETERS.gustAmplitude * gusts.gustScale * n);
  const fromDeg = cfg.fromDeg + windShiftDeg(time, cfg) + WIND_PARAMETERS.gustVeerDeg * gusts.gustScale * n;
  const from = bearingToWorld(fromDeg * DEG);
  const speed = cfg.speedKn * KNOT * factor;
  return { x: -from.x * speed, z: -from.z * speed };
}
