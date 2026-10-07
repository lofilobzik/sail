/**
 * House models: a gabled, hipped, saltbox or lean-to body with a plinth, eaves, a door, windows on
 * all four faces, and optionally a chimney and a porch, built from a small spec in local space (the
 * footprint centred on x/z = 0, the ridge along x, the front door on +z, the ground at y = 0) and
 * baked into one vertex-coloured geometry, so a whole district merges into a few draw calls.
 *
 * Colours are weathered Pacific Northwest: cedar and silver greys, faded sage, slate blue, rust and
 * ochre, with a few saturated accents (barn red, teal, mustard, cobalt) on some walls and most doors.
 * Every size and colour here is VISUAL ESTIMATE.
 */
import * as THREE from 'three';
import { faceted, merge, paint } from './parts';

export type RoofShape = 'gable' | 'hip' | 'saltbox' | 'lean';

export interface HouseSpec {
  length: number; // m along the ridge (x)
  width: number; // m across (z); the front door is on +z
  wall: number; // m from the ground to the eaves
  storeys: 1 | 2;
  roof: RoofShape;
  /** Roof pitch, degrees. */
  pitch: number;
  chimney: boolean;
  porch: boolean;
  /** Metres the plinth reaches below the ground, so a house on a slope never floats. */
  sink: number;
  /** -1 or 1: which end of the front the door is nearer. */
  doorSide: -1 | 1;
  wallColour: number;
  trimColour: number;
  roofColour: number;
  doorColour: number;
  chimneyColour: number;
  /** A wide double barn door in the middle of the front instead of the house door (boathouses, sheds). */
  barnDoor?: boolean;
  /** Board-and-batten siding: vertical battens a shade darker than the wall on every face. */
  battens?: boolean;
}

const PLINTH = 0x77746e; // concrete and stone
const GLASS = 0x2b343a;
const WOOD = 0x6b5a48; // porch boards and posts
const EAVE = 0.45; // m of roof overhang on the eaves
const RAKE = 0.3; // m of overhang past the gable ends
const PLINTH_HEIGHT = 0.5; // m of plinth above the ground

/** Weighted picks from the weathered palette. */
export const WALL_PALETTE: readonly [number, number][] = [
  [0x8b877b, 3], // cedar grey
  [0x9ba39f, 2], // silver
  [0x7e9080, 2], // faded sage
  [0x667a8c, 2], // slate blue
  [0x8a4d3f, 1.5], // faded rust
  [0xb09a62, 1.5], // ochre
  [0xcfc8b2, 1.5], // cream
  [0x4c5254, 1], // charcoal
  [0x4f6657, 1], // spruce green
];
export const ACCENT_PALETTE: readonly number[] = [0xa13222, 0xd9a323, 0x1f7f7a, 0x2f62a6]; // barn red, mustard, teal, cobalt
export const ROOF_PALETTE: readonly [number, number][] = [
  [0x4d555b, 3], // slate
  [0x3a3f43, 2], // charcoal metal
  [0x6d5a49, 2.5], // cedar shingle
  [0x5b6a4f, 1], // mossy
  [0x7b4c38, 1], // rusty metal
  [0x40574a, 1], // green metal
];
export const TRIM_PALETTE: readonly [number, number][] = [[0xdcd5c1, 5], [0xe8e6df, 2], [0x3b4044, 1.5]];
export const DOOR_PALETTE: readonly [number, number][] = [
  [0xb3362a, 1.5], [0x1f7f7a, 1.5], [0xd9a323, 1], [0x2f62a6, 1], [0x3b2f2a, 3], [0xe8e6df, 1.5],
];
export const CHIMNEY_PALETTE: readonly [number, number][] = [[0x7a4a3c, 3], [0x6f6d68, 2], [0x3a3f43, 1]];

