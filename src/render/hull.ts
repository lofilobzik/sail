/**
 * Hull, transom, deck and cockpit well, lofted from the section table in
 * data/laser.json `visual.hullSections` (see BoatLayout.sectionPoint).
 */
import * as THREE from 'three';
import { bodyToLocal, mapToBody } from './bodyFrame';
import type { BoatLayout } from './boatLayout';

const HULL_COLOR = 0xf4f4f0; // visual estimate: white gelcoat
const DECK_COLOR = 0xdcdcd6; // visual estimate: grey-white non-skid
const COCKPIT_COLOR = 0xcfd0cb; // visual estimate
const BOOT_COLOR = 0x2a5d8a; // visual estimate: waterline stripe below z = BOOT_TOP
const BOOT_TOP = 0.02; // visual estimate: stripe top above the waterline, m

function hullMaterial(): THREE.Material {
  return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, side: THREE.DoubleSide });
}

/** Station x positions, denser toward the bow where the shape changes fastest. */
function stations(layout: BoatLayout, n: number): number[] {
  const xs: number[] = [];
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    xs.push(layout.transomX + layout.loa * (1 - (1 - s) ** 1.3));
  }
  return xs;
}

function hullShell(layout: BoatLayout): THREE.BufferGeometry {
  const v = layout.model.cfg.visual;
  const xs = stations(layout, v.hullStations);
  const P = v.sectionPoints;
  const pos: number[] = [];
  const col: number[] = [];
  const hullColor = new THREE.Color(HULL_COLOR);
  const boot = new THREE.Color(BOOT_COLOR);
  const p = new THREE.Vector3();
  for (const x of xs) {
    for (let j = -P; j <= P; j++) {
      const { y, z } = layout.sectionPoint(x, Math.abs(j) / P);
      bodyToLocal(x, Math.sign(j) * y, z, p);
      pos.push(p.x, p.y, p.z);
      const c = z < BOOT_TOP ? boot : hullColor;
      col.push(c.r, c.g, c.b);
    }
  }
  const row = 2 * P + 1;
  const idx: number[] = [];
  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = 0; j < row - 1; j++) {
      const a = i * row + j;
      const b = a + row;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  // Transom cap: fan over station 0 from the deck centre.
  const centre = pos.length / 3;
  bodyToLocal(xs[0]!, 0, layout.sheerAt(xs[0]!), p);
  pos.push(p.x, p.y, p.z);
  col.push(hullColor.r, hullColor.g, hullColor.b);
  for (let j = 0; j < row - 1; j++) idx.push(centre, j, j + 1);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Rounded-rectangle cockpit outline in body (x, y). */
function cockpitOutline(layout: BoatLayout): THREE.Vector2[] {
  const c = layout.cockpit;
  const shape = new THREE.Shape();
  const r = c.radius;
  shape.moveTo(c.aft + r, -c.halfWidth);
  shape.lineTo(c.fore - r, -c.halfWidth);
  shape.quadraticCurveTo(c.fore, -c.halfWidth, c.fore, -c.halfWidth + r);
  shape.lineTo(c.fore, c.halfWidth - r);
  shape.quadraticCurveTo(c.fore, c.halfWidth, c.fore - r, c.halfWidth);
  shape.lineTo(c.aft + r, c.halfWidth);
  shape.quadraticCurveTo(c.aft, c.halfWidth, c.aft, c.halfWidth - r);
  shape.lineTo(c.aft, -c.halfWidth + r);
  shape.quadraticCurveTo(c.aft, -c.halfWidth, c.aft + r, -c.halfWidth);
  return shape.getPoints(3);
}

function deck(layout: BoatLayout, hole: THREE.Vector2[]): THREE.BufferGeometry {
  const xs = stations(layout, layout.model.cfg.visual.hullStations);
  const outline = new THREE.Shape();
  xs.forEach((x, i) => (i === 0 ? outline.moveTo(x, layout.halfBeamAt(x)) : outline.lineTo(x, layout.halfBeamAt(x))));
  // The bow station has zero half-beam: skip it on the way back to avoid a duplicate point.
  for (let i = xs.length - 2; i >= 0; i--) outline.lineTo(xs[i]!, -layout.halfBeamAt(xs[i]!));
  outline.holes.push(new THREE.Path(hole));
  return mapToBody(new THREE.ShapeGeometry(outline), (x, y) => [x, y, layout.sheerAt(x)]);
}

function cockpitWell(layout: BoatLayout, outline: THREE.Vector2[]): THREE.BufferGeometry {
  const floorZ = layout.cockpit.floorZ;
  const pos: number[] = [];
  const p = new THREE.Vector3();
  const pts = [...outline, outline[0]!];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const quad = [
      [a.x, a.y, layout.sheerAt(a.x)],
      [b.x, b.y, layout.sheerAt(b.x)],
      [a.x, a.y, floorZ],
      [b.x, b.y, layout.sheerAt(b.x)],
      [b.x, b.y, floorZ],
      [a.x, a.y, floorZ],
    ] as const;
    for (const [x, y, z] of quad) {
      bodyToLocal(x, y, z, p);
      pos.push(p.x, p.y, p.z);
    }
  }
  const walls = new THREE.BufferGeometry();
  walls.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  walls.computeVertexNormals();
  const floor = mapToBody(new THREE.ShapeGeometry(new THREE.Shape(outline)), (x, y) => [x, y, floorZ]);
  return mergeSimple([walls, floor]);
}

/** Concatenates non-indexed position/normal geometries. */
function mergeSimple(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  for (const part of parts) {
    const g = part.index ? part.toNonIndexed() : part;
    pos.push(...(g.getAttribute('position').array as Float32Array));
    nrm.push(...(g.getAttribute('normal').array as Float32Array));
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return out;
}

export function createHull(layout: BoatLayout): THREE.Group {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(hullShell(layout), hullMaterial()));
  const hole = cockpitOutline(layout);
  g.add(new THREE.Mesh(deck(layout, hole), new THREE.MeshStandardMaterial({ color: DECK_COLOR, roughness: 0.8, side: THREE.DoubleSide })));
  g.add(new THREE.Mesh(cockpitWell(layout, hole), new THREE.MeshStandardMaterial({ color: COCKPIT_COLOR, roughness: 0.8, side: THREE.DoubleSide })));
  return g;
}
