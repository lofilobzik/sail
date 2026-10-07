/**
 * Westcove Harbour's built parts (data/bay.json `harbour`): crisp paved slabs over the quay and the
 * breakwater mole (the 20 m terrain grid alone would round their edges), a boardwalk, street and plaza
 * on the quay, fender piles and ladders down its face, bollards and lamp posts along the water edge,
 * working clusters of fishing gear, and the shop and sheds with painted signs facing the water.
 * Floating docks and moored dinghies live in floatingDocks.ts. Sizes and colours are VISUAL ESTIMATE.
 */
import * as THREE from 'three';
import { BAY, type TerrainGrid } from '../../sim/terrain';
import { groundHeight, seededRandom } from './ground';
import { createFloatingHarbour, type FloatingHarbour } from './floatingDocks';
import { houseGeometry, type HouseSpec, type RoofShape } from './houseModels';
import { makeSpec } from './houses';
import { merge, paint } from './parts';
import { createQuayProps } from './quayProps';

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
// Quay dressing. Anything laid on the slab stands at least OVERLAY_RISE proud of it, so it never
// z-fights with the paving from across the bay.
const OVERLAY_RISE = 0.1; // m
const BOARDWALK_WIDTH = 14; // m of timber deck along the quay's seaward edge
const BOARD_WIDTH = 2.4; // m per run of planks; alternate runs are a shade apart
const DECK = [0x8b7355, 0x7c6650];
const STREET_WIDTH = 8; // m of asphalt in front of the sheds, the full length of the quay
const STREET_SETBACK = 5; // m between the sheds' fronts and the street
const ASPHALT = 0x55585a;
const PLAZA = 0xa7a296; // pale stone in front of the Sail Loft
const PLAZA_MARGIN = 6; // m the plaza reaches past the Sail Loft at each end
const FENDER = 0x4a3f33; // tarred timber piles along the quay face
const FENDER_SPACING = 3; // m
const FENDER_FOOT = -1.5; // m: piles reach this far below the water
const LADDER = 0x5a5f63; // galvanised steel
const LADDER_SPACING = 32; // m along the quay face
const SIGN_BOARD = { width: 0.6, height: 0.17 }; // fractions of the building's long side and wall height
const COTTAGE_GAP = [2, 4]; // m between neighbours in a cottage row
const COTTAGE_SINK = 0.4; // m the plinth reaches below the ground
const SHED_TRIM = 0xe8e6df;
const SHED_CHIMNEY = 0x6f6d68;

const at = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);
const box = (w: number, h: number, d: number, colour: THREE.ColorRepresentation, x: number, y: number, z: number) =>
  paint(new THREE.BoxGeometry(w, h, d), colour, at(x, y, z));

interface Rect { x0: number; z0: number; x1: number; z1: number }
const centre = (r: Rect) => ({ x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 });