/** A weighted pick; `u` is a uniform random number in [0, 1). */
export function pick(palette: readonly [number, number][], u: number): number {
  const total = palette.reduce((sum, [, w]) => sum + w, 0);
  let t = u * total;
  for (const [colour, w] of palette) {
    t -= w;
    if (t < 0) return colour;
  }
  return palette[palette.length - 1]![0];
}

const at = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);
const box = (w: number, h: number, d: number, colour: number, x: number, y: number, z: number): THREE.BufferGeometry =>
  paint(new THREE.BoxGeometry(w, h, d), colour, at(x, y, z));

/** A triangle fan / list from flat coordinates, flat-shaded and painted. */
function tris(coords: number[], colour: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(coords, 3));
  g.computeVertexNormals();
  return paint(g, colour);
}

/** A flat rectangle facing `face` (0 = +z, 1 = -z, 2 = +x, 3 = -x), centred at (x, y, z). */
function pane(w: number, h: number, colour: number, face: 0 | 1 | 2 | 3, x: number, y: number, z: number): THREE.BufferGeometry {
  const turn = [0, Math.PI, Math.PI / 2, -Math.PI / 2][face]!;
  return paint(new THREE.PlaneGeometry(w, h), colour, at(x, y, z).multiply(new THREE.Matrix4().makeRotationY(turn)));
}

/** A window: pale frame behind dark glass, on the given face. */
function windowParts(face: 0 | 1 | 2 | 3, x: number, y: number, z: number, trim: number): THREE.BufferGeometry[] {
  const n = 0.03;
  const out: [number, number, number] = face === 0 ? [0, 0, n] : face === 1 ? [0, 0, -n] : face === 2 ? [n, 0, 0] : [-n, 0, 0];
  return [
    pane(1.3, 1.6, trim, face, x + out[0] * 0.4, y + out[1], z + out[2] * 0.4),
    pane(1.0, 1.3, GLASS, face, x + out[0], y + out[1], z + out[2]),
  ];
}

function roofParts(s: HouseSpec): THREE.BufferGeometry[] {
  const { length: L, width: W, wall: H } = s;
  const rise = (W / 2 + EAVE) * Math.tan((s.pitch * Math.PI) / 180);
  const x0 = -L / 2 - RAKE, x1 = L / 2 + RAKE;
  const zf = W / 2 + EAVE, zb = -W / 2 - EAVE;
  const parts: THREE.BufferGeometry[] = [];
  switch (s.roof) {
    case 'gable':
    case 'saltbox': {
      // The saltbox ridge sits behind the middle, so the front slope is longer than the back.
      const rz = s.roof === 'saltbox' ? -W * 0.16 : 0;
      const ry = H + rise * (s.roof === 'saltbox' ? 1.15 : 1);
      parts.push(
        tris([x0, H, zf, x1, H, zf, x1, ry, rz, x0, H, zf, x1, ry, rz, x0, ry, rz], s.roofColour),
        tris([x1, H, zb, x0, H, zb, x0, ry, rz, x1, H, zb, x0, ry, rz, x1, ry, rz], s.roofColour),
        // Gable ends, in wall colour, flush with the walls.
        tris([L / 2, H, W / 2, L / 2, H, -W / 2, L / 2, ry - 0.05, rz], s.wallColour),
        tris([-L / 2, H, -W / 2, -L / 2, H, W / 2, -L / 2, ry - 0.05, rz], s.wallColour),
      );
      return parts;
    }
    case 'hip': {
      const ry = H + rise * 0.9;
      const half = Math.max(0.1, (L - W) / 2); // ridge half-length; a pyramid when the plan is nearly square
      const xr = half;
      parts.push(
        tris([x0, H, zf, x1, H, zf, xr, ry, 0, x0, H, zf, xr, ry, 0, -xr, ry, 0], s.roofColour),
        tris([x1, H, zb, x0, H, zb, -xr, ry, 0, x1, H, zb, -xr, ry, 0, xr, ry, 0], s.roofColour),
        tris([x1, H, zf, x1, H, zb, xr, ry, 0], s.roofColour),
        tris([x0, H, zb, x0, H, zf, -xr, ry, 0], s.roofColour),
      );
      return parts;
    }
    case 'lean': {
      // One slope, high at the back, falling to the front.
      const high = H + rise * 1.1, low = H + 0.08;
      parts.push(
        tris([x0, low, zf, x1, low, zf, x1, high, zb, x0, low, zf, x1, high, zb, x0, high, zb], s.roofColour),
        tris([L / 2, H, W / 2, L / 2, H, -W / 2, L / 2, high - 0.05, -W / 2, L / 2, H, W / 2, L / 2, high - 0.05, -W / 2, L / 2, low - 0.05, W / 2], s.wallColour),
        tris([-L / 2, H, -W / 2, -L / 2, H, W / 2, -L / 2, low - 0.05, W / 2, -L / 2, H, -W / 2, -L / 2, low - 0.05, W / 2, -L / 2, high - 0.05, -W / 2], s.wallColour),
      );
      return parts;
    }
  }
}

