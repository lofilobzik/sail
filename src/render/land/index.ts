/**
 * The bay's land: terrain, trees, houses and towns, Westcove Harbour and the landmarks, built once at startup
 * from sim/terrain.ts `terrainGrid()` and data/bay.json. Everything is stored in logical world
 * coordinates inside one group that is rebased with the floating origin each frame, like the buoys.
 * Land fogs toward the sky horizon (skyFog.ts) and draws before the water, so hills hide water
 * pixels by early depth rejection instead of overdrawing them.
 */
import * as THREE from 'three';
import { terrainGrid } from '../../sim/terrain';
import type { Vec2 } from '../../sim/frames';
import type { SkyView } from '../sky';
import { Footprints, waterDistance } from './ground';
import { fadeDetailBySize } from './detailFade';
import { createHarbour } from './harbour';
import { ROADS, createRoadMesh, sampleRoad } from './roads';
import { createHouseMeshes, placeHouses } from './houses';
import { createLandmarks } from './landmarks';
import { fogTowardSky } from './skyFog';
import { createTerrainMeshes } from './terrainMesh';
import { createTreeMeshes, placeTrees } from './trees';

const LAND_RENDER_ORDER = -1; // opaque land before the water (renderOrder 0)

export interface LandView {
  group: THREE.Group;
  /** Rebase for the floating origin; logical world doubles compose on the CPU before upload. */
  update(origin: Readonly<Vec2>): void;
}

export function createLand(sky: SkyView): LandView {
  const grid = terrainGrid();
  const group = new THREE.Group();
  group.name = 'land';

  // Roughness values are VISUAL ESTIMATE: matte ground and foliage, slightly smoother masonry.
  const ground = fogTowardSky(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }), sky);
  // Houses and trees look faceted from face normals baked into their geometry (parts.ts `faceted`), not
  // from `flatShading`, whose screen-space derivatives shimmer on faces a few pixels across (far shores).
  // Open-ended cones and trunks: double-sided, so a hillside tree seen from below is not hollow.
  const foliage = fogTowardSky(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }), sky);
  const buildings = fadeDetailBySize(fogTowardSky(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), sky));
  const structures = fogTowardSky(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }), sky);

  const shore = waterDistance(grid);
  const houses = placeHouses(grid, shore);
  const plots = new Footprints(16);
  for (const h of houses) plots.add(h.x, h.z, 0.5 * Math.hypot(h.length, h.width));
  // Trees keep off the roads: a disc every few metres along each.
  for (const road of ROADS) for (const p of sampleRoad(road, 5, grid)) plots.add(p.x, p.z, road.width / 2 + 2);
  const trees = placeTrees(grid, shore, plots);

  const harbour = createHarbour(structures, buildings, grid);
  for (const sign of harbour.signs) fogTowardSky(sign.material as THREE.MeshStandardMaterial, sky);

  group.add(
    ...createTerrainMeshes(grid, ground),
    ...createTreeMeshes(trees, foliage),
    ...createHouseMeshes(houses, buildings),
    ...createLandmarks(grid, structures),
    harbour.structures,
    harbour.buildings,
    ...[createRoadMesh(grid, ground)].filter((m) => m !== null),
    ...harbour.signs,
  );
  group.traverse((o) => { o.renderOrder = LAND_RENDER_ORDER; });

  return {
    group,
    update(origin) {
      group.position.set(-origin.x, 0, -origin.z);
    },
  };
}
