/**
 * The bay's land: terrain, trees, houses and towns, Westcove Harbour and the landmarks, built once at startup
 * from sim/terrain.ts `terrainGrid()` and data/bay.json. Everything is stored in logical world
 * coordinates inside one group that is rebased with the floating origin, like the buoys; apart from
 * the waterborne harbour details, its matrices are static and only the group's changes on a rebase.
 * The static land sits in NEAR_CELL squares, so the split-depth near pass skips every square out of
 * its reach as a whole (beginNearPass) instead of walking and culling hundreds of meshes.
 * Land fogs toward the sky horizon (skyFog.ts) and draws before the water, so hills hide water
 * pixels by early depth rejection instead of overdrawing them.
 */
import * as THREE from 'three';
import { terrainGrid } from '../../sim/terrain';
import type { Vec2 } from '../../sim/frames';
import type { WaveConfig } from '../../physics/types';
import type { SkyView } from '../sky';
import { Footprints, waterDistance } from './ground';
import { fadeDetailBySize } from './detailFade';
import type { FloatingHarbour } from './floatingDocks';
import { createHarbour } from './harbour';
import { ROADS, createRoadMesh, sampleRoad } from './roads';
import { createHouseMeshes, placeHouses } from './houses';
import { createLandmarks } from './landmarks';
import { fogTowardSky } from './skyFog';
import { createTerrainMeshes } from './terrainMesh';
import { TreeField, placeTrees } from './trees';

const LAND_RENDER_ORDER = -1; // opaque land before the boats (0), the cockpit caps (0.5) and the water (1)
const NEAR_CELL = 500; // m: static land is grouped per square of this size (by each object's centre)

/** One square of static land and the logical-world x/z bounds of everything in it. */
interface NearCell {
  group: THREE.Group;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface LandView {
  group: THREE.Group;
  /** Near/far tree models, switched from the eye (scene.ts); null when the quality preset has no trees. */
  trees: TreeField | null;
  /**
   * Split-depth near pass from the logical eye (x, z): hides every square of static land farther than
   * `reach` m horizontally, the near camera's farthest frustum corner. endNearPass shows them again.
   */
  beginNearPass(x: number, z: number, reach: number): void;
  endNearPass(): void;
  /** Westcove berth cleat tops, indexed like BERTHS: [bow, stern]. */
  berthCleats: FloatingHarbour['berthCleats'];
  /** Rebase for the floating origin and update waterborne harbour details on the shared waves. */
  update(origin: Readonly<Vec2>, waves: WaveConfig, t: number): void;
}

/** The land; `withTrees` false (the low quality preset) leaves the trees out entirely. */
export function createLand(sky: SkyView, withTrees: boolean): LandView {
  const grid = terrainGrid();
  const group = new THREE.Group();
  group.name = 'land';

  // Lambert (diffuse only, VISUAL ESTIMATE): matte land shows little specular, and the per-pixel
  // lighting is much cheaper than the physical material's on the many land pixels.
  const ground = fogTowardSky(new THREE.MeshLambertMaterial({ vertexColors: true }), sky);
  // Houses and trees look faceted from face normals baked into their geometry (parts.ts `faceted`), not
  // from `flatShading`, whose screen-space derivatives shimmer on faces a few pixels across (far shores).
  // Open-ended cones and trunks: double-sided, so a hillside tree seen from below is not hollow.
  const foliage = fogTowardSky(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), sky);
  const buildings = fadeDetailBySize(fogTowardSky(new THREE.MeshLambertMaterial({ vertexColors: true }), sky));
  const structures = fogTowardSky(new THREE.MeshLambertMaterial({ vertexColors: true }), sky);

  const shore = waterDistance(grid);
  const houses = placeHouses(grid, shore);
  let trees: TreeField | null = null;
  if (withTrees) {
    const plots = new Footprints(16);
    for (const h of houses) plots.add(h.x, h.z, 0.5 * Math.hypot(h.length, h.width));
    // Trees keep off the roads: a disc every few metres along each.
    for (const road of ROADS) for (const p of sampleRoad(road, 5, grid)) plots.add(p.x, p.z, road.width / 2 + 2);
    trees = new TreeField(placeTrees(grid, shore, plots), foliage);
  }

  const harbour = createHarbour(structures, buildings, grid);
  for (const sign of harbour.signs) fogTowardSky(sign.material as THREE.MeshLambertMaterial, sky);

  group.add(
    ...createTerrainMeshes(grid, ground),
    ...(trees?.objects ?? []),
    ...createHouseMeshes(houses, buildings),
    ...createLandmarks(grid, structures),
    harbour.structures,
    harbour.buildings,
    harbour.afloat.group,
    ...[createRoadMesh(grid, ground)].filter((m) => m !== null),
    ...harbour.signs,
  );
  group.traverse((o) => { o.renderOrder = LAND_RENDER_ORDER; });
  // Static land: compose each matrix once, then file it into its square. Only the afloat harbour
  // details move per frame; they stay a direct child, always walked.
  group.matrixAutoUpdate = false;
  group.updateMatrixWorld(true); // the group is still at the logical origin: world bounds are logical
  const cells = new Map<string, NearCell>();
  const bounds = new THREE.Box3();
  for (const child of [...group.children]) {
    if (child === harbour.afloat.group) continue;
    child.traverse((o) => { o.updateMatrix(); o.matrixAutoUpdate = false; });
    child.updateMatrixWorld(true);
    bounds.setFromObject(child);
    if (bounds.isEmpty()) continue; // nothing to draw in either pass
    const key = `${Math.floor((bounds.min.x + bounds.max.x) / 2 / NEAR_CELL)},${Math.floor((bounds.min.z + bounds.max.z) / 2 / NEAR_CELL)}`;
    let cell = cells.get(key);
    if (!cell) {
      const square = new THREE.Group();
      square.matrixAutoUpdate = false;
      // A group sets the sort order of everything inside it: keep the land's.
      square.renderOrder = LAND_RENDER_ORDER;
      group.add(square);
      cell = { group: square, minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
      cells.set(key, cell);
    }
    cell.group.add(child);
    cell.minX = Math.min(cell.minX, bounds.min.x);
    cell.minZ = Math.min(cell.minZ, bounds.min.z);
    cell.maxX = Math.max(cell.maxX, bounds.max.x);
    cell.maxZ = Math.max(cell.maxZ, bounds.max.z);
  }
  const squares = [...cells.values()];
  let lastX = NaN;
  let lastZ = NaN;

  return {
    group,
    trees,
    beginNearPass(x, z, reach) {
      for (const c of squares) {
        const dx = Math.max(c.minX - x, 0, x - c.maxX);
        const dz = Math.max(c.minZ - z, 0, z - c.maxZ);
        c.group.visible = dx * dx + dz * dz <= reach * reach;
      }
    },
    endNearPass() {
      for (const c of squares) c.group.visible = true;
    },
    berthCleats: harbour.afloat.berthCleats,
    update(origin, waves, t) {
      if (origin.x !== lastX || origin.z !== lastZ) {
        lastX = origin.x;
        lastZ = origin.z;
        group.position.set(-origin.x, 0, -origin.z);
        group.updateMatrix();
      }
      harbour.afloat.update(waves, t);
    },
  };
}
