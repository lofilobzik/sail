/**
 * Class-sized appendages from data/laser.json. The daggerboard remains a flat slab;
 * the rudder has baked rounded sections and render-only working hardware, sourced
 * as visual estimates in data/rudder-details.json. No foil forces are changed.
 */
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import details from '../../data/rudder-details.json';
import { bodyToLocal, mapToBody } from './bodyFrame';
import type { BoatLayout } from './boatLayout';
import { merge, paint } from './land/parts';

const FOIL_COLOR = 0xf0f0ea; // visual estimate: white foils
const CURVE_SEGMENTS = 3;

function foilMaterial(color: number): THREE.Material {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.5, side: THREE.DoubleSide });
}

/**
 * Flat foil slab. 2D shape coordinates: s aft along the chord from the leading edge,
 * h up from the tip. `toBody` maps (s, h, across) to the body frame.
 */
function slab(
  chord: number,
  height: number,
  thickness: number,
  tipRadius: number,
  rakeTan: number,
  toBody: (s: number, h: number, across: number) => [number, number, number],
): THREE.BufferGeometry {
  // Leading edge raked: at height h the leading edge is at s = (height - h) * rakeTan.
  const le = (h: number) => (height - h) * rakeTan;
  const shape = new THREE.Shape();
  shape.moveTo(le(height), height);
  shape.lineTo(le(0), 0);
  shape.lineTo(le(0) + chord - tipRadius, 0);
  shape.quadraticCurveTo(le(0) + chord, 0, le(0) + chord, tipRadius);
  shape.lineTo(le(height) + chord, height);
  const geom = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: CURVE_SEGMENTS });
  return mapToBody(geom, (s, h, d) => toBody(s, h, d - thickness / 2));
}

export function createDaggerboard(layout: BoatLayout): THREE.Mesh {
  const { daggerboard: b, visual } = layout.model.cfg;
  const le = layout.transomX + b.leadingEdgeXFromTransom;
  const keelZ = layout.keelAt(le);
  const top = layout.sheerAt(le) + visual.daggerboard.topAboveDeck;
  const height = top - (keelZ - b.span);
  const geom = slab(b.chord, height, b.thickness, visual.daggerboard.tipRadius, 0, (s, h, d) => [le - s, d, keelZ - b.span + h]);
  return new THREE.Mesh(geom, foilMaterial(FOIL_COLOR));
}

type Point = readonly [number, number, number];

function localPoint(x: number, y: number, z: number): Point {
  return [y, z, -x];
}

