/**
 * Daggerboard and rudder (with rudder head and tiller). Planforms from the ILCA class
 * rules p28 via data/laser.json; parts not in the rules are visual estimates (see
 * `visual.daggerboard`, `visual.rudder` sources). Foils are flat slabs of the max
 * thickness, not foil sections.
 */
import * as THREE from 'three';
import { bodyToLocal, mapToBody } from './bodyFrame';
import type { BoatLayout } from './boatLayout';

const FOIL_COLOR = 0xf0f0ea; // visual estimate: white foils
const HEAD_COLOR = 0x303236; // visual estimate: dark rudder head
const TILLER_COLOR = 0x8a6a45; // visual estimate: varnished wood
const TILLER_SECTION = 0.035; // visual estimate: tiller cross-section, m
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

export interface Rudder {
  /** Pivot on the rudder stock; rotation.y = -rudderAngle. */
  pivot: THREE.Group;
}

export function createRudder(layout: BoatLayout): Rudder {
  const { rudder: r, visual } = layout.model.cfg;
  const vr = visual.rudder;
  const pivot = new THREE.Group();
  const stock = layout.rudderStock;
  bodyToLocal(stock.x, 0, 0, pivot.position);

  // Blade: hangs from the head; immersed span = sim rudder span below the waterline.
  const leAtStock = stock.x - (layout.transomX + r.leadingEdgeXFromTransom); // leading edge aft of the stock
  const top = vr.headHeight * 0.5; // visual estimate: blade top hidden inside the head
  const height = top + r.span;
  const rake = Math.tan(vr.leadingEdgeRakeDeg * (Math.PI / 180));
  const blade = slab(r.chord, height, r.thickness, vr.tipRadius, rake, (s, h, d) => [-leAtStock - s, d, h - r.span]);
  pivot.add(new THREE.Mesh(blade, foilMaterial(FOIL_COLOR)));

  // Rudder head: box hung on the transom, from just below the waterline to the tiller.
  const headBottom = -0.05; // visual estimate, m
  const head = new THREE.Mesh(new THREE.BoxGeometry(vr.headWidth, vr.headHeight, vr.headLength), foilMaterial(HEAD_COLOR));
  bodyToLocal(-vr.headLength / 2 + 0.03, 0, headBottom + vr.headHeight / 2, head.position);
  pivot.add(head);

  // Tiller: forward from the head along the centreline of the pivot frame.
  const tiller = new THREE.Mesh(new THREE.BoxGeometry(TILLER_SECTION, TILLER_SECTION, vr.tillerLength), foilMaterial(TILLER_COLOR));
  bodyToLocal(vr.tillerLength / 2, 0, layout.tillerZ, tiller.position);
  pivot.add(tiller);

  return { pivot };
}
