/**
 * Hull, transom, deck and cockpit well, lofted from the section table in
 * data/laser.json `visual.hullSections` (see BoatLayout.sectionPoint).
 */
import * as THREE from 'three';
import { bodyToLocal, mapToBody } from './bodyFrame';
import type { BoatLayout } from './boatLayout';
import details from '../../data/hull-details.json';
import { gelcoatSurface } from './hullSurface';

const HULL_COLOR = details.colours.gelcoat;
const BOOT_COLOR = 0x2a5d8a; // visual estimate: waterline stripe below z = BOOT_TOP
const BOOT_TOP = 0.02; // visual estimate: stripe top above the waterline, m

function hullMaterial(): THREE.Material {
  return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.65, side: THREE.DoubleSide });
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
export function cockpitOutline(layout: BoatLayout, offset = 0): THREE.Vector2[] {
  const original = layout.cockpit;
  const c = { aft: original.aft - offset, fore: original.fore + offset, halfWidth: original.halfWidth + offset };
  const shape = new THREE.Shape();
  const r = original.radius + offset;
  shape.moveTo(c.aft + r, -c.halfWidth);
  shape.lineTo(c.fore - r, -c.halfWidth);
  shape.quadraticCurveTo(c.fore, -c.halfWidth, c.fore, -c.halfWidth + r);
  shape.lineTo(c.fore, c.halfWidth - r);
  shape.quadraticCurveTo(c.fore, c.halfWidth, c.fore - r, c.halfWidth);
  shape.lineTo(c.aft + r, c.halfWidth);
  shape.quadraticCurveTo(c.aft, c.halfWidth, c.aft, c.halfWidth - r);
  shape.lineTo(c.aft, -c.halfWidth + r);
  shape.quadraticCurveTo(c.aft, -c.halfWidth, c.aft + r, -c.halfWidth);
  return shape.getPoints(details.coaming.cornerSegments);
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

/** A continuous rounded lip, smooth well walls and a moulded floor-to-wall fillet. */
function cockpitWell(layout: BoatLayout): THREE.BufferGeometry {
  const c = details.coaming;
  const floorZ = layout.cockpit.floorZ;
  // VISUAL ESTIMATE: profile in outward offset/height pairs. The outer edge meets
  // the deck hole exactly; the innermost edge meets the separate textured floor.
  const profile: readonly (readonly [number, number, boolean])[] = [
    [c.width, 0, true],
    [c.width * 0.72, c.height * 0.68, true],
    [c.width * 0.22, c.height, true],
    [0, c.height * 0.36, true],
    [0, c.floorRadius, false],
    [-c.floorRadius * 0.3, c.floorRadius * 0.24, false],
    [-c.floorRadius, 0, false],
  ];
  const pos: number[] = [];
  const indices: number[] = [];
  const p = new THREE.Vector3();
  const rings = profile.map(([offset]) => cockpitOutline(layout, offset));
  // Shape.getPoints includes its closing point; omit it so the seam shares normals.
  const count = rings[0]!.length - 1;
  for (let row = 0; row < profile.length; row++) {
    const [, height, fromSheer] = profile[row]!;
    for (let i = 0; i < count; i++) {
      const point = rings[row]![i]!;
      bodyToLocal(point.x, point.y, (fromSheer ? layout.sheerAt(point.x) : floorZ) + height, p);
      pos.push(p.x, p.y, p.z);
    }
  }
  for (let row = 0; row < profile.length - 1; row++) {
    for (let i = 0; i < count; i++) {
      const next = (i + 1) % count;
      const a = row * count + i;
      const b = row * count + next;
      const d = (row + 1) * count + i;
      const e = (row + 1) * count + next;
      indices.push(a, b, d, b, e, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}


export function createHull(layout: BoatLayout): THREE.Group {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(hullShell(layout), hullMaterial()));
  const deckGeometry = deck(layout, cockpitOutline(layout, details.coaming.width));
  g.add(new THREE.Mesh(deckGeometry, gelcoatSurface(layout, deckGeometry, false)));
  g.add(new THREE.Mesh(cockpitWell(layout), new THREE.MeshStandardMaterial({
    color: details.colours.gelcoat, roughness: details.surface.smoothRoughness, side: THREE.DoubleSide,
  })));
  const floorOutline = cockpitOutline(layout, -details.coaming.floorRadius);
  const floor = mapToBody(new THREE.ShapeGeometry(new THREE.Shape(floorOutline)), (x, y) => [x, y, layout.cockpit.floorZ]);
  g.add(new THREE.Mesh(floor, gelcoatSurface(layout, floor, true)));
  return g;
}
