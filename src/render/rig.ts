/**
 * Mast (lower + upper section), boom with its mainsheet blocks, vang and a masthead
 * wind indicator. Dimensions from data/laser.json (ILCA rules p33-34) or visual estimates.
 */
import * as THREE from 'three';
import { bodyToLocal, placeBetween, rod } from './bodyFrame';
import type { BoatLayout } from './boatLayout';

const SPAR_COLOR = 0xb8bcc2; // visual estimate: anodised aluminium
const BLOCK_COLOR = 0x222222; // visual estimate
const LINE_COLOR = 0x2b4a8c; // visual estimate: blue rope
const INDICATOR_COLOR = 0xff3b1f; // visual estimate
const BLOCK_RADIUS = 0.03; // visual estimate, m
const BLOCK_DROP = 0.06; // visual estimate: block centre below the boom, m

export interface Rig {
  /**
   * Gooseneck swivel about the raked mast axis: boomPivot.rotation.y = +boom swings the boom
   * to starboard. Children of `boom` are built in the unraked boat frame (local +z aft along
   * the boom, +y up), so the boom is horizontal at boom = 0 and lifts slightly when eased,
   * as on the real boat.
   */
  boomPivot: THREE.Group;
  /** Content frame of the boom and sail (see boomPivot). */
  boom: THREE.Group;
  /** Boom-frame positions of the mainsheet blocks and vang point. */
  boomEndBlock: THREE.Vector3;
  midBoomBlock: THREE.Vector3;
  vangBoomPoint: THREE.Vector3;
  /** Heel-group positions. */
  vangTang: THREE.Vector3;
  indicator: THREE.Group;
  vang: THREE.Line;
  /** Boom-frame point -> heel-group local for boom angle b. */
  fromBoom(p: THREE.Vector3, b: number, out: THREE.Vector3): THREE.Vector3;
}

function block(material: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new THREE.SphereGeometry(BLOCK_RADIUS, 6, 4), material);
}

export function lineMesh(points: number, color = LINE_COLOR): THREE.Line {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points * 3), 3));
  return new THREE.Line(g, new THREE.LineBasicMaterial({ color }));
}

export function setLine(line: THREE.Line, pts: readonly THREE.Vector3[]): void {
  const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute;
  pts.forEach((p, i) => attr.setXYZ(i, p.x, p.y, p.z));
  attr.needsUpdate = true;
  line.geometry.computeBoundingSphere();
}

export function createRig(layout: BoatLayout, parent: THREE.Group): Rig {
  const v = layout.model.cfg.visual;
  const rig = layout.model.cfg.rig;
  const spar = new THREE.MeshStandardMaterial({ color: SPAR_COLOR, metalness: 0.3, roughness: 0.4 });
  const blockMat = new THREE.MeshStandardMaterial({ color: BLOCK_COLOR });

  const d = layout.mastDir;
  const at = (s: number) => bodyToLocal(layout.mastButt.x + d.x * s, 0, layout.mastButt.z + d.z * s);
  const lower = rod(rig.mastDiameter / 2, spar, 8);
  placeBetween(lower, at(0), at(v.mast.lowerLength));
  const upperStart = v.mast.lowerLength - v.mast.upperInsert;
  const upper = rod(v.mast.upperDiameter / 2, spar, 8);
  placeBetween(upper, at(upperStart), at(upperStart + v.mast.upperLength));
  parent.add(lower, upper);

  // Mast frame tilted aft by the rake (+y along the mast), swivel about it, then undo the
  // tilt so the boom content is authored in the boat frame.
  const mastFrame = new THREE.Group();
  bodyToLocal(layout.gooseneck.x, 0, layout.gooseneck.z, mastFrame.position);
  mastFrame.rotation.x = layout.mastRake;
  parent.add(mastFrame);
  const boomPivot = new THREE.Group();
  mastFrame.add(boomPivot);
  const boomFrame = new THREE.Group();
  boomFrame.rotation.x = -layout.mastRake;
  boomPivot.add(boomFrame);
  const boomRod = rod(v.boom.diameter / 2, spar, 8);
  placeBetween(boomRod, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, rig.foot));
  boomFrame.add(boomRod);

  const boomEndBlock = new THREE.Vector3(0, -BLOCK_DROP, rig.foot - v.boom.endBlockFromAft);
  const midBoomBlock = new THREE.Vector3(0, -BLOCK_DROP, rig.foot - v.boom.midBlockFromAft);
  for (const p of [boomEndBlock, midBoomBlock]) {
    const b = block(blockMat);
    b.position.copy(p);
    boomFrame.add(b);
  }

  const vang = lineMesh(2, 0x333333);
  parent.add(vang);

  // Masthead wind indicator (Windex-style): arrow points into the apparent wind, fin downwind.
  const indicator = new THREE.Group();
  indicator.position.copy(at(v.mast.lowerLength - v.mast.upperInsert + v.mast.upperLength));
  const L = v.mastheadIndicator.length;
  const mat = new THREE.MeshBasicMaterial({ color: INDICATOR_COLOR, side: THREE.DoubleSide });
  const shaft = rod(0.006, mat, 4);
  placeBetween(shaft, new THREE.Vector3(0, 0.05, -L / 2), new THREE.Vector3(0, 0.05, L / 2));
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.08, 6), mat);
  head.rotation.x = -Math.PI / 2; // cone tip toward -z (into the wind)
  head.position.set(0, 0.05, -L / 2);
  const fin = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.08), mat);
  fin.rotation.y = Math.PI / 2;
  fin.position.set(0, 0.05, L / 2 - 0.05);
  const post = rod(0.005, mat, 4);
  placeBetween(post, new THREE.Vector3(), new THREE.Vector3(0, 0.05, 0));
  indicator.add(shaft, head, fin, post);
  parent.add(indicator);

  const qTilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), layout.mastRake);
  const qUntilt = qTilt.clone().invert();
  const qSwing = new THREE.Quaternion();
  const Y = new THREE.Vector3(0, 1, 0);
  return {
    boomPivot,
    boom: boomFrame,
    boomEndBlock,
    midBoomBlock,
    vangBoomPoint: new THREE.Vector3(0, 0, v.boom.vangFromFront),
    vangTang: at(v.mast.vangTangAboveButt),
    indicator,
    vang,
    fromBoom(p, b, out) {
      qSwing.setFromAxisAngle(Y, b).premultiply(qTilt).multiply(qUntilt);
      return out.copy(p).applyQuaternion(qSwing).add(mastFrame.position);
    },
  };
}
