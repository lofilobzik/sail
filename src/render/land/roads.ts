/**
 * Town roads (data/bay.json `roads`): polylines that follow the hillside, drawn as flat gravel ribbons
 * laid just above the terrain mesh, and sampled by the house placer so houses line up along them.
 * Roads are render-only: the sim never sees them.
 */
import * as THREE from 'three';
import { BAY, type TerrainGrid } from '../../sim/terrain';
import { groundHeight } from './ground';

export interface Road {
  name: string;
  /** The town whose houses line this road. */
  town: string;
  /** Metres. */
  width: number;
  points: readonly (readonly [number, number])[];
}

export const ROADS: readonly Road[] = BAY.roads.map((r) => ({
  name: r.name, town: r.town, width: r.width, points: r.points.map(([x, z]) => [x!, z!] as const),
}));

/** One point along a road: position, distance along it, unit tangent and the unit normal pointing downhill. */
export interface RoadSample { x: number; z: number; s: number; tx: number; tz: number; nx: number; nz: number }

const DOWNHILL_PROBE = 40; // m either side of a road where the ground is compared to find downhill
const LIFT = 0.1; // m above the terrain mesh, so the gravel never z-fights it
const RIBBON_STEP = 3; // m between cross-sections
const GRAVEL = 0x8c8676;
const VERGE = 0x6e695b;

/** The road resampled every `step` metres. The normal points downhill on average, toward the water. */
export function sampleRoad(road: Road, step: number, grid: TerrainGrid): RoadSample[] {
  const out: RoadSample[] = [];
  let s = 0;
  let carry = 0;
  const pts = road.points;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i]!, [bx, bz] = pts[i + 1]!;
    const length = Math.hypot(bx - ax, bz - az);
    if (length === 0) continue;
    const tx = (bx - ax) / length, tz = (bz - az) / length;
    for (let d = carry; d < length; d += step) {
      out.push({ x: ax + tx * d, z: az + tz * d, s: s + d, tx, tz, nx: -tz, nz: tx });
    }
    carry = ((carry - length) % step + step) % step;
    s += length;
  }
  // One side of the road is downhill: choose the normal that points that way over the whole road.
  // Compare the ground a little way off either side rather than the slope underfoot, which is zero
  // along a road laid on a flat terrace.
  let downhill = 0;
  for (const p of out) {
    downhill += groundHeight(grid, p.x - p.nx * DOWNHILL_PROBE, p.z - p.nz * DOWNHILL_PROBE)
      - groundHeight(grid, p.x + p.nx * DOWNHILL_PROBE, p.z + p.nz * DOWNHILL_PROBE);
  }
  if (downhill < 0) for (const p of out) { p.nx = -p.nx; p.nz = -p.nz; }
  return out;
}

/** All roads as one vertex-coloured ribbon mesh, or null when there are none. */
export function createRoadMesh(grid: TerrainGrid, material: THREE.Material): THREE.Mesh | null {
  const positions: number[] = [], colours: number[] = [], indices: number[] = [];
  const verge = new THREE.Color(VERGE), gravel = new THREE.Color(GRAVEL);
  for (const road of ROADS) {
    const samples = sampleRoad(road, RIBBON_STEP, grid);
    const half = road.width / 2;
    const base = positions.length / 3;
    for (const p of samples) {
      // Left edge, centre line, right edge: darker verges, lighter worn gravel down the middle.
      for (const [offset, c] of [[-half, verge], [0, gravel], [half, verge]] as const) {
        const x = p.x + p.nx * offset, z = p.z + p.nz * offset;
        positions.push(x, groundHeight(grid, x, z) + LIFT, z);
        colours.push(c.r, c.g, c.b);
      }
    }
    for (let i = 0; i + 1 < samples.length; i++) {
      const a = base + i * 3, b = a + 3;
      // Counter-clockwise seen from above; the normal's side and the tangent decide the winding.
      const flip = samples[i]!.tx * samples[i]!.nz - samples[i]!.tz * samples[i]!.nx > 0;
      for (const k of [0, 1]) {
        const p0 = a + k, p1 = a + k + 1, q0 = b + k, q1 = b + k + 1;
        if (flip) indices.push(p0, p1, q1, p0, q1, q0);
        else indices.push(p0, q1, p1, p0, q0, q1);
      }
    }
  }
  if (indices.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  geometry.setIndex(new THREE.Uint32BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'roads';
  return mesh;
}
