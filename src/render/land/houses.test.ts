import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BAY, terrainGrid } from '../../sim/terrain';
import { groundHeight, waterDistance } from './ground';
import { houseGeometry, type HouseSpec } from './houseModels';
import { cottageRow, type CottageRow } from './harbour';
import { placeHouses } from './houses';
import { faceted } from './parts';
import { ROADS, sampleRoad } from './roads';

const spec = (over: Partial<HouseSpec> = {}): HouseSpec => ({
  length: 9, width: 6.5, wall: 3.3, storeys: 1, roof: 'gable', pitch: 35, chimney: true, porch: true, sink: 0.5, doorSide: 1,
  wallColour: 0x8b877b, trimColour: 0xdcd5c1, roofColour: 0x4d555b, doorColour: 0xb3362a, chimneyColour: 0x7a4a3c, ...over,
});

const triangles = (g: ReturnType<typeof houseGeometry>): number => g.getAttribute('position').count / 3;

/** True when all three vertices of every triangle share one unit normal that is perpendicular to the triangle. */
function hasFaceNormals(g: ReturnType<typeof houseGeometry>): boolean {
  const p = g.getAttribute('position'), n = g.getAttribute('normal');
  for (let t = 0; t < p.count; t += 3) {
    const a = new THREE.Vector3().fromBufferAttribute(p, t), b = new THREE.Vector3().fromBufferAttribute(p, t + 1), c = new THREE.Vector3().fromBufferAttribute(p, t + 2);
    const face = b.clone().sub(a).cross(c.clone().sub(a));
    if (face.lengthSq() < 1e-12) continue; // a degenerate sliver has no normal to check
    face.normalize();
    for (let k = 0; k < 3; k++) {
      const v = new THREE.Vector3().fromBufferAttribute(n, t + k);
      if (Math.abs(v.length() - 1) > 1e-4 || v.dot(face) < 0.999) return false;
    }
  }
  return true;
}

describe('house models', () => {
  it('builds every roof shape as a coloured, normalled triangle soup', () => {
    for (const roof of ['gable', 'hip', 'saltbox', 'lean'] as const) {
      const g = houseGeometry(spec({ roof }));
      expect(g.getAttribute('color').count).toBe(g.getAttribute('position').count);
      expect(g.getAttribute('normal').count).toBe(g.getAttribute('position').count);
      expect(triangles(g)).toBeGreaterThan(60);
      expect(triangles(g)).toBeLessThan(400);
    }
  });

  it('bakes one face normal per triangle, so flat shading needs no screen-space derivatives', () => {
    for (const roof of ['gable', 'hip', 'saltbox', 'lean'] as const) expect(hasFaceNormals(houseGeometry(spec({ roof })))).toBe(true);
    expect(() => faceted(new THREE.BoxGeometry(1, 1, 1))).toThrow();
  });

  it('gives every vertex a fade colour: windows and doors melt into their wall, the rest into itself', () => {
    const s = spec();
    const g = houseGeometry(s);
    const colour = g.getAttribute('color'), base = g.getAttribute('baseColor');
    expect(base.count).toBe(colour.count);
    const wall = new THREE.Color(s.wallColour);
    let details = 0;
    for (let i = 0; i < base.count; i++) {
      const same = Math.abs(base.getX(i) - colour.getX(i)) + Math.abs(base.getY(i) - colour.getY(i)) + Math.abs(base.getZ(i) - colour.getZ(i)) < 1e-6;
      if (same) continue;
      details++;
      expect(base.getX(i)).toBeCloseTo(wall.r, 6);
      expect(base.getY(i)).toBeCloseTo(wall.g, 6);
      expect(base.getZ(i)).toBeCloseTo(wall.b, 6);
    }
    // A door, its trim and a dozen windows of frame and glass, two triangles each.
    expect(details).toBeGreaterThan(6 * 10);
  });

  it('builds barn doors and board-and-batten siding as extra faded detail', () => {
    const plain = houseGeometry(spec({ porch: false, chimney: false }));
    const shed = houseGeometry(spec({ porch: false, chimney: false, barnDoor: true, battens: true }));
    expect(triangles(shed)).toBeGreaterThan(triangles(plain) + 40);
    expect(hasFaceNormals(shed)).toBe(true);
  });

  it('stays within its footprint, rooted on the ground and below the chimney top', () => {
    const s = spec();
    const g = houseGeometry(s);
    g.computeBoundingBox();
    const box = g.boundingBox!;
    expect(box.min.y).toBeCloseTo(-s.sink, 6);
    // Plinth and eaves reach a little past the walls; the porch reaches out from the front.
    expect(box.max.x).toBeLessThan(s.length / 2 + 0.6);
    expect(box.min.x).toBeGreaterThan(-s.length / 2 - 0.6);
    expect(box.min.z).toBeGreaterThan(-s.width / 2 - 0.6);
    expect(box.max.z).toBeLessThan(s.width / 2 + 2.1);
    expect(box.max.y).toBeGreaterThan(s.wall + 1);
    expect(box.max.y).toBeLessThan(s.wall + 6);
  });

  it('costs more triangles for a porch, a chimney and a second storey', () => {
    const plain = triangles(houseGeometry(spec({ porch: false, chimney: false })));
    expect(triangles(houseGeometry(spec({ porch: true, chimney: false })))).toBeGreaterThan(plain);
    expect(triangles(houseGeometry(spec({ porch: false, chimney: true })))).toBeGreaterThan(plain);
    expect(triangles(houseGeometry(spec({ porch: false, chimney: false, storeys: 2, wall: 5.8 })))).toBeGreaterThan(plain);
  });
});

