/**
 * Render-only floating fingers and small moored dinghies. All dimensions, placements, tessellation
 * and colours below are VISUAL ESTIMATE, not surveyed harbour or boat data. Rectangles come from
 * data/bay.json. Wave response constants are TUNING GUESS: sheltered, restrained visual motion.
 * All positions are logical-world coordinates under the caller's rebased land group.
 */
import * as THREE from 'three';
import { BAY } from '../../sim/terrain';
import { createWaveSample, defaultWaves, sampleWaves, type WaveConfig } from '../../sim/waves';
import { faceted, merge, paint } from './parts';

export interface FloatingHarbour {
  group: THREE.Group;
  update(waves: WaveConfig, t: number): void;
}

// VISUAL ESTIMATE: metres and muted, matte harbour colours.
const FREEBOARD = 0.46;
const GANGWAY_RUN = 8;
const QUAY_OVERLAP = 0.25;
const QUAY_TOP = 2.54;
const GANGWAY_WIDTH = 2;
const DECK = [0x94816a, 0x89765f];
const FLOAT = 0x505b60;
const RUB_RAIL = 0x655b4d;
const METAL = 0x60696b;
const PILE = 0x46423a;
const ROPE = 0x625649;
const HULL_COLOURS = [0xb0bcb8, 0x8b9ea8, 0xbeb5a1, 0x9ca99a, 0xb3aaa1, 0x8d9eaa, 0xb7b6a7];
// TUNING GUESS: attenuate short chop and cap dock/boat response in sheltered water.
const DOCK_HEAVE = 0.28;
const DOCK_HEAVE_LIMIT = 0.16;
const DOCK_PITCH = 0.22;
const DOCK_ROLL = 0.18;
const DOCK_TILT_LIMIT = 0.025;
const BOAT_HEAVE = 0.55;
const BOAT_HEAVE_LIMIT = 0.24;
const BOAT_TILT = 0.35;
const BOAT_TILT_LIMIT = 0.06;

const box = (w: number, h: number, d: number, colour: number, x: number, y: number, z: number) =>
  paint(new THREE.BoxGeometry(w, h, d), colour, new THREE.Matrix4().makeTranslation(x, y, z));
const limit = (value: number, bound: number) => Math.max(-bound, Math.min(bound, value));

interface MooringSpec { dock: number; x: number; side: number; yaw: number }
// VISUAL ESTIMATE: seven little hulls tucked alongside fingers, never in the departure/main basin.
const MOORINGS: readonly MooringSpec[] = [
  { dock: 0, x: -1825, side: -1, yaw: 0.04 },
  { dock: 0, x: -1813, side: -1, yaw: -0.06 },
  { dock: 1, x: -1821, side: 1, yaw: -0.04 },
  { dock: 1, x: -1810, side: -1, yaw: 0.05 },
  { dock: 2, x: -1817, side: 1, yaw: 0.03 },
  { dock: 3, x: -1824, side: -1, yaw: -0.05 },
  { dock: 3, x: -1812, side: 1, yaw: 0.04 },
];

function cleat(parts: THREE.BufferGeometry[], x: number, z: number): void {
  parts.push(box(0.16, 0.18, 0.16, METAL, x, 0.09, z));
  parts.push(box(0.56, 0.12, 0.16, METAL, x, 0.2, z));
}

