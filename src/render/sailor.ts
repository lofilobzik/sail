/**
 * First-person sailor: eye position plus hands and forearms on the tiller extension
 * (aft hand) and the mainsheet (forward hand). Full body is a later milestone.
 * All dimensions are visual estimates (data/laser.json `visual.sailor`). Everything is
 * built in the heel group, in boat-local coordinates.
 */
import * as THREE from 'three';
import { bodyToLocal, placeBetween, rod } from './bodyFrame';
import type { BoatLayout } from './boatLayout';

const SKIN_COLOR = 0xc89a7a; // visual estimate
const SLEEVE_COLOR = 0x23324a; // visual estimate: dark top / spray sleeve
const EXTENSION_COLOR = 0x2b2b2b; // visual estimate
const EXTENSION_RADIUS = 0.012; // visual estimate, m
const ARM_REST = 0.45; // visual estimate: comfortable shoulder-to-hand distance on the extension, m
const MIN_GRIP = 0.15; // visual estimate: closest grip to the tiller end along the extension, m
const Z = new THREE.Vector3(0, 0, 1);

/** Points a hand box's long axis (+z) along the forearm, elbow to hand. */
function orientHand(hand: THREE.Object3D, E: THREE.Vector3, H: THREE.Vector3): void {
  hand.position.copy(H);
  hand.quaternion.setFromUnitVectors(Z, new THREE.Vector3().subVectors(H, E).normalize());
}

export interface SailorPose {
  crewY: number;
  rudderAngle: number;
  /** 0 = sheeted in, 1 = eased. */
  sheet: number;
}

export interface Sailor {
  /** Eye position (heel-group local); the first-person camera hangs on it. */
  eye: THREE.Group;
  /** Heel-group local position of the sheet hand (mainsheet tail end). */
  sheetHand: THREE.Vector3;
  update(pose: SailorPose): void;
  setVisible(on: boolean): void;
}

/** Two-bone IK: elbow for shoulder S, hand H, segment lengths a, b, bending toward `pole`. */
function elbow(S: THREE.Vector3, H: THREE.Vector3, a: number, b: number, pole: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const dir = new THREE.Vector3().subVectors(H, S);
  const d = Math.min(dir.length(), a + b - 1e-3);
  dir.normalize();
  const x = (a * a - b * b + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(a * a - x * x, 0));
  const side = pole.clone().sub(dir.clone().multiplyScalar(pole.dot(dir))).normalize();
  return out.copy(S).addScaledVector(dir, x).addScaledVector(side, h);
}

export function createSailor(layout: BoatLayout, parent: THREE.Group): Sailor {
  const cfg = layout.model.cfg;
  const s = cfg.visual.sailor;
  const crew = cfg.crew;
  const maxReach = crew.hikeReachFrac * crew.cgHeightFrac * crew.height;

  const eye = new THREE.Group();
  // TEMP: arms (forearms and hands) hidden on request while checking the view; set false to restore.
  const HIDE_ARMS = true;
  parent.add(eye);

  const skin = new THREE.MeshStandardMaterial({ color: SKIN_COLOR, roughness: 0.7 });
  const sleeve = new THREE.MeshStandardMaterial({ color: SLEEVE_COLOR, roughness: 0.8 });
  const parts = {
    tillerForearm: rod(s.forearmRadius, sleeve),
    sheetForearm: rod(s.forearmRadius, sleeve),
    tillerHand: new THREE.Mesh(new THREE.BoxGeometry(s.handSize, s.handSize * 0.6, s.handSize * 1.1), skin),
    sheetHand: new THREE.Mesh(new THREE.BoxGeometry(s.handSize, s.handSize * 0.6, s.handSize * 1.1), skin),
    extension: rod(EXTENSION_RADIUS, new THREE.MeshStandardMaterial({ color: EXTENSION_COLOR }), 5),
  };
  parent.add(...Object.values(parts));
  if (HIDE_ARMS) for (const [name, p] of Object.entries(parts)) p.visible = name === 'extension';

  const sheetHand = new THREE.Vector3();
  const v = {
    eyeBody: new THREE.Vector3(),
    S: new THREE.Vector3(),
    E: new THREE.Vector3(),
    H: new THREE.Vector3(),
    T: new THREE.Vector3(),
    tmp: new THREE.Vector3(),
    pole: new THREE.Vector3(),
  };

  return {
    eye,
    sheetHand,
    setVisible(on) {
      for (const [name, p] of Object.entries(parts)) p.visible = on && !(HIDE_ARMS && name !== 'extension');
    },
    update(pose) {
      const side = pose.crewY < 0 ? -1 : 1;
      const hike = Math.min(Math.max((Math.abs(pose.crewY) - crew.sitInOffset) / (maxReach - crew.sitInOffset), 0), 1);
      const ex = layout.transomX + s.eyeFromTransom;
      const ey = side * (layout.halfBeamAt(ex) - s.eyeInboardOfGunwale + hike * s.eyeOutboardHiked);
      const ez = layout.sheerAt(ex) + s.eyeAboveDeckSitting + hike * (s.eyeAboveDeckHiked - s.eyeAboveDeckSitting);
      bodyToLocal(ex, ey, ez, eye.position);

      // Elbows bend down and outboard (toward the sailor's own side).
      bodyToLocal(0, side * 0.6, -1, v.pole).normalize();
      const shoulder = (dx: number) => bodyToLocal(ex + dx, ey - side * 0.05, ez - s.shoulderBelowEye, v.S);

      // Tiller hand: on the extension, which runs from the tiller end toward the aft shoulder.
      const tEnd = layout.tillerEnd(pose.rudderAngle);
      bodyToLocal(tEnd.x, tEnd.y, tEnd.z, v.T);
      shoulder(-s.shoulderHalfWidth);
      const toShoulder = v.tmp.subVectors(v.S, v.T);
      const dist = toShoulder.length();
      toShoulder.divideScalar(dist);
      const extLen = cfg.visual.rudder.extensionLength;
      const grip = Math.min(Math.max(dist - ARM_REST, MIN_GRIP), extLen);
      v.H.copy(v.T).addScaledVector(toShoulder, grip);
      placeBetween(parts.extension, v.T, v.E.copy(v.T).addScaledVector(toShoulder, extLen));
      elbow(v.S, v.H, s.upperArm, s.forearm, v.pole, v.E);
      placeBetween(parts.tillerForearm, v.E, v.H);
      orientHand(parts.tillerHand, v.E, v.H);

      // Sheet hand: pulls the mainsheet from the ratchet block toward the forward shoulder.
      shoulder(s.shoulderHalfWidth);
      const b = layout.ratchetBlock;
      const toBlock = bodyToLocal(b.x, b.y, b.z, v.tmp).sub(v.S);
      const blockDist = toBlock.length();
      const reach = s.sheetHandInReach + Math.min(Math.max(pose.sheet, 0), 1) * (s.sheetHandOutReach - s.sheetHandInReach);
      v.H.copy(v.S).addScaledVector(toBlock.divideScalar(blockDist), Math.min(reach, blockDist));
      elbow(v.S, v.H, s.upperArm, s.forearm, v.pole, v.E);
      placeBetween(parts.sheetForearm, v.E, v.H);
      orientHand(parts.sheetHand, v.E, v.H);
      sheetHand.copy(v.H);
    },
  };
}