function indexedGeometry(points: Point[], indices: number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points.flat(), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Elliptical sections with welded leading/trailing edges and a rounded tip run-out. */
function rudderBlade(layout: BoatLayout): THREE.BufferGeometry {
  const { rudder: r, visual } = layout.model.cfg;
  const vr = visual.rudder;
  const height = r.span + vr.headHeight / 2;
  const rake = Math.tan(vr.leadingEdgeRakeDeg * Math.PI / 180);
  const leAtStock = layout.rudderStock.x - (layout.transomX + r.leadingEdgeXFromTransom);
  const segments = details.blade.sectionSegments;
  const points: Point[] = [];
  const rings: number[][] = [];
  for (const fraction of details.blade.heightFractions) {
    const h = fraction * height;
    const leadingRadius = details.blade.tipLeadingRadius;
    const leadingInset = h < leadingRadius
      ? leadingRadius - Math.sqrt(leadingRadius ** 2 - (leadingRadius - h) ** 2) : 0;
    const trailingInset = h < vr.tipRadius
      ? vr.tipRadius - Math.sqrt(vr.tipRadius ** 2 - (vr.tipRadius - h) ** 2) : 0;
    const chord = r.chord - leadingInset - trailingInset;
    const roundTip = h < leadingRadius
      ? Math.sqrt(1 - (1 - h / leadingRadius) ** 2) : 1;
    const ring: number[] = [];
    for (let j = 0; j < segments; j++) {
      // The bottom is a welded centreline, not two coincident zero-area caps.
      if (h === 0 && j > segments / 2) {
        ring.push(ring[segments - j]!);
        continue;
      }
      const angle = j * Math.PI * 2 / segments;
      const s = (height - h) * rake + leadingInset + chord * (1 - Math.cos(angle)) / 2;
      const across = j === 0 || j === segments / 2 ? 0 : r.thickness / 2 * Math.sin(angle) * roundTip;
      ring.push(points.length);
      points.push(localPoint(-leAtStock - s, across, h - r.span));
    }
    rings.push(ring);
  }
  const indices: number[] = [];
  const triangle = (a: number, b: number, c: number): void => {
    if (a !== b && b !== c && c !== a) indices.push(a, b, c);
  };
  for (let i = 0; i < rings.length - 1; i++) {
    const a = rings[i]!, b = rings[i + 1]!;
    for (let j = 0; j < segments; j++) {
      const next = (j + 1) % segments;
      triangle(a[j]!, b[j]!, b[next]!);
      triangle(a[j]!, b[next]!, a[next]!);
    }
  }
  const top = rings[rings.length - 1]!;
  const centre = points.length;
  points.push(localPoint(-leAtStock - r.chord / 2, 0, vr.headHeight / 2));
  for (let j = 0; j < segments; j++) triangle(centre, top[(j + 1) % segments]!, top[j]!);
  return indexedGeometry(points, indices);
}

/** Softened polygon plate with smoothed bevel normals, authored in body x/z. */
function cheekPlate(contour: readonly (readonly [number, number])[], across: number): THREE.BufferGeometry {
  const h = details.head;
  const shape = new THREE.Shape();
  for (let i = 0; i < contour.length; i++) {
    const previous = contour[(i + contour.length - 1) % contour.length]!;
    const corner = contour[i]!;
    const next = contour[(i + 1) % contour.length]!;
    const prevLength = Math.hypot(previous[0] - corner[0], previous[1] - corner[1]);
    const nextLength = Math.hypot(next[0] - corner[0], next[1] - corner[1]);
    const radius = Math.min(h.edgeRadius, prevLength / 2, nextLength / 2);
    const ax = corner[0] + (previous[0] - corner[0]) * radius / prevLength;
    const az = corner[1] + (previous[1] - corner[1]) * radius / prevLength;
    const bx = corner[0] + (next[0] - corner[0]) * radius / nextLength;
    const bz = corner[1] + (next[1] - corner[1]) * radius / nextLength;
    if (i === 0) shape.moveTo(ax, az);
    else shape.lineTo(ax, az);
    shape.quadraticCurveTo(corner[0], corner[1], bx, bz);
  }
  shape.closePath();
  const depth = h.cheekThickness - 2 * h.bevel;
  const extruded = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: true, bevelThickness: h.bevel, bevelSize: h.bevel,
    bevelSegments: h.bevelSegments, curveSegments: h.curveSegments,
  });
  // Weld before baking normals, so the chamfers do not become flat-shaded stripes.
  extruded.deleteAttribute('normal');
  extruded.deleteAttribute('uv');
  const geometry = mergeVertices(extruded);
  extruded.dispose();
  return mapToBody(geometry, (x, z, y) => [x, across + y - depth / 2, z]);
}

function box(length: number, width: number, height: number, x: number, y: number, z: number): THREE.BufferGeometry {
  return mapToBody(new THREE.BoxGeometry(length, width, height), (px, py, pz) => [x + px, y + py, z + pz]);
}

/** A static round rod; all endpoint transforms are baked at boat construction. */
function cylinder(radius: number, a: Point, b: Point, segments = details.hardware.roundSegments): THREE.BufferGeometry {
  const start = bodyToLocal(...a), end = bodyToLocal(...b);
  const direction = end.clone().sub(start);
  const geometry = new THREE.CylinderGeometry(radius, radius, direction.length(), segments);
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()));
  const centre = start.add(end).multiplyScalar(0.5);
  return geometry.translate(centre.x, centre.y, centre.z);
}

