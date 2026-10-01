/**
 * Procedural Laser assembled from render parts, driven by an interpolated sim pose.
 * Reads sim state only. Group structure:
 *   yaw (world x/z, rotation.y = -heading)
 *     heel (rotation.z = -heel): hull, deck, foils, mast, sailor, lines
 *       rudder pivot (rotation.y = -rudderAngle): blade, head, tiller
 *       boom pivot (rotation.y = +boom): boom, blocks, sail
 */
import * as THREE from 'three';
import type { BoatModel } from '../sim';
import { createDaggerboard, createRudder } from './appendages';
import { bodyToLocal } from './bodyFrame';
import { BoatLayout } from './boatLayout';
import { createHull } from './hull';
import { createRig, lineMesh, setLine } from './rig';
import { createSail, type SailView } from './sail';
import { createSailor, type Sailor } from './sailor';

const TRAVELLER_BLOCK_RADIUS = 0.025; // visual estimate, m

export interface BoatPose {
  heel: number;
  boom: number;
  /** Rad, + = leading edge / tiller to starboard. */
  rudderAngle: number;
  sheet: number;
  crewY: number;
  /** Apparent wind in the body frame (where the air goes), m/s. */
  apparentU: number;
  apparentV: number;
  luffAmount: number;
}

export interface BoatMesh {
  yaw: THREE.Group;
  heel: THREE.Group;
  sailor: Sailor;
  layout: BoatLayout;
  update(pose: BoatPose): void;
}

export function createBoatMesh(model: BoatModel): BoatMesh {
  const layout = new BoatLayout(model);
  const v = model.cfg.visual;
  const yaw = new THREE.Group();
  const heel = new THREE.Group();
  yaw.add(heel);

  heel.add(createHull(layout), createDaggerboard(layout));
  const rudder = createRudder(layout);
  heel.add(rudder.pivot);
  const rig = createRig(layout, heel);
  const sail: SailView = createSail(layout);
  rig.boom.add(sail.object);
  const sailor = createSailor(layout, heel);

  const travellerBlock = new THREE.Mesh(
    new THREE.SphereGeometry(TRAVELLER_BLOCK_RADIUS, 6, 4),
    new THREE.MeshStandardMaterial({ color: 0x222222 }),
  );
  heel.add(travellerBlock);
  const ratchet = bodyToLocal(layout.ratchetBlock.x, 0, layout.ratchetBlock.z);
  const ratchetMesh = travellerBlock.clone();
  ratchetMesh.position.copy(ratchet);
  heel.add(ratchetMesh);
  const mainsheet = lineMesh(5);
  heel.add(mainsheet);

  const travellerZ = layout.sheerAt(layout.transomX) + v.traveller.aboveDeck;
  const travellerX = layout.transomX + 0.05; // visual estimate: just forward of the transom
  const tmp = {
    end: new THREE.Vector3(),
    mid: new THREE.Vector3(),
    vang: new THREE.Vector3(),
    flow: new THREE.Vector3(),
  };
  const fromBoom = rig.fromBoom;

  return {
    yaw,
    heel,
    sailor,
    layout,
    update(pose) {
      heel.rotation.z = -pose.heel;
      rig.boomPivot.rotation.y = pose.boom;
      rudder.pivot.rotation.y = -pose.rudderAngle;

      const boomMinRad = (model.cfg.rig.boomMinDeg * Math.PI) / 180;
      sail.update(Math.max(-1, Math.min(1, pose.boom / boomMinRad)), pose.luffAmount);
      sailor.update({ crewY: pose.crewY, rudderAngle: pose.rudderAngle, sheet: pose.sheet });

      fromBoom(rig.boomEndBlock, pose.boom, tmp.end);
      fromBoom(rig.midBoomBlock, pose.boom, tmp.mid);
      // Traveller block slides along the bridle toward the boom end's side.
      const ty = Math.max(-v.traveller.halfWidth, Math.min(v.traveller.halfWidth, tmp.end.x));
      bodyToLocal(travellerX, ty, travellerZ, travellerBlock.position);
      setLine(mainsheet, [travellerBlock.position, tmp.end, tmp.mid, ratchet, sailor.sheetHand]);
      setLine(rig.vang, [rig.vangTang, fromBoom(rig.vangBoomPoint, pose.boom, tmp.vang)]);

      // Masthead indicator: fin (+z) downwind along the apparent flow, arrow into the wind.
      bodyToLocal(pose.apparentU, pose.apparentV, 0, tmp.flow);
      if (tmp.flow.lengthSq() > 1e-6) rig.indicator.rotation.y = Math.atan2(tmp.flow.x, tmp.flow.z);
    },
  };
}