/**
 * Sets the colour a part fades to when it is too small on screen (detailFade.ts): `colour` (sRGB) for a
 * window or door, which melts into its wall, or the part's own colour when omitted.
 */
function fadesTo(part: THREE.BufferGeometry, colour?: number): THREE.BufferGeometry {
  const own = part.getAttribute('color') as THREE.BufferAttribute;
  if (colour === undefined) {
    part.setAttribute('baseColor', own.clone());
    return part;
  }
  const c = new THREE.Color(colour);
  const base = new Float32Array(own.count * 3);
  for (let i = 0; i < own.count; i++) base.set([c.r, c.g, c.b], i * 3);
  part.setAttribute('baseColor', new THREE.BufferAttribute(base, 3));
  return part;
}

const BATTEN_SPACING = 0.7; // m
const BATTEN_WIDTH = 0.09; // m
const BATTEN_SHADE = 0.8; // of the wall colour

/** Vertical battens over every wall face, from the plinth to the eaves, a shade darker than the wall. */
function battens(s: HouseSpec): THREE.BufferGeometry[] {
  const { length: L, width: W, wall: H } = s;
  const colour = new THREE.Color(s.wallColour).multiplyScalar(BATTEN_SHADE).getHex();
  const h = H - PLINTH_HEIGHT, y = PLINTH_HEIGHT + h / 2;
  const out: THREE.BufferGeometry[] = [];
  for (let x = -L / 2 + BATTEN_SPACING / 2; x < L / 2; x += BATTEN_SPACING) {
    out.push(pane(BATTEN_WIDTH, h, colour, 0, x, y, W / 2 + 0.01), pane(BATTEN_WIDTH, h, colour, 1, x, y, -W / 2 - 0.01));
  }
  for (let z = -W / 2 + BATTEN_SPACING / 2; z < W / 2; z += BATTEN_SPACING) {
    out.push(pane(BATTEN_WIDTH, h, colour, 2, L / 2 + 0.01, y, z), pane(BATTEN_WIDTH, h, colour, 3, -L / 2 - 0.01, y, z));
  }
  return out;
}

/** Height of the ridge above the eaves, for the chimney. */
function ridgeRise(s: HouseSpec): number {
  const rise = (s.width / 2 + EAVE) * Math.tan((s.pitch * Math.PI) / 180);
  return rise * (s.roof === 'lean' ? 1.1 : s.roof === 'saltbox' ? 1.15 : s.roof === 'hip' ? 0.9 : 1);
}

/**
 * The house as one vertex-coloured geometry in local space. The same spec always builds the same
 * house; windows are laid out from the plan alone.
 */