describe('Westcove roads and houses', () => {
  const grid = terrainGrid();
  const houses = placeHouses(grid, waterDistance(grid));

  it('has roads on dry ground that follow the hill, not the sea', () => {
    expect(ROADS.length).toBeGreaterThanOrEqual(2);
    for (const road of ROADS) {
      const samples = sampleRoad(road, 10, grid);
      expect(samples.length).toBeGreaterThan(10);
      for (const p of samples) expect(groundHeight(grid, p.x, p.z)).toBeGreaterThan(3);
      // The normal points downhill: east, toward the water, on this west shore.
      const east = samples.filter((p) => p.nx > 0).length;
      expect(east).toBe(samples.length);
    }
  });

  it('lines Westcove up along its roads, front to the water, on ground a house can stand on', () => {
    const town = BAY.towns.find((t) => t.name === 'Westcove')!;
    const near = houses.filter((h) => Math.hypot(h.x - town.x, h.z - town.z) < town.radius * 2.5);
    expect(near.length).toBeGreaterThan(60);
    const samples = ROADS.flatMap((r) => sampleRoad(r, 4, grid));
    let alongRoad = 0;
    for (const h of near) {
      const d = Math.min(...samples.map((p) => Math.hypot(h.x - p.x, h.z - p.z)));
      if (d < 22) alongRoad++;
      expect(groundHeight(grid, h.x, h.z)).toBeGreaterThan(3);
    }
    expect(alongRoad / near.length).toBeGreaterThan(0.8);
    // Fronts face +x (east, toward the water) within a quarter turn on every road house.
    const facing = near.filter((h) => Math.sin(h.yaw) > 0.7).length;
    expect(facing / near.length).toBeGreaterThan(0.8);
  });

  it('builds up the stepped terraces behind the harbour', () => {
    const terraces = BAY.harbour.reclaimed.filter((t) => 'houses' in t && t.houses);
    expect(terraces.length).toBeGreaterThanOrEqual(3);
    const onTerraces = houses.filter((h) => terraces.some((t) => h.x > t.x0 && h.x < t.x1 && h.z > t.z0 && h.z < t.z1));
    expect(onTerraces.length).toBeGreaterThan(15);
    // Each terrace is flat at its height where the houses stand.
    for (const t of terraces) expect(groundHeight(grid, (t.x0 + t.x1) / 2, (t.z0 + t.z1) / 2)).toBeCloseTo(t.height, 0);
  });

  it('keeps houses off the quay, the mole and the cottage terrace, and apart from each other', () => {
    for (const h of houses) {
      for (const r of BAY.harbour.reclaimed.filter((t) => !('houses' in t && t.houses))) {
        const inside = h.x > r.x0 - 12 && h.x < r.x1 + 12 && h.z > r.z0 - 12 && h.z < r.z1 + 12;
        expect(inside).toBe(false);
      }
    }
    for (let i = 0; i < houses.length; i += 7) {
      for (let j = i + 1; j < houses.length; j += 11) {
        const a = houses[i]!, b = houses[j]!;
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(4);
      }
    }
  });
});

describe('harbour cottage rows', () => {
  it('lines separate cottages up inside each row, small gaps apart, fronts toward the row facing', () => {
    let total = 0;
    (BAY.harbour.cottageRows as CottageRow[]).forEach((row, i) => {
      let seed = 1 + i;
      const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const cottages = cottageRow(row, random);
      expect(cottages.length).toBeGreaterThan(2);
      total += cottages.length;
      const facing = (row.facingDeg * Math.PI) / 180;
      const alongX = Math.abs(Math.cos(facing)) > Math.abs(Math.sin(facing));
      cottages.forEach((c, k) => {
        const half = c.spec.length / 2;
        const [centre, lo, hi] = alongX ? [c.x, row.x0, row.x1] : [c.z, row.z0, row.z1];
        expect(centre - half).toBeGreaterThanOrEqual(lo - 1e-9);
        expect(centre + half).toBeLessThanOrEqual(hi + 1e-9);
        expect(Math.sin(c.yaw)).toBeCloseTo(Math.sin(facing), 6);
        expect(Math.cos(c.yaw)).toBeCloseTo(-Math.cos(facing), 6);
        if (k > 0) {
          const prev = cottages[k - 1]!;
          const gap = alongX ? c.x - prev.x : c.z - prev.z;
          expect(gap - (c.spec.length + prev.spec.length) / 2).toBeGreaterThanOrEqual(2 - 1e-9);
        }
      });
    });
    expect(total).toBeGreaterThan(15);
  });
});