/** The paved quay/mole slab, with openings in the east coping for the gangways. */
function slab(r: Rect, height: number, eastOpenings: readonly { z0: number; z1: number }[] = []): THREE.BufferGeometry[] {
  const top = height + SLAB_LIFT, { x, z } = centre(r);
  const w = r.x1 - r.x0, d = r.z1 - r.z0;
  const copingY = top + COPING_RISE / 2;
  const parts = [
    box(w, top + SLAB_FOOTING, d, PAVING, x, (top - SLAB_FOOTING) / 2, z),
    box(w, COPING_RISE, COPING_WIDTH, COPING, x, copingY, r.z0 + COPING_WIDTH / 2),
    box(w, COPING_RISE, COPING_WIDTH, COPING, x, copingY, r.z1 - COPING_WIDTH / 2),
    box(COPING_WIDTH, COPING_RISE, d, COPING, r.x0 + COPING_WIDTH / 2, copingY, z),
  ];
  let start = r.z0;
  for (const opening of eastOpenings) {
    if (opening.z0 > start) parts.push(box(COPING_WIDTH, COPING_RISE, opening.z0 - start, COPING, r.x1 - COPING_WIDTH / 2, copingY, (start + opening.z0) / 2));
    start = opening.z1;
  }
  if (start < r.z1) parts.push(box(COPING_WIDTH, COPING_RISE, r.z1 - start, COPING, r.x1 - COPING_WIDTH / 2, copingY, (start + r.z1) / 2));
  return parts;
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


/** A flat deck or paving patch, OVERLAY_RISE proud of the slab top. */
function overlay(x0: number, z0: number, x1: number, z1: number, colour: number, slabTop: number): THREE.BufferGeometry {
  return box(x1 - x0, OVERLAY_RISE, z1 - z0, colour, (x0 + x1) / 2, slabTop + OVERLAY_RISE / 2, (z0 + z1) / 2);
}

/**
 * The quay's surface and seaward face: a timber boardwalk along the water, a street in front of the
 * sheds, a pale plaza before the Sail Loft, and tarred fender piles with steel ladders down the face.
 */
function quayDressing(quay: Rect, mole: Rect, slabTop: number, buildings: readonly Building[]): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const edge = quay.x1 - COPING_WIDTH;
  // Boardwalk: runs of planks across the quay's seaward strip, alternating in shade.
  const deckX0 = edge - BOARDWALK_WIDTH;
  for (let z = quay.z0 + COPING_WIDTH, i = 0; z < mole.z0; z += BOARD_WIDTH, i++) {
    parts.push(overlay(deckX0, z, edge, Math.min(z + BOARD_WIDTH, mole.z0), DECK[i % 2]!, slabTop));
  }
  // Street in front of the sheds, and the plaza before the Sail Loft between street and boardwalk.
  const front = Math.max(...buildings.map((b) => b.x + b.width / 2));
  const streetX0 = front + STREET_SETBACK;
  parts.push(overlay(streetX0, quay.z0 + COPING_WIDTH, streetX0 + STREET_WIDTH, quay.z1 - COPING_WIDTH, ASPHALT, slabTop));
  const loft = buildings.find((b) => b.name === 'Sail Loft');
  if (loft) {
    parts.push(overlay(streetX0 + STREET_WIDTH, loft.z - loft.length / 2 - PLAZA_MARGIN, deckX0, loft.z + loft.length / 2 + PLAZA_MARGIN, PLAZA, slabTop));
  }
  // Fender piles down the quay face and along the mole's basin side, with a waler near the top.
  const pileHeight = slabTop + 0.25 - FENDER_FOOT;
  for (let z = quay.z0 + 1.5; z < mole.z0; z += FENDER_SPACING) {
    parts.push(box(0.32, pileHeight, 0.32, FENDER, quay.x1 + 0.16, FENDER_FOOT + pileHeight / 2, z));
  }
  for (let x = mole.x0 + 1.5; x < mole.x1; x += FENDER_SPACING) {
    parts.push(box(0.32, pileHeight, 0.32, FENDER, x, FENDER_FOOT + pileHeight / 2, mole.z0 - 0.16));
  }
  parts.push(box(0.2, 0.3, mole.z0 - quay.z0, FENDER, quay.x1 + 0.42, slabTop - 0.5, (quay.z0 + mole.z0) / 2));
  parts.push(box(mole.x1 - mole.x0, 0.3, 0.2, FENDER, (mole.x0 + mole.x1) / 2, slabTop - 0.5, mole.z0 - 0.42));
  // Ladders between the pontoon gangways: two rails and a rung every 30 cm.
  for (let z = quay.z0 + LADDER_SPACING / 2; z < mole.z0 - 4; z += LADDER_SPACING) {
    const x = quay.x1 + 0.38, bottom = -1, top = slabTop + 0.9;
    for (const dz of [-0.22, 0.22]) parts.push(box(0.06, top - bottom, 0.06, LADDER, x, (top + bottom) / 2, z + dz));
    for (let y = bottom + 0.3; y < slabTop; y += 0.3) parts.push(box(0.05, 0.05, 0.44, LADDER, x, y, z));
  }
  return parts;
}

interface Building {
  name: string; sign: string; x: number; z: number; length: number; width: number; wall: number;
  wallColor: string; roofColor: string; signColor: string;
  roof?: RoofShape; door?: 'barn'; doorColor?: string; chimney?: boolean;
}

const hex = (colour: string): number => new THREE.Color(colour).getHex();

/**
 * A harbour building as a house model (houseModels.ts): board-and-batten siding, its long face
 * (`length`, along z) looking east to the water, a barn door or a front door there, under the sign.
 */
function shedSpec(b: Building): HouseSpec {
  return {
    length: b.length, width: b.width, wall: b.wall, storeys: b.wall >= 5.5 ? 2 : 1,
    roof: b.roof ?? 'gable', pitch: b.roof === 'hip' ? 28 : 34, chimney: b.chimney ?? false, porch: false,
    sink: COTTAGE_SINK, doorSide: 1, wallColour: hex(b.wallColor), trimColour: SHED_TRIM, roofColour: hex(b.roofColor),
    doorColour: hex(b.doorColor ?? '#2f3a40'), chimneyColour: SHED_CHIMNEY, barnDoor: b.door === 'barn', battens: true,
  };
}

export interface CottageRow { name: string; x0: number; z0: number; x1: number; z1: number; facingDeg: number }

