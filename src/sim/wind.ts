/**
 * Render-only copy of server/sim/wind.go: drawing only. Gameplay (forces, wind on the sail, grounding, buoy checks) comes from the Go physics (src/physics). Kept equal by src/sim/renderParity.test.ts.
 */
import type { WindConfig } from '../physics/types';
import { DEG, KNOT, bearingToWorld, type Vec2 } from './frames';
import windData from '../../data/wind.json';

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

/**
 * The n-th uniform [0, 1) draw of the puff in drift-frame cell (ix, iz), time slot k, where
 * cell = imul(ix, 0x27d4eb2d) ^ imul(iz, 0x165667b1) ^ imul(k, 0x2c1b3c6d) (hashed once per cell by activePuffs).
 */
function puffRandom(cell: number, seed: number, n: number): number {
  let h = cell ^ Math.imul((seed + Math.imul(n, 0x9e3779b9)) | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smoothstep on [0, 1]. */
function windSmooth(x: number): number {
  x = Math.min(Math.max(x, 0), 1);
  return x * x * (3 - 2 * x);
}

/**
 * Mean wind velocity (where the air moves TO), m/s. Gust puffs drift along a multiple of this
 * vector, and slow consumers (cloud drift) use it directly.
 */
export function meanWind(cfg: WindConfig): Vec2 {
  const from = bearingToWorld(cfg.fromDeg * DEG);
  const speed = cfg.speedKn * KNOT;
  return { x: -from.x * speed, z: -from.z * speed };
}

/** Velocity of the frame the gust puffs sit still in, m/s. */
export function gustDrift(cfg: WindConfig): Vec2 {
  const m = meanWind(cfg);
  const d = WIND_PARAMETERS.puffs.drift;
  return { x: m.x * d, z: m.z * d };
}

/** One live puff at the time it was collected for. */
export interface GustPuff {
  /** Centre in the drift frame (world minus drift × t), m. */
  qx: number;
  qz: number;
  /** Unit downwind axis: -bearingToWorld(fromDeg). */
  ax: number;
  az: number;
  /** Semi-axes, m. */
  along: number;
  across: number;
  /** Life envelope at the collection time, 0..1. */
  env: number;
  /** Peak speed excess × gustScale. */
  strength: number;
  /** Direction shift × gustScale, degrees clockwise. */
  veerDeg: number;
}

/**
 * A puff's strength over its life: a smooth rise over riseFraction of it, then a smooth fade to
 * zero at the end.
 */
export function puffEnvelope(age: number, life: number): number {
  const rise = WIND_PARAMETERS.puffs.riseFraction * life;
  if (age < rise) return windSmooth(age / rise);
  return 1 - windSmooth((age - rise) / (life - rise));
}

/**
 * Pushes onto `out` (and returns it) the puffs alive at t that can reach the drift-frame box
 * [qMinX, qMaxX] × [qMinZ, qMaxZ], in Go activePuffs order (slot, then z cell, then x cell).
 * Reads cfg.gusts; callers check `enabled`.
 */
export function activePuffs(
  qMinX: number, qMinZ: number, qMaxX: number, qMaxZ: number, t: number, cfg: WindConfig, out: GustPuff[],
): GustPuff[] {
  const p = WIND_PARAMETERS.puffs;
  const reach = p.elongation * p.radiusM[1]!;
  const from = bearingToWorld(cfg.fromDeg * DEG);
  const seed = cfg.gusts!.seed;
  const scale = cfg.gusts!.gustScale;
  const kMax = Math.floor(t / p.slotS);
  const izMax = Math.floor((qMaxZ + reach) / p.cellM);
  const ixMax = Math.floor((qMaxX + reach) / p.cellM);
  const [life0, life1] = p.lifeS as [number, number];
  const [radius0, radius1] = p.radiusM as [number, number];
  const [strength0, strength1] = p.strength as [number, number];
  for (let k = Math.floor((t - life1) / p.slotS); k <= kMax; k++) {
    const kHash = Math.imul(k | 0, 0x2c1b3c6d);
    for (let iz = Math.floor((qMinZ - reach) / p.cellM); iz <= izMax; iz++) {
      const zHash = Math.imul(iz | 0, 0x165667b1) ^ kHash;
      for (let ix = Math.floor((qMinX - reach) / p.cellM); ix <= ixMax; ix++) {
        const cell = Math.imul(ix | 0, 0x27d4eb2d) ^ zHash;
        if (puffRandom(cell, seed, 0) >= p.probability) continue;
        const birth = (k + puffRandom(cell, seed, 1)) * p.slotS;
        const life = life0 + (life1 - life0) * puffRandom(cell, seed, 2);
        const age = t - birth;
        if (!(age > 0 && age < life)) continue;
        const r = radius0 + (radius1 - radius0) * puffRandom(cell, seed, 5);
        const s = puffRandom(cell, seed, 6);
        out.push({
          qx: (ix + puffRandom(cell, seed, 3)) * p.cellM,
          qz: (iz + puffRandom(cell, seed, 4)) * p.cellM,
          ax: -from.x,
          az: -from.z,
          along: r * p.elongation,
          across: r,
          env: puffEnvelope(age, life),
          strength: (strength0 + (strength1 - strength0) * s * s * s) * scale,
          veerDeg: (2 * puffRandom(cell, seed, 7) - 1) * p.veerDeg * scale,
        });
      }
    }
  }
  return out;
}

/** The puff's falloff at drift-frame point (qx, qz): (1 - d²)³ inside the ellipse, 0 outside. */
export function puffShape(puff: GustPuff, qx: number, qz: number): number {
  const dx = qx - puff.qx;
  const dz = qz - puff.qz;
  const a = (dx * puff.ax + dz * puff.az) / puff.along;
  const c = (dz * puff.ax - dx * puff.az) / puff.across;
  const d2 = a * a + c * c;
  if (d2 >= 1) return 0;
  const m = 1 - d2;
  return m * m * m;
}

/**
 * Combines puffs at drift-frame (qx, qz): speed excess capped at cap × gustScale, and the
 * shape-weighted mean veer (scaled down where puffs are weak).
 */
function puffsAt(qx: number, qz: number, puffs: GustPuff[], gustScale: number): { excess: number; veerDeg: number } {
  const limit = WIND_PARAMETERS.puffs.cap * gustScale;
  let prod = 1;
  let sumW = 0;
  let sumWV = 0;
  for (const puff of puffs) {
    const m = puffShape(puff, qx, qz);
    if (m === 0) continue;
    const wgt = puff.env * m;
    prod *= 1 - (puff.strength * wgt) / limit;
    sumW += wgt;
    sumWV += wgt * puff.veerDeg;
  }
  gust.excess = limit * (1 - prod);
  gust.veerDeg = sumWV / Math.max(1, sumW);
  return gust;
}

/** How much gusts and shifts apply at a world position: 0 in the Westcove steady zone, 1 in open water. */
export function steadyWeight(x: number, z: number): number {
  const zone = WIND_PARAMETERS.steadyZone;
  const dx = x - zone.x;
  const dz = z - zone.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  return windSmooth((d - zone.innerM) / (zone.outerM - zone.innerM));
}

const pointPuffs: GustPuff[] = []; // reused by localGust
const gust = { excess: 0, veerDeg: 0 }; // reused result of puffsAt / localGust

/** The puffs' speed excess and veer at a world position and time, before the steady zone. */
function localGust(position: Vec2, t: number, cfg: WindConfig): { excess: number; veerDeg: number } {
  const gusts = cfg.gusts;
  if (!gusts?.enabled || gusts.gustScale <= 0) {
    gust.excess = 0;
    gust.veerDeg = 0;
    return gust;
  }
  const v = gustDrift(cfg);
  const qx = position.x - v.x * t;
  const qz = position.z - v.z * t;
  pointPuffs.length = 0;
  return puffsAt(qx, qz, activePuffs(qx, qz, qx, qz, t, cfg, pointPuffs), gusts.gustScale);
}

/**
 * Wind speed multiplier at a position and time (1 when gusts are off). The sim, the debug readouts
 * and the water's gust patches all read this one function.
 */
export function windSpeedFactor(position: Vec2, time: number, cfg: WindConfig): number {
  if (!cfg.gusts?.enabled) return 1;
  const e = localGust(position, time, cfg).excess;
  return 1 + steadyWeight(position.x, position.z) * e;
}

/** Slow position-independent oscillation of the wind direction, degrees (clockwise positive), before the steady zone. */
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
 * mean wind exactly. With them enabled, the direction shifts slowly with time, gust puffs add
 * speed and a small veer, and both fade out in the Westcove steady zone.
 */
export function getWind(position: Vec2, time: number, cfg: WindConfig): Vec2 {
  if (!cfg.gusts?.enabled) return meanWind(cfg);
  // Layers: base (the mean wind; a baked base map would replace this speed and direction later),
  // then the bay-wide slow shifts, then local gust puffs; shifts and gusts fade out in the steady zone.
  const { excess, veerDeg } = localGust(position, time, cfg);
  const zone = steadyWeight(position.x, position.z);
  const fromDeg = cfg.fromDeg + zone * (windShiftDeg(time, cfg) + veerDeg);
  const from = bearingToWorld(fromDeg * DEG);
  const speed = cfg.speedKn * KNOT * (1 + zone * excess);
  return { x: -from.x * speed, z: -from.z * speed };
}
