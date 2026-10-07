/**
 * The conifer forest that climbs the hill behind Westcove: a belt that begins a little uphill of the
 * town's upper road (Hill Road, so it clears the uphill houses), with a ragged lower edge, and runs
 * up the slope before thinning out, fading at both ends of the road. It darkens the ground and gets
 * densely planted with tall dark conifers (trees.ts), so the town reads as sitting under a wall of
 * evergreen, as on the British Columbia coast. Render-only. All numbers are VISUAL ESTIMATE.
 */
import { fbm, terrainGrid } from '../../sim/terrain';
import { ROADS, sampleRoad, type RoadSample } from './roads';

const ROAD = 'Hill Road';
const EDGE_NEAR = 22; // m uphill of the road centre where the forest may begin (ragged by EDGE_RAGGED)
const EDGE_RAGGED = 14; // m of noise on the lower edge
const EDGE_WAVELENGTH = 55; // m
const EDGE_SOFT = 35; // m over which the forest thickens from its edge
const FADE_FROM = 380; // m uphill: the belt thins out ...
const FADE_TO = 520; // ... and is gone
const END_FADE = 120; // m: the belt fades toward each end of the road
const SEED = 1987;

let samples: RoadSample[] | null = null;
let length = 0;
let bounds = { x0: 0, x1: 0, z0: 0, z1: 0 };

function load(): RoadSample[] {
  if (samples) return samples;
  const road = ROADS.find((r) => r.name === ROAD);
  samples = road ? sampleRoad(road, 10, terrainGrid()) : [];
  length = samples.length ? samples[samples.length - 1]!.s : 0;
  const xs = samples.map((p) => p.x), zs = samples.map((p) => p.z);
  // Anything farther from the road than the fade distance is outside the belt.
  bounds = {
    x0: Math.min(...xs) - FADE_TO, x1: Math.max(...xs) + FADE_TO,
    z0: Math.min(...zs) - FADE_TO, z1: Math.max(...zs) + FADE_TO,
  };
  return samples;
}

const smoothstep = (a: number, b: number, v: number): number => {
  const t = Math.min(Math.max((v - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/** Bounding box of the belt, for planting: x0, x1, z0, z1 in logical metres. */
export function beltBounds(): Readonly<typeof bounds> {
  load();
  return bounds;
}

/** 0 outside the forest belt to 1 deep inside it. Cheap enough for every terrain vertex. */
export function beltAmount(x: number, z: number): number {
  const pts = load();
  if (pts.length === 0 || x < bounds.x0 || x > bounds.x1 || z < bounds.z0 || z > bounds.z1) return 0;
  let best = pts[0]!, bestD = Infinity;
  for (const p of pts) {
    const d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d < bestD) { bestD = d; best = p; }
  }
  // The road's normal points downhill; the forest is on the other side of it.
  const up = -((x - best.x) * best.nx + (z - best.z) * best.nz);
  if (up < EDGE_NEAR - EDGE_RAGGED || up > FADE_TO) return 0;
  const edge = EDGE_NEAR + EDGE_RAGGED * fbm(x / EDGE_WAVELENGTH, z / EDGE_WAVELENGTH, 2, SEED);
  const ends = smoothstep(0, END_FADE, best.s) * smoothstep(0, END_FADE, length - best.s);
  return smoothstep(edge, edge + EDGE_SOFT, up) * (1 - smoothstep(FADE_FROM, FADE_TO, up)) * ends;
}
