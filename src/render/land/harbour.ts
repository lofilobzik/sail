/**
 * Westcove Harbour's built parts (data/bay.json `harbour`): crisp paved slabs over the quay and the
 * breakwater mole (the 20 m terrain grid alone would round their edges), bollards and lamp posts along
 * the water edge, floating finger pontoons with a ramp down from the quay, and the shop and sheds
 * with painted signs on the faces toward the water. Everything is merged vertex-coloured geometry
 * except the signs, which are one small textured quad each. Sizes and colours are VISUAL ESTIMATE.
 */
import * as THREE from 'three';
import { BAY } from '../../sim/terrain';
import { merge, paint } from './parts';

const SLAB_LIFT = 0.05; // m: the slab top stands this far above the terrain plane so the two never z-fight
const SLAB_FOOTING = 8; // m: walls run down below the lowest seabed beside the quay
const PAVING = 0x8d8a82;
const COPING = 0xb9b5aa; // pale stone edge along the slab
const COPING_WIDTH = 0.9;
const COPING_RISE = 0.18;
const BOLLARD_SPACING = 14; // m along the water edge
const BOLLARD = 0x2b2f33;
const LAMP_SPACING = 42;
const LAMP_HEIGHT = 5.2;
const PONTOON_FREEBOARD = 0.4; // m above the water: the pontoons do not move with the waves
const PONTOON_DECK = 0x8b7355;
const PONTOON_FLOAT = 0x4d5a63;
const PILE = 0x3d3a34;
const DOOR = 0x2f3a40;
const SIGN_BOARD = { width: 0.6, height: 0.17 }; // fractions of the building's long side and wall height
const EAVE_OVERHANG = 0.5; // m

const at = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);
const box = (w: number, h: number, d: number, colour: THREE.ColorRepresentation, x: number, y: number, z: number) =>
  paint(new THREE.BoxGeometry(w, h, d), colour, at(x, y, z));

interface Rect { x0: number; z0: number; x1: number; z1: number }
const centre = (r: Rect) => ({ x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 });

/** The paved quay/mole slab with a coping stone ring around its top edge. */
function slab(r: Rect, height: number): THREE.BufferGeometry[] {
  const top = height + SLAB_LIFT, { x, z } = centre(r);
  const w = r.x1 - r.x0, d = r.z1 - r.z0;
  const copingY = top + COPING_RISE / 2;
  return [
    box(w, top + SLAB_FOOTING, d, PAVING, x, (top - SLAB_FOOTING) / 2, z),
    box(w, COPING_RISE, COPING_WIDTH, COPING, x, copingY, r.z0 + COPING_WIDTH / 2),
    box(w, COPING_RISE, COPING_WIDTH, COPING, x, copingY, r.z1 - COPING_WIDTH / 2),
    box(COPING_WIDTH, COPING_RISE, d, COPING, r.x0 + COPING_WIDTH / 2, copingY, z),
    box(COPING_WIDTH, COPING_RISE, d, COPING, r.x1 - COPING_WIDTH / 2, copingY, z),
  ];
}

function bollard(x: number, y: number, z: number): THREE.BufferGeometry {
  return paint(new THREE.CylinderGeometry(0.28, 0.34, 0.7, 8), BOLLARD, at(x, y + 0.35, z));
}

function lamp(x: number, y: number, z: number): THREE.BufferGeometry[] {
  return [
    paint(new THREE.CylinderGeometry(0.09, 0.13, LAMP_HEIGHT, 6), BOLLARD, at(x, y + LAMP_HEIGHT / 2, z)),
    paint(new THREE.SphereGeometry(0.35, 8, 6), 0xf3ead0, at(x, y + LAMP_HEIGHT + 0.2, z)),
  ];
}

/** Bollards (and lamps, set back) at even spacing along one straight water edge of a slab. */
function waterEdge(from: [number, number], to: [number, number], inward: [number, number], y: number): THREE.BufferGeometry[] {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const count = Math.max(1, Math.floor(length / BOLLARD_SPACING));
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    const x = from[0] + (to[0] - from[0]) * t, z = from[1] + (to[1] - from[1]) * t;
    parts.push(bollard(x + inward[0] * 1.6, y, z + inward[1] * 1.6));
    if (i % Math.max(1, Math.round(LAMP_SPACING / BOLLARD_SPACING)) === 0) parts.push(...lamp(x + inward[0] * 3.2, y, z + inward[1] * 3.2));
  }
  return parts;
}

/** A floating finger pontoon from its inboard end at x0 out to x1, with piles at the outer corners and a ramp to the quay. */
function pontoon(r: Rect, quayTop: number): THREE.BufferGeometry[] {
  const { x, z } = centre(r), w = r.x1 - r.x0, d = r.z1 - r.z0;
  const parts = [
    box(w, 0.22, d, PONTOON_DECK, x, PONTOON_FREEBOARD - 0.11, z),
    box(w, 0.42, d * 0.7, PONTOON_FLOAT, x, PONTOON_FREEBOARD - 0.43, z),
    paint(new THREE.CylinderGeometry(0.16, 0.16, 3.2, 6), PILE, at(r.x1, 0.9, r.z0 - 0.3)),
    paint(new THREE.CylinderGeometry(0.16, 0.16, 3.2, 6), PILE, at(r.x1, 0.9, r.z1 + 0.3)),
  ];
  // A gangway from the quay edge (x0) down to the deck, sloping over 8 m.
  const run = 8, drop = quayTop - PONTOON_FREEBOARD, slope = Math.atan2(drop, run);
  const ramp = new THREE.BoxGeometry(Math.hypot(run, drop), 0.12, d * 0.8);
  parts.push(paint(ramp, PONTOON_DECK, at(r.x0 - run / 2 - 0.1, quayTop - drop / 2, z).multiply(new THREE.Matrix4().makeRotationZ(slope))));
  return parts;
}

