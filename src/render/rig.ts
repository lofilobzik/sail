/**
 * Mast, boom, blocks, control-line purchases and masthead wind indicator.
 * Class attachment dimensions come from data/laser.json; detail estimates from data/rig-details.json.
 */
import * as THREE from 'three';
import details from '../../data/rig-details.json';
import { bodyToLocal, placeBetween, rod } from './bodyFrame';
import type { BoatLayout } from './boatLayout';
import { createBlock } from './hardwareDetails';
import { createRope } from './rope';

const SPAR_COLOR = 0xb8bcc2; // visual estimate: anodised aluminium
const INDICATOR_COLOR = 0xff3b1f; // visual estimate

export interface Rig {
  /** Content frame of the boom and sail, swung about the raked mast axis. */
  boom: THREE.Group;
  /** Boom-frame positions of the mainsheet blocks. */
  boomEndBlock: THREE.Vector3;
  midBoomBlock: THREE.Vector3;
  indicator: THREE.Group;
  /** Swing the boom and update the attached visual control lines. */
  update(boom: number): void;
  /** Boom-frame point -> heel-group local, after update. */
  fromBoom(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3;
  /** Heel-group local direction -> boom-frame direction, after update. */
  toBoomDir(v: THREE.Vector3, out: THREE.Vector3): THREE.Vector3;
}


export function createRig(layout: BoatLayout, parent: THREE.Group, hull: THREE.Group): Rig {
  const v = layout.model.cfg.visual;
  const rig = layout.model.cfg.rig;
  const spar = new THREE.MeshStandardMaterial({ color: SPAR_COLOR, metalness: 0.3, roughness: 0.4 });

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

  const boomEndBlock = new THREE.Vector3(0, -details.block.hangerDrop, rig.foot - v.boom.endBlockFromAft);
  const midBoomBlock = new THREE.Vector3(0, -details.block.hangerDrop, rig.foot - v.boom.midBlockFromAft);
  for (const [i, p] of [boomEndBlock, midBoomBlock].entries()) {
    const b = createBlock();
    b.name = i === 0 ? 'aft-boom-block' : 'forward-boom-block';
    b.position.copy(p);
    boomFrame.add(b);
  }

  // VISUAL ESTIMATE: the forward outhaul block and slack control tail under the boom.
  const outhaulBlock = createBlock(details.block.vangScale);
  outhaulBlock.name = 'outhaul-block';
  outhaulBlock.position.set(0, -details.block.hangerDrop, v.boom.vangFromFront / 2);
  const r = details.block.sheaveRadius * details.block.vangScale;
  const outhaulPoints = [
    new THREE.Vector3(rig.mastDiameter / 2, v.boom.diameter / 2, rig.foot),
    new THREE.Vector3(rig.mastDiameter / 2, -v.boom.diameter / 2, rig.foot - v.boom.endBlockFromAft),
    new THREE.Vector3(0, outhaulBlock.position.y, outhaulBlock.position.z + r),
    new THREE.Vector3(0, outhaulBlock.position.y - r, outhaulBlock.position.z),
    new THREE.Vector3(0, outhaulBlock.position.y, outhaulBlock.position.z - r),
    new THREE.Vector3(details.deck.controlSpacing, -details.rope.loopSag, v.boom.vangFromFront),
  ];
  const outhaul = createRope(outhaulPoints.length, details.colours.control, details.rope.controlRadius);
  outhaul.mesh.name = 'outhaul-rope';
  outhaul.update(outhaulPoints);
  boomFrame.add(outhaulBlock, outhaul.mesh);

  const cleatX = layout.cockpit.fore + details.deck.controlForwardOfCockpit;
  const guideX = layout.mastButt.x - details.deck.controlAftOfMast;
  const cleat = bodyToLocal(cleatX, details.deck.controlSpacing, layout.sheerAt(cleatX) + details.deck.cleatHeight);
  const guide = bodyToLocal(guideX, details.deck.controlSpacing, layout.sheerAt(guideX) + details.deck.fairleadRadius);
  // Measure the unposed rendered shell once: triangulated deck heights differ from the sheer spline.
  hull.updateWorldMatrix(true, true);
  const deckRay = new THREE.Raycaster();
  const deckHits: THREE.Intersection[] = [];
  deckRay.ray.direction.set(0, -1, 0);
  const deckHeight = (x: number, y: number): number => {
    deckRay.ray.origin.set(y, layout.sheerAt(x) + layout.loa, -x);
    deckHits.length = 0;
    const hit = deckRay.intersectObject(hull, true, deckHits)[0];
    if (!hit) throw new Error('Control tail lies outside the rendered foredeck');
    return hit.point.y;
  };
  // Loose controls leave the jaws aft, then lie sideways on the foredeck, clear of the raised coaming.
  const tailX = cleatX - details.deck.cleatWidth;
  const tailSide = Math.min(
    details.deck.controlSpacing + details.deck.tailLength - details.deck.cleatWidth,
    layout.halfBeamAt(tailX) - details.deck.cleatWidth,
  );
  const tailExit = bodyToLocal(tailX, details.deck.controlSpacing, deckHeight(tailX, details.deck.controlSpacing) + details.deck.cleatHeight);
  const tail = bodyToLocal(tailX, tailSide, deckHeight(tailX, tailSide) + details.rope.controlRadius);
  const vangTang = at(v.mast.vangTangAboveButt);
  const vangBoomPoint = new THREE.Vector3(0, -v.boom.diameter / 2, v.boom.vangFromFront);
  const lowerVang = createBlock(details.block.vangScale), upperVang = createBlock(details.block.vangScale);
  lowerVang.name = 'lower-vang-block'; upperVang.name = 'upper-vang-block';
  const vangPoints = Array.from({ length: 11 }, () => new THREE.Vector3());
  const vang = createRope(vangPoints.length, details.colours.vang, details.rope.controlRadius);
  vang.mesh.name = 'vang-purchase';
  parent.add(lowerVang, upperVang, vang.mesh);

  // VISUAL ESTIMATE: cunningham routing beside the mast, through a deck guide and the other cam cleat.
  const cunninghamPoints = [
    bodyToLocal(layout.gooseneck.x, -rig.mastDiameter / 2, layout.gooseneck.z + details.block.sheaveRadius),
    bodyToLocal(layout.mastButt.x, -details.deck.controlSpacing, layout.sheerAt(layout.mastButt.x) + details.deck.fairleadRadius),
    bodyToLocal(guideX, -details.deck.controlSpacing, layout.sheerAt(guideX) + details.deck.fairleadRadius),
    bodyToLocal(cleatX, -details.deck.controlSpacing, layout.sheerAt(cleatX) + details.deck.cleatHeight),
    bodyToLocal(tailX, -details.deck.controlSpacing, deckHeight(tailX, -details.deck.controlSpacing) + details.deck.cleatHeight),
    bodyToLocal(tailX, -tailSide, deckHeight(tailX, -tailSide) + details.rope.controlRadius),
  ];
  const cunningham = createRope(cunninghamPoints.length, details.colours.control, details.rope.controlRadius);
  cunningham.mesh.name = 'cunningham-rope';
  cunningham.update(cunninghamPoints);
  parent.add(cunningham.mesh);

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
  const qSwing = new THREE.Quaternion(), qInverse = new THREE.Quaternion();
  const Y = new THREE.Vector3(0, 1, 0), direction = new THREE.Vector3(), opposite = new THREE.Vector3(), upperAnchor = new THREE.Vector3();
  const fromBoom = (p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 =>
    out.copy(p).applyQuaternion(qSwing).add(mastFrame.position);
  const blockPoint = (out: THREE.Vector3, b: THREE.Mesh, y: number, z: number): void => {
    out.set(0, y, z).applyQuaternion(b.quaternion).add(b.position);
  };
  const reach = (details.block.cheekHeight / 2 + details.block.shackleRadius) * details.block.vangScale;
  const update = (boom: number): void => {
    boomPivot.rotation.y = boom;
    qSwing.setFromAxisAngle(Y, boom).premultiply(qTilt).multiply(qUntilt);
    qInverse.copy(qSwing).invert();
    fromBoom(vangBoomPoint, upperAnchor);
    direction.subVectors(upperAnchor, vangTang).normalize();
    opposite.copy(direction).negate();
    lowerVang.position.copy(vangTang).addScaledVector(direction, reach);
    upperVang.position.copy(upperAnchor).addScaledVector(direction, -reach);
    lowerVang.quaternion.setFromUnitVectors(Y, opposite);
    upperVang.quaternion.setFromUnitVectors(Y, direction);
    blockPoint(vangPoints[0]!, lowerVang, 0, r);
    blockPoint(vangPoints[1]!, upperVang, 0, r);
    blockPoint(vangPoints[2]!, upperVang, -r, 0);
    blockPoint(vangPoints[3]!, upperVang, 0, -r);
    blockPoint(vangPoints[4]!, lowerVang, 0, -r);
    blockPoint(vangPoints[5]!, lowerVang, -r, 0);
    blockPoint(vangPoints[6]!, lowerVang, 0, r);
    vangPoints[7]!.copy(guide);
    vangPoints[8]!.copy(cleat);
    vangPoints[9]!.copy(tailExit);
    vangPoints[10]!.copy(tail);
    vang.update(vangPoints);
  };
  update(0);
  return {
    boom: boomFrame, boomEndBlock, midBoomBlock, indicator, update, fromBoom,
    toBoomDir(v, out) {
      return out.copy(v).applyQuaternion(qInverse);
    },
  };
}
