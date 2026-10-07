/**
 * Render-only quay work clusters. Every dimension, colour, segment count, placement and deterministic
 * variation below is a VISUAL ESTIMATE; see data/bay.json sources.quayProps. No collision geometry.
 */
import * as THREE from 'three';
import { BAY } from '../../sim/terrain';
import { faceted, merge, paint } from './parts';

// VISUAL ESTIMATE: weathered wood and galvanised cages, pale floats with sparse muted orange accents.
const WOOD = [0x95836a, 0xa49378, 0x82735e];
const BATTEN = 0xb1a084;
const HOOP = 0x626967;
const CAGE = 0x728079;
const FLOAT = [0xd8d4bf, 0xb0c5c1, 0xc9cbd0, 0xb8c2ab, 0xc38456];
const ROPE = 0xb5a17a;
const at = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);
const box = (w: number, h: number, d: number, colour: number, x: number, y: number, z: number) =>
  paint(new THREE.BoxGeometry(w, h, d), colour, at(x, y, z));

/** VISUAL ESTIMATE: closed 1.1 x 0.85 x 0.95 m packing crates with raised battens on every side and lid. */
function crate(colour: number): THREE.BufferGeometry {
  const w = 1.1, h = 0.85, d = 0.95;
  const parts = [box(w, h, d, colour, 0, h / 2, 0)];
  for (const side of [-1, 1]) {
    for (const offset of [-0.3, 0.3]) {
      parts.push(box(0.07, h, 0.095, BATTEN, side * (w / 2 + 0.025), h / 2, offset));
      parts.push(box(0.095, h, 0.07, BATTEN, offset, h / 2, side * (d / 2 + 0.025)));
    }
  }
  for (const x of [-0.3, 0.3]) parts.push(box(0.095, 0.05, d, BATTEN, x, h + 0.025, 0));
  return merge(parts);
}

/** VISUAL ESTIMATE: squat 10-sided, closed timber barrels with two proud metal hoops. */
function barrel(colour: number): THREE.BufferGeometry {
  const parts = [paint(new THREE.CylinderGeometry(0.38, 0.34, 0.95, 10), colour, at(0, 0.475, 0))];
  for (const y of [0.18, 0.75]) {
    const r = 0.34 + (0.04 * y) / 0.95 + 0.016;
    parts.push(paint(new THREE.CylinderGeometry(r, r, 0.07, 10, 1, true), HOOP, at(0, y, 0)));
  }
  return merge(parts);
}

/** VISUAL ESTIMATE: 1.5 x 1.1 x 0.75 m open cages; sparse ribs and an open top entrance, never a solid box. */
function crabPot(): THREE.BufferGeometry {
  const w = 1.5, d = 1.1, h = 0.75, rail = 0.045;
  const parts: THREE.BufferGeometry[] = [];
  for (const y of [rail / 2, h - rail / 2]) {
    for (const side of [-1, 1]) {
      parts.push(box(w, rail, rail, CAGE, 0, y, side * d / 2));
      parts.push(box(rail, rail, d, CAGE, side * w / 2, y, 0));
    }
  }
  for (const side of [-1, 1]) {
    for (const x of [-w / 2, -w / 6, w / 6, w / 2]) {
      parts.push(box(rail, h, rail, CAGE, x, h / 2, side * d / 2));
    }
    parts.push(box(rail, h, rail, CAGE, side * w / 2, h / 2, 0));
    // Roof support stops beside the circular opening rather than crossing it.
    parts.push(box(0.46, rail, rail, CAGE, side * 0.52, h - rail / 2, 0));
  }
  const entrance = new THREE.TorusGeometry(0.24, 0.035, 4, 12);
  entrance.rotateX(Math.PI / 2);
  parts.push(paint(entrance, CAGE, at(0, h, 0)));
  return merge(parts);
}

/** VISUAL ESTIMATE: small bulb-shaped weathered fishing floats, with a short neck for the line. */
function fishingFloat(colour: number): THREE.BufferGeometry {
  const bulb = new THREE.SphereGeometry(0.24, 8, 6);
  bulb.scale(1, 1.35, 1);
  return merge([
    paint(bulb, colour, at(0, 0.324, 0)),
    paint(new THREE.CylinderGeometry(0.065, 0.08, 0.12, 6), colour, at(0, 0.69, 0)),
  ]);
}

/** VISUAL ESTIMATE: one continuous three-turn spiral, with a loose end, in four-sided rope. */
function ropeCoil(): THREE.BufferGeometry {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= 48; i++) {
    const t = i / 48, angle = t * Math.PI * 6, radius = 0.13 + t * 0.53;
    points.push(new THREE.Vector3(Math.cos(angle) * radius, 0.06, Math.sin(angle) * radius));
  }
  points.push(new THREE.Vector3(0.83, 0.06, 0.2), new THREE.Vector3(0.92, 0.06, 0.48));
  return paint(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 64, 0.045, 4, false), ROPE);
}

/**
 * Bake all data-driven work clusters into one faceted, vertex-coloured geometry for harbour merging.
 * surfaceY is the paved slab top in land logical world coordinates. No materials, meshes or updates.
 */
export function createQuayProps(surfaceY: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const [clusterIndex, cluster] of BAY.harbour.quayProps.entries()) {
    const clusterTransform = at(cluster.x, surfaceY, cluster.z)
      .multiply(new THREE.Matrix4().makeRotationY((cluster.yawDeg * Math.PI) / 180))
      .multiply(new THREE.Matrix4().makeScale(BAY.harbour.quayPropScale, BAY.harbour.quayPropScale, BAY.harbour.quayPropScale));
    const place = (geometry: THREE.BufferGeometry, x: number, y: number, z: number, yaw: number) => {
      geometry.applyMatrix4(at(x, y, z).multiply(new THREE.Matrix4().makeRotationY(yaw)));
      geometry.applyMatrix4(clusterTransform);
      parts.push(geometry);
    };
    // VISUAL ESTIMATE: 7 x 6 m model-space groups, enlarged by quayPropScale for harbour readability.
    for (let i = 0; i < cluster.crates; i++) {
      const slot = i % 4;
      place(crate(WOOD[(i + clusterIndex) % WOOD.length]!), -2.4 + (slot % 2) * 1.3,
        Math.floor(i / 4) * 0.9, -1.4 + Math.floor(slot / 2) * 1.2, 0.025 * ((i + clusterIndex) % 3 - 1));
    }
    for (let i = 0; i < cluster.barrels; i++) {
      place(barrel(WOOD[(i + clusterIndex + 1) % WOOD.length]!), 1 + (i % 2) * 0.95, 0,
        -1.4 + Math.floor(i / 2) * 1.05, (i + clusterIndex) * 0.19);
    }
    for (let i = 0; i < cluster.crabPots; i++) {
      place(crabPot(), -2.2 + (i % 2) * 1.8, Math.floor(i / 2) * 0.8, 1.8,
        0.04 * ((i + clusterIndex) % 3 - 1));
    }
    for (let i = 0; i < cluster.floats; i++) {
      place(fishingFloat(FLOAT[(i + clusterIndex) % FLOAT.length]!), 1.1 + (i % 3) * 0.57, 0,
        1.5 + Math.floor(i / 3) * 0.6, 0);
    }
    for (let i = 0; i < cluster.ropeCoils; i++) {
      place(ropeCoil(), 3.1, 0, 0.1 + i * 1.6, clusterIndex * 0.4);
    }
  }
  return faceted(merge(parts));
}