interface Building {
  name: string; sign: string; x: number; z: number; length: number; width: number; wall: number;
  wallColor: string; roofColor: string; signColor: string;
}

/**
 * A gable-roofed shed on the quay. Its long face (`length`, along z) looks east to the water, where
 * the sign hangs above a wide door; the ridge runs along z.
 */
function building(b: Building, quayTop: number): THREE.BufferGeometry[] {
  const y = quayTop, halfW = b.width / 2, halfL = b.length / 2;
  const rise = halfW * 0.5; // roof pitch about 27 degrees
  const roof = new THREE.BufferGeometry();
  const ex = halfW + EAVE_OVERHANG, ez = halfL + EAVE_OVERHANG;
  roof.setAttribute('position', new THREE.Float32BufferAttribute([
    // Two slopes (west -x, east +x) rising to the ridge, then the two gable ends.
    -ex, 0, -ez, -ex, 0, ez, 0, rise, ez, -ex, 0, -ez, 0, rise, ez, 0, rise, -ez,
    ex, 0, ez, ex, 0, -ez, 0, rise, -ez, ex, 0, ez, 0, rise, -ez, 0, rise, ez,
    -halfW, 0, ez, halfW, 0, ez, 0, rise, ez,
    halfW, 0, -ez, -halfW, 0, -ez, 0, rise, -ez,
  ], 3));
  roof.computeVertexNormals();
  const doorWidth = Math.min(b.length * 0.45, 9), doorHeight = Math.min(b.wall * 0.7, 4.4);
  return [
    box(b.width, b.wall, b.length, b.wallColor, b.x, y + b.wall / 2, b.z),
    paint(roof, b.roofColor, at(b.x, y + b.wall, b.z)),
    // Door on the east face, standing a whisker proud of the wall.
    box(0.15, doorHeight, doorWidth, DOOR, b.x + halfW + 0.05, y + doorHeight / 2, b.z),
  ];
}

/** A one-quad painted sign: lettering on a coloured board, facing east. */
function sign(b: Building, quayTop: number): THREE.Mesh {
  const width = b.length * SIGN_BOARD.width, height = Math.max(b.wall * SIGN_BOARD.height, 1.1);
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = Math.round(512 * (height / width));
  const g = canvas.getContext('2d')!;
  g.fillStyle = b.signColor;
  g.fillRect(0, 0, canvas.width, canvas.height);
  const dark = new THREE.Color(b.signColor).getHSL({ h: 0, s: 0, l: 0 }).l < 0.5;
  g.fillStyle = dark ? '#f6f1de' : '#1d2a33';
  g.font = `700 ${Math.round(canvas.height * 0.62)}px Georgia, "Times New Roman", serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(b.sign, canvas.width / 2, canvas.height / 2 + canvas.height * 0.04, canvas.width * 0.92);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshStandardMaterial({ map: texture, roughness: 0.7 }));
  mesh.name = `sign:${b.name}`;
  mesh.rotation.y = Math.PI / 2; // plane normal +z -> +x (east)
  mesh.position.set(b.x + b.width / 2 + 0.12, quayTop + b.wall * 0.86, b.z);
  return mesh;
}

export interface HarbourMeshes {
  /** The merged vertex-coloured structure mesh (uses the land `structures` material). */
  structures: THREE.Mesh;
  /** Sign boards: own textured materials, handed over so the caller can fog them toward the sky. */
  signs: THREE.Mesh[];
}

export function createHarbour(structures: THREE.Material): HarbourMeshes {
  const h = BAY.harbour;
  const parts: THREE.BufferGeometry[] = [];
  const paved = h.reclaimed.filter((r) => 'paved' in r && r.paved) as (Rect & { height: number })[];
  for (const r of paved) parts.push(...slab(r, r.height));
  const quay = paved[0]!, mole = paved[1]!;
  const quayTop = quay.height + SLAB_LIFT + COPING_RISE * 0.5;
  // Quay's seaward (east) face, then the mole's north face looking into the basin.
  parts.push(...waterEdge([quay.x1 - COPING_WIDTH, quay.z0 + 6], [quay.x1 - COPING_WIDTH, mole.z0 - 4], [-1, 0], quayTop));
  parts.push(...waterEdge([mole.x0 + 10, mole.z0 + COPING_WIDTH], [mole.x1 - 14, mole.z0 + COPING_WIDTH], [0, 1], quayTop));
  for (const p of h.pontoons) parts.push(...pontoon(p, quayTop));
  const buildings = h.buildings as Building[];
  for (const b of buildings) parts.push(...building(b, quayTop));
  const mesh = new THREE.Mesh(merge(parts), structures);
  mesh.name = 'harbour';
  return { structures: mesh, signs: buildings.map((b) => sign(b, quayTop)) };
}
