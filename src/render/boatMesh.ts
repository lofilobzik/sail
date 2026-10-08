/**
 * Procedural Laser assembled from render parts, driven by an interpolated sim pose.
 * Reads sim state only. Group structure:
 *   yaw (world x/y/z, rotation.y = -heading)
 *     pitch (rotation.x = +pitch): bow up, in the boat's heading frame
 *       heel (rotation.z = -heel): hull, deck, foils, mast, sailor, lines
 *         rudder pivot (rotation.y = -rudderAngle): blade, head, tiller
 *         boom pivot (rotation.y = +boom): boom, blocks, sail
 */
import * as THREE from 'three';
import details from '../../data/rig-details.json';
import type { BoatModel } from '../sim';
import { createDaggerboard, createRudder } from './appendages';
import { bodyToLocal } from './bodyFrame';
import { BoatLayout } from './boatLayout';
import { createHull } from './hull';
import { createBlock, createDeckFittings } from './hardwareDetails';
import { createRig } from './rig';
import { createSail, type SailView } from './sail';
import { createSailor, type Sailor } from './sailor';
import { createRope } from './rope';


export interface BoatPose {
  heel: number;
  /** Physical pitch, rad, positive bow up. */
  pitch: number;
  boom: number;
  /** Rad, + = leading edge / tiller to starboard. */
  rudderAngle: number;
  sheet: number;
  crewY: number;
  /** Apparent wind in the body frame (where the air goes), m/s. */
  apparentU: number;
  apparentV: number;
  luffAmount: number;
  stallAmount: number;
  /** Real time since the last rendered frame, s (drives the cloth). */
  dt: number;
}

/** Points on the boat a newcomer is shown where to look at (src/ui/lookGuide.ts); world positions via getWorldPosition. */
export interface LookTargets {
  /** Masthead wind indicator. */
  windex: THREE.Object3D;
  /** Middle luff telltale on the sail, following the cloth. */
  telltales: THREE.Object3D;
  /** Tiller end, where the extension joins it. */
  tiller: THREE.Object3D;
}

export interface BoatMesh {
  yaw: THREE.Group;
  pitch: THREE.Group;
  heel: THREE.Group;
  sailor: Sailor;
  sail: SailView;
  layout: BoatLayout;
  lookTargets: LookTargets;
  update(pose: BoatPose): void;
}