/** Closed, rounded rectangular tiller sweep; caps and section normals are baked. */
function tillerSweep(stations: readonly (readonly [number, number, number, number])[]): THREE.BufferGeometry {
  const t = details.tiller;
  const points: Point[] = [];
  const indices: number[] = [];
  const perRing = 4 * (t.cornerSegments + 1);
  for (const [x, z, width, height] of stations) {
    const radius = Math.min(width, height) * t.cornerRadiusFraction;
    for (let corner = 0; corner < 4; corner++) {
      const angle = corner * Math.PI / 2;
      const cy = (corner === 0 || corner === 3 ? 1 : -1) * (width / 2 - radius);
      const cz = (corner < 2 ? 1 : -1) * (height / 2 - radius);
      for (let j = 0; j <= t.cornerSegments; j++) {
        const a = angle + j * Math.PI / (2 * t.cornerSegments);
        points.push(localPoint(x, cy + radius * Math.cos(a), z + cz + radius * Math.sin(a)));
      }
    }
  }
  for (let i = 0; i < stations.length - 1; i++) {
    for (let j = 0; j < perRing; j++) {
      const next = (j + 1) % perRing;
      const a = i * perRing + j, b = i * perRing + next;
      indices.push(a, b, b + perRing, a, b + perRing, a + perRing);
    }
  }
  for (const end of [0, stations.length - 1]) {
    const station = stations[end]!;
    const centre = points.length;
    points.push(localPoint(station[0], 0, station[1]));
    for (let j = 0; j < perRing; j++) {
      const a = end * perRing + j, b = end * perRing + (j + 1) % perRing;
      if (end === 0) indices.push(centre, b, a);
      else indices.push(centre, a, b);
    }
  }
  return indexedGeometry(points, indices);
}

function detailedMesh(parts: THREE.BufferGeometry[], name: string): THREE.Mesh {
  const mesh = new THREE.Mesh(merge(parts), new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: details.finish.roughness, metalness: details.finish.metalness,
    side: THREE.DoubleSide,
  }));
  mesh.name = name;
  return mesh;
}
export interface Rudder {
  /** Pivot on the rudder stock; rotation.y = -rudderAngle. */
  pivot: THREE.Group;
  /** Fixed transom gudgeons in boat-local coordinates: attach directly to heel, never pivot. */
  mounts: THREE.Group;
}