/** Top is local y=0: floats, rub rails, collars and cleats all move with this body. */
function floatingDeck(length: number, width: number, dock: number, centreX: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const planks = Math.ceil(length / 1);
  const run = length / planks;
  for (let i = 0; i < planks; i++) {
    parts.push(box(run - 0.035, 0.2, width, DECK[i % DECK.length]!, -length / 2 + (i + 0.5) * run, -0.1, 0));
  }
  const floats = Math.ceil(length / 4.2);
  const floatRun = length / floats;
  for (let i = 0; i < floats; i++) {
    parts.push(box(floatRun - 0.3, 0.56, width - 0.65, FLOAT, -length / 2 + (i + 0.5) * floatRun, -0.42, 0));
  }
  for (const side of [-1, 1]) {
    parts.push(box(length, 0.26, 0.24, RUB_RAIL, 0, -0.07, side * (width / 2 + 0.04)));
    for (const x of [-length / 2 + 1.4, length / 2 - 1.4]) {
      const matrix = new THREE.Matrix4().makeTranslation(x, 0.12, side * (width / 2 + 0.35));
      matrix.multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      parts.push(paint(new THREE.TorusGeometry(0.32, 0.1, 4, 8), METAL, matrix));
      parts.push(box(0.55, 0.14, 0.4, METAL, x, 0.04, side * (width / 2 + 0.03)));
    }
    for (const x of [-length / 2 + 1, length / 2 - 1]) cleat(parts, x, side * (width / 2 - 0.3));
  }
  for (const end of [-1, 1]) parts.push(box(0.24, 0.26, width, RUB_RAIL, end * (length / 2 - 0.12), -0.07, 0));
  for (const boat of MOORINGS) if (boat.dock === dock) {
    for (const dx of [-1.25, 1.25]) cleat(parts, boat.x + dx - centreX, boat.side * (width / 2 - 0.3));
  }
  return faceted(merge(parts));
}

/** Gangway runs along +x from its fixed quay hinge; its top and handrails pivot together. */
function gangwayGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const planks = 10;
  for (let i = 0; i < planks; i++) {
    parts.push(box(GANGWAY_RUN / planks - 0.035, 0.16, GANGWAY_WIDTH, DECK[i % DECK.length]!,
      (i + 0.5) * GANGWAY_RUN / planks, -0.08, 0));
  }
  for (const side of [-1, 1]) {
    const z = side * (GANGWAY_WIDTH / 2 - 0.05);
    parts.push(box(GANGWAY_RUN, 0.18, 0.14, METAL, GANGWAY_RUN / 2, -0.12, z));
    parts.push(box(GANGWAY_RUN, 0.1, 0.1, METAL, GANGWAY_RUN / 2, 1.05, z));
    parts.push(box(GANGWAY_RUN, 0.08, 0.08, METAL, GANGWAY_RUN / 2, 0.54, z));
    for (let i = 0; i <= 4; i++) parts.push(box(0.1, 1.05, 0.1, METAL, i * GANGWAY_RUN / 4, 0.525, z));
  }
  return faceted(merge(parts));
}

/** Dedicated open 3.8 m hull: shell, thick rim, visible cockpit floor and two timber benches. */
function dinghyGeometry(): THREE.BufferGeometry {
  // VISUAL ESTIMATE: clockwise x/z outline gives +y-facing floor triangles.
  const outline = [[1.9, 0], [1.3, -0.57], [-1.3, -0.73], [-1.8, -0.55],
    [-1.8, 0.55], [-1.3, 0.73], [1.3, 0.57]] as const;
  const parts: THREE.BufferGeometry[] = [];
  const vertices: number[] = [];
  const triangle = (ax: number, ay: number, az: number, bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number) => vertices.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  const band = (lowerScale: number, lowerY: number, upperScale: number, upperY: number) => {
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i]!, b = outline[(i + 1) % outline.length]!;
      triangle(a[0] * lowerScale, lowerY, a[1] * lowerScale, b[0] * lowerScale, lowerY, b[1] * lowerScale,
        b[0] * upperScale, upperY, b[1] * upperScale);
      triangle(a[0] * lowerScale, lowerY, a[1] * lowerScale, b[0] * upperScale, upperY, b[1] * upperScale,
        a[0] * upperScale, upperY, a[1] * upperScale);
    }
  };
  band(0.65, -0.24, 1, 0.52); // outside of the hull
  band(1, 0.52, 0.84, 0.43); // broad, inward-sloping gunwale, no closed top
  band(0.84, 0.43, 0.6, 0.04); // inside of the cockpit
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!, b = outline[(i + 1) % outline.length]!;
    triangle(0, -0.24, 0, b[0] * 0.65, -0.24, b[1] * 0.65, a[0] * 0.65, -0.24, a[1] * 0.65);
  }
  const shell = new THREE.BufferGeometry();
  shell.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  shell.computeVertexNormals();
  parts.push(paint(shell, 0xe9e7df));
  const floor: number[] = [];
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!, b = outline[(i + 1) % outline.length]!;
    floor.push(0, 0.04, 0, a[0] * 0.6, 0.04, a[1] * 0.6, b[0] * 0.6, 0.04, b[1] * 0.6);
  }
  const cockpit = new THREE.BufferGeometry();
  cockpit.setAttribute('position', new THREE.Float32BufferAttribute(floor, 3));
  cockpit.computeVertexNormals();
  parts.push(paint(cockpit, 0xa79d86));
  parts.push(box(0.32, 0.11, 1.16, 0xb09b79, -0.85, 0.27, 0));
  parts.push(box(0.32, 0.11, 1.04, 0xb09b79, 0.68, 0.27, 0));
  return faceted(merge(parts));
}