/** Placed house models: separate cottages with small gaps along a row, fronts toward its compass `facingDeg`. */
export function cottageRow(row: CottageRow, random: () => number): { spec: HouseSpec; x: number; z: number; yaw: number }[] {
  const facing = (row.facingDeg * Math.PI) / 180;
  const dx = Math.sin(facing), dz = -Math.cos(facing); // compass bearing to world x east, z south
  const alongX = Math.abs(dz) > Math.abs(dx); // a row facing north or south runs east-west
  const [start, end] = alongX ? [row.x0, row.x1] : [row.z0, row.z1];
  const depth = alongX ? row.z1 - row.z0 : row.x1 - row.x0;
  const across = alongX ? (row.z0 + row.z1) / 2 : (row.x0 + row.x1) / 2;
  const out: { spec: HouseSpec; x: number; z: number; yaw: number }[] = [];
  let s = start + random() * COTTAGE_GAP[1]!;
  for (;;) {
    const spec = makeSpec(random, COTTAGE_SINK);
    spec.width = Math.min(spec.width, depth);
    if (s + spec.length > end) break;
    const along = s + spec.length / 2;
    out.push({ spec, x: alongX ? along : across, z: alongX ? across : along, yaw: Math.atan2(dx, dz) });
    s += spec.length + COTTAGE_GAP[0]! + random() * (COTTAGE_GAP[1]! - COTTAGE_GAP[0]!);
  }
  return out;
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
  /** The harbour buildings and the waterfront cottages (uses the land `buildings` material). */
  buildings: THREE.Mesh;
  /** Sign boards: own textured materials, handed over so the caller can fog them toward the sky. */
  signs: THREE.Mesh[];
  /** Waterborne docks and dinghies, updated on the shared waves within the rebased land group. */
  afloat: FloatingHarbour;
}

export function createHarbour(structures: THREE.Material, buildingMaterial: THREE.Material, grid: TerrainGrid): HarbourMeshes {
  const h = BAY.harbour;
  const parts: THREE.BufferGeometry[] = [];
  const paved = h.reclaimed.filter((r) => 'paved' in r && r.paved) as (Rect & { height: number })[];
  const quay = paved[0]!, mole = paved[1]!;
  const gangwayOpenings = h.pontoons.map((p) => ({ z0: p.z0, z1: p.z1 })).sort((a, b) => a.z0 - b.z0);
  for (const r of paved) parts.push(...slab(r, r.height, r === quay ? gangwayOpenings : []));
  const quayTop = quay.height + SLAB_LIFT + COPING_RISE * 0.5;
  // Quay's seaward (east) face, then the mole's north face looking into the basin.
  parts.push(...waterEdge([quay.x1 - COPING_WIDTH, quay.z0 + 6], [quay.x1 - COPING_WIDTH, mole.z0 - 4], [-1, 0], quayTop));
  parts.push(...waterEdge([mole.x0 + 10, mole.z0 + COPING_WIDTH], [mole.x1 - 14, mole.z0 + COPING_WIDTH], [0, 1], quayTop));
  const buildings = h.buildings as Building[];
  parts.push(...quayDressing(quay, mole, quay.height + SLAB_LIFT, buildings));
  parts.push(createQuayProps(quay.height + SLAB_LIFT));
  const mesh = new THREE.Mesh(merge(parts), structures);
  mesh.name = 'harbour';

  // Buildings stand on the slab where they are on the quay or mole, on the ground elsewhere.
  const slabTop = quay.height + SLAB_LIFT;
  const groundAt = (x: number, z: number): number =>
    paved.some((r) => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) ? slabTop : groundHeight(grid, x, z);
  const placed = [
    ...buildings.map((b) => ({ spec: shedSpec(b), x: b.x, z: b.z, yaw: Math.PI / 2 })),
    ...(h.cottageRows as CottageRow[]).flatMap((row, i) => cottageRow(row, seededRandom(BAY.seed * 6007 + i))),
  ];
  const up = new THREE.Vector3(0, 1, 0), q = new THREE.Quaternion(), position = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  const houses = new THREE.Mesh(merge(placed.map((p) => houseGeometry(p.spec).applyMatrix4(
    new THREE.Matrix4().compose(position.set(p.x, groundAt(p.x, p.z), p.z), q.setFromAxisAngle(up, p.yaw), one),
  ))), buildingMaterial);
  houses.name = 'harbour-buildings';
  return {
    structures: mesh, buildings: houses, signs: buildings.map((b) => sign(b, slabTop)),
    afloat: createFloatingHarbour(structures),
  };
}