export function createRudder(layout: BoatLayout): Rudder {
  const { rudder: r, visual } = layout.model.cfg;
  const vr = visual.rudder;
  const { head: h, hardware: hw, tiller: t, downhaul: line, colours } = details;
  const pivot = new THREE.Group();
  pivot.name = 'rudder-steering-pivot';
  bodyToLocal(layout.rudderStock.x, 0, 0, pivot.position);
  const mounts = new THREE.Group();
  mounts.name = 'fixed-transom-gudgeons';
  const rotating: THREE.BufferGeometry[] = [];
  const fixed: THREE.BufferGeometry[] = [];
  const add = (geometry: THREE.BufferGeometry, colour: THREE.ColorRepresentation): void => {
    rotating.push(paint(geometry, colour));
  };
  const mount = (geometry: THREE.BufferGeometry, colour: THREE.ColorRepresentation): void => {
    fixed.push(paint(geometry, colour));
  };
  add(rudderBlade(layout), colours.blade);

  // Two shaped cheeks leave the blade, axle and tiller root visible between them.
  const headTop = h.bottom + vr.headHeight;
  const contour: readonly (readonly [number, number])[] = [
    [-h.noseAft, h.bottom + h.bottomRise], [-vr.headLength * h.bottomAftFraction, h.bottom],
    [-vr.headLength, h.bottom + h.bottomRise], [-vr.headLength * h.topAftFraction, headTop],
    [-vr.headLength * h.tillerFastenerAftFraction, headTop], [-h.noseAft, headTop - h.edgeRadius],
  ];
  for (const side of [-1, 1]) add(cheekPlate(contour, side * (vr.headWidth - h.cheekThickness) / 2), colours.head);
  for (const z of [h.bottom + h.bottomRise, headTop - h.bridgeHeight / 2]) {
    add(box(h.bridgeLength, vr.headWidth - 2 * h.cheekThickness, h.bridgeHeight,
      -h.noseAft - h.bridgeLength / 2, 0, z), colours.head);
  }
  const bladeAxleX = -vr.headLength * h.bladeAxleAftFraction;
  const bladeAxleZ = h.bottom + h.bladeAxleAboveBottom;
  const tillerFastenerX = -vr.headLength * h.tillerFastenerAftFraction;
  const tillerFastenerZ = h.bottom + h.tillerFastenerAboveBottom;
  for (const [x, z] of [[bladeAxleX, bladeAxleZ], [tillerFastenerX, tillerFastenerZ]] as const) {
    add(cylinder(hw.axleRadius, [x, -vr.headWidth / 2, z], [x, vr.headWidth / 2, z]), colours.metal);
    for (const side of [-1, 1]) {
      const y = side * vr.headWidth / 2;
      add(cylinder(hw.washerRadius, [x, y, z], [x, y + side * hw.washerThickness, z]), colours.bushing);
      add(cylinder(hw.boltRadius, [x, y + side * hw.washerThickness, z],
        [x, y + side * (hw.washerThickness + hw.boltThickness), z], hw.tubeSegments), colours.metal);
    }
  }

  // Gudgeon backing plates/arms remain fixed; coaxial pintles steer inside the open bearings.
  const stockX = layout.rudderStock.x;
  const transomFace = layout.transomX - hw.plateThickness;
  for (const z of hw.mountHeights) {
    mount(box(hw.plateThickness, hw.plateWidth, hw.plateHeight,
      layout.transomX - hw.plateThickness / 2, 0, z), colours.metal);
    for (const side of [-1, 1]) {
      const y = side * hw.mountArmSpacing / 2;
      mount(box(transomFace - stockX, hw.mountArmWidth, hw.bearingHeight,
        (transomFace + stockX) / 2, y, z), colours.metal);
      const boltY = side * hw.plateWidth * hw.mountBoltSpacingFraction;
      mount(cylinder(hw.boltRadius, [transomFace - hw.boltThickness, boltY, z],
        [transomFace, boltY, z], hw.tubeSegments), colours.bushing);
    }
    const bearing = new THREE.Shape();
    bearing.absarc(0, 0, hw.bearingRadius + hw.bearingWall, 0, Math.PI * 2, false);
    const hole = new THREE.Path();
    hole.absarc(0, 0, hw.bearingRadius, 0, Math.PI * 2, true);
    bearing.holes.push(hole);
    const sleeve = new THREE.ExtrudeGeometry(bearing, {
      depth: hw.bearingHeight, bevelEnabled: false, curveSegments: hw.roundSegments / 2,
    });
    mount(mapToBody(sleeve, (x, y, depth) => [stockX + x, y, z + depth - hw.bearingHeight / 2]), colours.bushing);
    add(cylinder(hw.axleRadius, [0, 0, z - hw.pintleLength / 2], [0, 0, z + hw.pintleLength / 2]), colours.metal);
    const shoulderZ = z + (hw.bearingHeight + hw.pintleShoulderHeight) / 2;
    add(box(h.noseAft + h.bridgeLength, vr.headWidth - 2 * h.cheekThickness, hw.pintleShoulderHeight,
      -(h.noseAft + h.bridgeLength) / 2, 0, shoulderZ), colours.head);
  }
  const retainerZ = hw.mountHeights[hw.mountHeights.length - 1]! + hw.pintleLength / 2;
  add(cylinder(hw.retainingPinRadius, [0, -hw.retainingPinLength / 2, retainerZ],
    [0, hw.retainingPinLength / 2, retainerZ], hw.tubeSegments), colours.metal);
  const retainingRing = new THREE.TorusGeometry(hw.retainingRingRadius, hw.retainingPinRadius, hw.tubeSegments, hw.roundSegments);
  add(mapToBody(retainingRing, (y, z, x) => [x, hw.retainingPinLength / 2 + hw.retainingRingRadius + y, retainerZ + z]), colours.metal);

  // A bent, rounded wood root enters the head; the forward endpoint is exactly layout.tillerEnd(0).
  const rootX = -vr.headLength * t.rootAftFraction;
  const bendX = -vr.headLength * t.bendAftFraction;
  add(tillerSweep([
    [rootX, layout.tillerZ - t.rootDrop, t.section * t.rootWidthScale, t.section],
    [bendX, layout.tillerZ, t.section, t.section],
    [0, layout.tillerZ, t.section, t.section],
    [vr.tillerLength, layout.tillerZ, t.section * t.endWidthScale, t.section * t.endWidthScale],
  ]), colours.tiller);
  add(tillerSweep([
    [rootX, layout.tillerZ - t.rootDrop, t.section * t.rootWidthScale + 2 * t.socketWall, t.section + 2 * t.socketWall],
    [rootX + t.socketLength, layout.tillerZ - t.rootDrop * (1 - t.socketLength / (bendX - rootX)),
      t.section + 2 * t.socketWall, t.section + 2 * t.socketWall],
  ]), colours.head);
  const gripWidth = (fraction: number): number => t.section * (1 + (t.endWidthScale - 1) * fraction) + 2 * t.gripThickness;
  add(tillerSweep([
    [vr.tillerLength * t.gripStartFraction, layout.tillerZ, gripWidth(t.gripStartFraction), gripWidth(t.gripStartFraction)],
    [vr.tillerLength, layout.tillerZ, gripWidth(1), gripWidth(1)],
  ]), colours.grip);
  const endJoint = new THREE.SphereGeometry(t.endJointRadius, hw.roundSegments, hw.tubeSegments);
  const endpoint = bodyToLocal(vr.tillerLength, 0, layout.tillerZ);
  add(endJoint.translate(endpoint.x, endpoint.y, endpoint.z), colours.bushing);

  // Restrained downhaul: all endpoints belong to the steering assembly, not the fixed hull.
  const lineY = vr.headWidth / 2 + line.sideClearance;
  const anchorX = bladeAxleX - r.chord * line.bladeAnchorAftFraction;
  const anchorZ = bladeAxleZ - line.bladeAnchorBelowAxle;
  add(cylinder(hw.axleRadius, [anchorX, 0, anchorZ], [anchorX, lineY, anchorZ]), colours.bushing);
  const cleatX = vr.tillerLength * line.cleatForwardFraction;
  const cleatZ = layout.tillerZ + t.section / 2 + line.cleatHeight / 2;
  add(box(line.cleatLength, line.cleatWidth, line.cleatHeight, cleatX, 0, cleatZ), colours.head);
  const guideZ = headTop + line.guideAboveHead;
  const path: Point[] = [
    [anchorX, lineY, anchorZ], [tillerFastenerX, lineY, guideZ],
    [0, lineY, layout.tillerZ + t.section / 2 + line.radius],
    [cleatX - line.cleatLength / 2, 0, cleatZ + line.cleatHeight / 2 + line.radius],
    [cleatX + line.cleatLength / 2, 0, cleatZ + line.cleatHeight / 2 + line.radius],
    [cleatX + line.cleatLength / 2 + line.tailLength, lineY, layout.tillerZ + t.section / 2 + line.radius],
  ];
  add(cylinder(hw.retainingPinRadius, [tillerFastenerX, vr.headWidth / 2, guideZ],
    [tillerFastenerX, lineY + line.radius, guideZ]), colours.metal);
  add(cylinder(hw.retainingPinRadius, [tillerFastenerX, vr.headWidth / 2, headTop],
    [tillerFastenerX, vr.headWidth / 2, guideZ]), colours.metal);
  for (let i = 0; i < path.length - 1; i++) add(cylinder(line.radius, path[i]!, path[i + 1]!, hw.tubeSegments), colours.downhaul);

  pivot.add(detailedMesh(rotating, 'rudder-blade-head-tiller-hardware'));
  mounts.add(detailedMesh(fixed, 'stationary-transom-mount-hardware'));
  return { pivot, mounts };
}