export function houseGeometry(s: HouseSpec): THREE.BufferGeometry {
  const { length: L, width: W, wall: H } = s;
  const parts: THREE.BufferGeometry[] = [];

  // Plinth and walls.
  parts.push(box(L + 0.2, s.sink + PLINTH_HEIGHT, W + 0.2, PLINTH, 0, (PLINTH_HEIGHT - s.sink) / 2, 0));
  parts.push(box(L, H - PLINTH_HEIGHT, W, s.wallColour, 0, PLINTH_HEIGHT + (H - PLINTH_HEIGHT) / 2, 0));
  parts.push(...roofParts(s));

  // Front: a door near one end, windows in the rest of each storey.
  const doorX = s.doorSide * (L / 2 - 1.6);
  // The door stands on top of the plinth, which sticks out 0.1 m past the walls.
  // Windows and doors are details: too small on screen, they fade into the wall (detailFade.ts).
  const details: THREE.BufferGeometry[] = [];
  // Front door, or a barn door: a wide pair of leaves with a dark seam, centred on the front.
  const barn = s.barnDoor ? { width: Math.min(L * 0.4, 6), height: Math.min((H / s.storeys) * 0.85, 3.6) } : null;
  if (barn) {
    details.push(pane(barn.width + 0.3, barn.height + 0.2, s.trimColour, 0, 0, PLINTH_HEIGHT + (barn.height + 0.2) / 2, W / 2 + 0.015));
    details.push(pane(barn.width, barn.height, s.doorColour, 0, 0, PLINTH_HEIGHT + barn.height / 2, W / 2 + 0.03));
    details.push(pane(0.08, barn.height, GLASS, 0, 0, PLINTH_HEIGHT + barn.height / 2, W / 2 + 0.04));
  } else {
    details.push(pane(1.25, 2.3, s.trimColour, 0, doorX, PLINTH_HEIGHT + 1.15, W / 2 + 0.015));
    details.push(pane(1.0, 2.1, s.doorColour, 0, doorX, PLINTH_HEIGHT + 1.05, W / 2 + 0.03));
  }
  if (s.battens) details.push(...battens(s));
  const bays = Math.max(1, Math.floor((L - 1.5) / 3.1));
  const storeyHeight = H / s.storeys;
  for (let storey = 0; storey < s.storeys; storey++) {
    const y = storey * storeyHeight + Math.min(storeyHeight * 0.58, 1.9);
    for (let i = 0; i < bays; i++) {
      const x = -L / 2 + ((i + 0.5) * L) / bays;
      const nearDoor = storey === 0 && (barn ? Math.abs(x) < barn.width / 2 + 0.9 : Math.abs(x - doorX) < 1.4);
      if (!nearDoor) details.push(...windowParts(0, x, y, W / 2, s.trimColour));
      details.push(...windowParts(1, x, y, -W / 2, s.trimColour));
    }
    details.push(...windowParts(2, L / 2, y, 0, s.trimColour), ...windowParts(3, -L / 2, y, 0, s.trimColour));
  }

  if (s.porch) {
    // A small roofed landing in front of the door, on two posts.
    const px = doorX, pz = W / 2 + 0.85;
    parts.push(box(2.3, 0.18, 1.7, WOOD, px, 0.12, pz));
    parts.push(box(2.6, 0.14, 1.9, s.roofColour, px, 2.75, pz));
    parts.push(box(0.14, 2.6, 0.14, s.trimColour, px - 1.0, 1.4, pz + 0.75), box(0.14, 2.6, 0.14, s.trimColour, px + 1.0, 1.4, pz + 0.75));
  }

  if (s.chimney) {
    const cx = -s.doorSide * L * 0.28;
    const cz = s.roof === 'lean' ? -W * 0.25 : s.roof === 'saltbox' ? -W * 0.16 : 0;
    const top = H + ridgeRise(s) + 0.9;
    parts.push(box(0.75, top - H + 0.6, 0.75, s.chimneyColour, cx, H - 0.6 + (top - H + 0.6) / 2, cz));
    parts.push(box(0.95, 0.14, 0.95, PLINTH, cx, top + 0.07, cz));
  }

  return faceted(merge([...parts.map((p) => fadesTo(p)), ...details.map((d) => fadesTo(d, s.wallColour))]));
}