export function createFloatingHarbour(material: THREE.Material): FloatingHarbour {
  const group = new THREE.Group();
  group.name = 'floating-harbour';
  const pileParts: THREE.BufferGeometry[] = [];
  const rampGeometry = gangwayGeometry();
  const docks = BAY.harbour.pontoons.map((r, index) => {
    const x0 = r.x0 - QUAY_OVERLAP + GANGWAY_RUN;
    const length = r.x1 - x0, width = r.z1 - r.z0;
    const x = (x0 + r.x1) / 2, z = (r.z0 + r.z1) / 2;
    const body = new THREE.Mesh(floatingDeck(length, width, index, x), material);
    body.name = `floating-finger:${index}`;
    body.position.set(x, FREEBOARD, z);
    const gangway = new THREE.Mesh(rampGeometry, material);
    gangway.name = `gangway:${index}`;
    gangway.position.set(r.x0 - QUAY_OVERLAP, QUAY_TOP, z);
    group.add(body, gangway);
    for (const side of [-1, 1]) for (const pileX of [x0 + 1.4, r.x1 - 1.4]) {
      pileParts.push(paint(new THREE.CylinderGeometry(0.15, 0.18, 3.7, 6), PILE,
        new THREE.Matrix4().makeTranslation(pileX, 0.25, z + side * (width / 2 + 0.35))));
    }
    return { body, gangway, x, z, length, width, x0, attach: new THREE.Vector3(-length / 2 + 0.1, 0, 0) };
  });
  const piles = new THREE.Mesh(faceted(merge(pileParts)), material);
  piles.name = 'fixed-guide-piles';
  group.add(piles);

  const hullGeometry = dinghyGeometry();
  const hulls = new THREE.InstancedMesh(hullGeometry, material, MOORINGS.length);
  hulls.name = 'moored-dinghies';
  hulls.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // VISUAL ESTIMATE: conservative local bounds cover all moorings, yaw, heave and tilt.
  // Calculate once, so origin rebasing and frustum culling need no per-frame bounds work.
  const hullBounds = new THREE.Box3();
  const boundPoint = new THREE.Vector3();
  group.add(hulls);
  const boats = MOORINGS.map((spec, index) => {
    const dock = docks[spec.dock]!;
    const transform = new THREE.Object3D();
    const z = dock.z + spec.side * (dock.width / 2 + 1.18);
    hullBounds.expandByPoint(boundPoint.set(spec.x - 2.2, -1.2, z - 1.3));
    hullBounds.expandByPoint(boundPoint.set(spec.x + 2.2, 1.2, z + 1.3));
    transform.position.set(spec.x, 0, z);
    transform.rotation.set(0, spec.yaw, 0, 'YXZ');
    transform.updateMatrix();
    hulls.setMatrixAt(index, transform.matrix);
    hulls.setColorAt(index, new THREE.Color(HULL_COLOURS[index]!));
    const lines = [-1.25, 1.25].map((dx) => ({
      dock: new THREE.Vector3(spec.x + dx - dock.x, 0.2, spec.side * (dock.width / 2 - 0.3)),
      boat: new THREE.Vector3(dx, 0.5, -spec.side * 0.52),
    }));
    return { spec, dock, transform, z, lines };
  });
  hulls.boundingBox = hullBounds;
  hulls.boundingSphere = hullBounds.getBoundingSphere(new THREE.Sphere());
  const ropePositions = new Float32Array(MOORINGS.length * 2 * 4 * 3);
  const ropeGeometry = new THREE.BufferGeometry();
  const ropeAttribute = new THREE.BufferAttribute(ropePositions, 3).setUsage(THREE.DynamicDrawUsage);
  ropeGeometry.setAttribute('position', ropeAttribute);
  const ropes = new THREE.LineSegments(ropeGeometry, new THREE.LineBasicMaterial({ color: ROPE }));
  ropes.name = 'dinghy-two-point-moorings';
  ropeGeometry.boundingBox = hullBounds.clone().expandByScalar(0.4);
  ropeGeometry.boundingSphere = ropeGeometry.boundingBox.getBoundingSphere(new THREE.Sphere());
  group.add(ropes);

  const centreSample = createWaveSample(), inboardSample = createWaveSample(), outboardSample = createWaveSample();
  const endpoint = new THREE.Vector3(), direction = new THREE.Vector3(), xAxis = new THREE.Vector3(1, 0, 0);
  const dockPoint = new THREE.Vector3(), boatPoint = new THREE.Vector3();
  const update = (waves: WaveConfig, t: number): void => {
    for (const dock of docks) {
      sampleWaves(waves, dock.x, dock.z, t, 0, centreSample);
      sampleWaves(waves, dock.x0, dock.z, t, 0, inboardSample);
      sampleWaves(waves, dock.x0 + dock.length, dock.z, t, 0, outboardSample);
      const heave = limit((centreSample.y + inboardSample.y + outboardSample.y) * DOCK_HEAVE / 3, DOCK_HEAVE_LIMIT);
      const pitch = limit((outboardSample.y - inboardSample.y) * DOCK_PITCH / dock.length, DOCK_TILT_LIMIT);
      dock.body.position.y = FREEBOARD + heave;
      dock.body.rotation.set(-limit(centreSample.slopeZ * DOCK_ROLL, DOCK_TILT_LIMIT), 0, pitch);
      dock.body.updateMatrix();
      endpoint.copy(dock.attach).applyMatrix4(dock.body.matrix);
      direction.copy(endpoint).sub(dock.gangway.position);
      const length = direction.length();
      direction.multiplyScalar(1 / length);
      dock.gangway.quaternion.setFromUnitVectors(xAxis, direction);
      dock.gangway.scale.x = length / GANGWAY_RUN;
    }
    let offset = 0;
    for (let i = 0; i < boats.length; i++) {
      const boat = boats[i]!;
      sampleWaves(waves, boat.spec.x, boat.z, t, 0, centreSample);
      boat.transform.position.y = limit(centreSample.y * BOAT_HEAVE, BOAT_HEAVE_LIMIT);
      const c = Math.cos(boat.spec.yaw), s = Math.sin(boat.spec.yaw);
      const along = c * centreSample.slopeX - s * centreSample.slopeZ;
      const across = s * centreSample.slopeX + c * centreSample.slopeZ;
      boat.transform.rotation.set(-limit(across * BOAT_TILT, BOAT_TILT_LIMIT), boat.spec.yaw,
        limit(along * BOAT_TILT, BOAT_TILT_LIMIT), 'YXZ');
      boat.transform.updateMatrix();
      hulls.setMatrixAt(i, boat.transform.matrix);
      for (const line of boat.lines) {
        dockPoint.copy(line.dock).applyMatrix4(boat.dock.body.matrix);
        boatPoint.copy(line.boat).applyMatrix4(boat.transform.matrix);
        // VISUAL ESTIMATE: a broad, simple slack V, no fine coils or filament geometry.
        const mx = (dockPoint.x + boatPoint.x) / 2, my = (dockPoint.y + boatPoint.y) / 2 - 0.12;
        const mz = (dockPoint.z + boatPoint.z) / 2;
        ropePositions[offset++] = dockPoint.x; ropePositions[offset++] = dockPoint.y; ropePositions[offset++] = dockPoint.z;
        ropePositions[offset++] = mx; ropePositions[offset++] = my; ropePositions[offset++] = mz;
        ropePositions[offset++] = mx; ropePositions[offset++] = my; ropePositions[offset++] = mz;
        ropePositions[offset++] = boatPoint.x; ropePositions[offset++] = boatPoint.y; ropePositions[offset++] = boatPoint.z;
      }
    }
    hulls.instanceMatrix.needsUpdate = true;
    ropeAttribute.needsUpdate = true;
  };
  // Populate gangway attachment and ropes before the first frame, using shared flat-water defaults.
  update(defaultWaves(), 0);
  return { group, update };
}