export function createBoatMesh(model: BoatModel): BoatMesh {
  const layout = new BoatLayout(model);
  const v = model.cfg.visual;
  const yaw = new THREE.Group();
  const pitch = new THREE.Group();
  const heel = new THREE.Group();
  yaw.add(pitch);
  pitch.add(heel);

  heel.add(createHull(layout), createDaggerboard(layout), createDeckFittings(layout));
  const rudder = createRudder(layout);
  heel.add(rudder.pivot);
  const rig = createRig(layout, heel);
  const sail: SailView = createSail(layout);
  rig.boom.add(sail.object);
  const sailor = createSailor(layout, heel);

  const travellerBlock = createBlock();
  travellerBlock.name = 'traveller-block';
  travellerBlock.rotation.z = Math.PI; // its shackle attaches downward to the bridle
  const ratchetMesh = createBlock(details.block.ratchetScale);
  ratchetMesh.name = 'ratchet-block';
  ratchetMesh.rotation.z = Math.PI;
  const ratchet = bodyToLocal(layout.ratchetBlock.x, 0, layout.ratchetBlock.z);
  ratchetMesh.position.copy(ratchet);
  const sheetPoints = Array.from({ length: 16 }, () => new THREE.Vector3());
  const mainsheet = createRope(sheetPoints.length, details.colours.sheet, details.rope.sheetRadius);
  mainsheet.mesh.name = 'mainsheet';
  const bridlePoints = Array.from({ length: 3 }, () => new THREE.Vector3());
  const bridle = createRope(bridlePoints.length, details.colours.traveller, details.rope.travellerRadius);
  bridle.mesh.name = 'traveller-bridle';
  heel.add(travellerBlock, ratchetMesh, mainsheet.mesh, bridle.mesh);
  const tillerEnd = new THREE.Object3D();
  heel.add(tillerEnd);

  const travellerX = layout.transomX + details.deck.travellerForwardOfTransom;
  const travellerDeck = layout.sheerAt(travellerX);
  const travellerZ = travellerDeck + v.traveller.aboveDeck;
  bodyToLocal(travellerX, -v.traveller.halfWidth, travellerDeck + details.deck.eyeRadius, bridlePoints[0]!);
  bodyToLocal(travellerX, v.traveller.halfWidth, travellerDeck + details.deck.eyeRadius, bridlePoints[2]!);
  // VISUAL ESTIMATE: a loose spiral tail rests beside the hiking strap, fed from the sheet hand.
  const coilPoints = Array.from({ length: details.deck.sheetTailTurns * 16 + 1 }, (_, i) => {
    const t = i / (details.deck.sheetTailTurns * 16);
    const angle = t * details.deck.sheetTailTurns * Math.PI * 2;
    const radius = details.deck.sheetTailRadius * (1 - t) + details.rope.sheetRadius * 3;
    return bodyToLocal(
      (layout.cockpit.aft + layout.cockpit.fore) / 2 + Math.cos(angle) * radius,
      layout.cockpit.halfWidth - details.deck.sheetTailRadius - details.rope.sheetRadius * 3 + Math.sin(angle) * radius,
      layout.cockpit.floorZ + details.rope.sheetRadius,
    );
  });
  const sheetCoil = createRope(coilPoints.length, details.colours.sheet, details.rope.sheetRadius);
  sheetCoil.mesh.name = 'sheet-tail-coil';
  sheetCoil.update(coilPoints);
  heel.add(sheetCoil.mesh);
  const tmp = {
    end: new THREE.Vector3(),
    mid: new THREE.Vector3(),
    flow: new THREE.Vector3(),
    sailWind: new THREE.Vector3(),
    boomPoint: new THREE.Vector3(),
  };
  const fromBoom = rig.fromBoom;
  const boomRopePoint = (block: THREE.Vector3, y: number, z: number, out: THREE.Vector3): void => {
    tmp.boomPoint.copy(block);
    tmp.boomPoint.y += y; tmp.boomPoint.z += z;
    fromBoom(tmp.boomPoint, out);
  };
  const r = details.block.sheaveRadius, rr = r * details.block.ratchetScale;

  return {
    yaw,
    pitch,
    heel,
    sailor,
    sail,
    layout,
    lookTargets: { windex: rig.indicator, telltales: sail.telltaleMark, tiller: tillerEnd },
    update(pose) {
      pitch.rotation.x = pose.pitch;
      heel.rotation.z = -pose.heel;
      rig.update(pose.boom);
      rudder.pivot.rotation.y = -pose.rudderAngle;
      const tEnd = layout.tillerEnd(pose.rudderAngle);
      bodyToLocal(tEnd.x, tEnd.y, tEnd.z, tillerEnd.position);

      bodyToLocal(pose.apparentU, pose.apparentV, 0, tmp.flow);
      const aws = tmp.flow.length();
      if (aws > 1e-6) rig.toBoomDir(tmp.flow, tmp.sailWind).divideScalar(aws);
      else tmp.sailWind.set(0, 0, 1);
      sail.update({ dt: pose.dt, luffAmount: pose.luffAmount, stallAmount: pose.stallAmount, windDir: tmp.sailWind, apparentSpeed: aws });
      sailor.update({ crewY: pose.crewY, rudderAngle: pose.rudderAngle, sheet: pose.sheet });

      fromBoom(rig.boomEndBlock, tmp.end);
      fromBoom(rig.midBoomBlock, tmp.mid);
      // Traveller block slides along the bridle toward the boom end's side.
      const ty = Math.max(-v.traveller.halfWidth, Math.min(v.traveller.halfWidth, tmp.end.x));
      bodyToLocal(travellerX, ty, travellerZ, travellerBlock.position);
      bridlePoints[1]!.copy(travellerBlock.position);
      bridlePoints[1]!.y -= details.block.cheekHeight / 2 + details.block.shackleRadius;
      bridle.update(bridlePoints);

      // VISUAL ESTIMATE: becket, traveller return and rounded block turns; the loaded under-boom run stays straight.
      boomRopePoint(rig.boomEndBlock, details.block.cheekHeight / 2, r, sheetPoints[0]!);
      sheetPoints[1]!.copy(travellerBlock.position).z += r;
      sheetPoints[2]!.copy(travellerBlock.position).y += r;
      sheetPoints[3]!.copy(travellerBlock.position).z -= r;
      boomRopePoint(rig.boomEndBlock, 0, r, sheetPoints[4]!);
      boomRopePoint(rig.boomEndBlock, -r, 0, sheetPoints[5]!);
      boomRopePoint(rig.boomEndBlock, 0, -r, sheetPoints[6]!);
      boomRopePoint(rig.midBoomBlock, 0, r, sheetPoints[7]!);
      boomRopePoint(rig.midBoomBlock, -r, 0, sheetPoints[8]!);
      boomRopePoint(rig.midBoomBlock, 0, -r, sheetPoints[9]!);
      sheetPoints[10]!.copy(ratchet).z += rr;
      sheetPoints[11]!.copy(ratchet).y += rr;
      sheetPoints[12]!.copy(ratchet).z -= rr;
      sheetPoints[13]!.copy(sailor.sheetHand);
      sheetPoints[15]!.copy(coilPoints[0]!);
      sheetPoints[14]!.copy(sheetPoints[13]!).add(sheetPoints[15]!).multiplyScalar(0.5);
      sheetPoints[14]!.y -= details.rope.loopSag;
      mainsheet.update(sheetPoints);

      // Masthead indicator: fin (+z) downwind along the apparent flow, arrow into the wind.
      if (tmp.flow.lengthSq() > 1e-6) rig.indicator.rotation.y = Math.atan2(tmp.flow.x, tmp.flow.z);
    },
  };
}
