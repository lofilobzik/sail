/** Three.js scene: lights, flat water, grid, placeholder boat, first-person camera. Reads state only. */
import * as THREE from 'three';
import type { BoatModel } from '../sim';
import { bodyToLocal, createBoatMesh, type BoatMesh } from './boatMesh';

const BACKGROUND = 0x9cc4e4; // TUNING GUESS: sky-ish clear colour
const WATER_COLOR = 0x1f4f6e; // TUNING GUESS
const WATER_SIZE = 4000; // TUNING GUESS: water plane edge length, m
const GRID_CELL = 5; // TUNING GUESS: grid cell size, m (grid snaps to multiples of this)
const GRID_CELLS = 80; // TUNING GUESS: grid cells per side
const FOV_DEG = 75; // TUNING GUESS
const EYE_ABOVE_DECK = 0.9; // TUNING GUESS: sitting eye height above deck, m
const EYE_AFT_OF_MAST = 1.3; // TUNING GUESS: sailor's head aft of the mast, m
const EYE_INBOARD_OF_GUNWALE = 0.15; // TUNING GUESS: head inboard of the side deck edge, m

/** Interpolated pose for one rendered frame. */
export interface RenderPose {
  x: number;
  z: number;
  heading: number;
  heel: number;
  boom: number;
  crewY: number;
  lookYaw: number;
  lookPitch: number;
}

export class SceneView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly boat: BoatMesh;
  private readonly water: THREE.Mesh;
  private readonly grid: THREE.GridHelper;
  private readonly eye = new THREE.Group();
  private crewSide = 1;

  constructor(private readonly model: BoatModel) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    document.body.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(BACKGROUND);

    this.scene.add(new THREE.HemisphereLight(0xdfefff, 0x203040, 1.2)); // TUNING GUESS intensities
    const sun = new THREE.DirectionalLight(0xffffff, 1.5); // TUNING GUESS
    sun.position.set(30, 60, 20);
    this.scene.add(sun);

    this.water = new THREE.Mesh(
      new THREE.PlaneGeometry(WATER_SIZE, WATER_SIZE),
      new THREE.MeshStandardMaterial({ color: WATER_COLOR }),
    );
    this.water.rotation.x = -Math.PI / 2;
    this.scene.add(this.water);

    this.grid = new THREE.GridHelper(GRID_CELL * GRID_CELLS, GRID_CELLS, 0x6f9fbf, 0x4a7a9a);
    this.grid.position.y = 0.01;
    this.scene.add(this.grid);

    this.boat = createBoatMesh(model);
    this.scene.add(this.boat.yaw);

    this.camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.05, 5000);
    this.camera.rotation.order = 'YXZ';
    this.eye.add(this.camera);
    this.boat.heel.add(this.eye);

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(pose: RenderPose): void {
    const b = this.boat;
    b.yaw.position.set(pose.x, 0, pose.z);
    b.yaw.rotation.y = -pose.heading;
    b.heel.rotation.z = -pose.heel;
    b.boomPivot.rotation.y = pose.boom;

    // Water follows the boat; the grid snaps to whole cells so it never slides with it.
    this.water.position.set(pose.x, 0, pose.z);
    this.grid.position.x = Math.round(pose.x / GRID_CELL) * GRID_CELL;
    this.grid.position.z = Math.round(pose.z / GRID_CELL) * GRID_CELL;

    if (pose.crewY !== 0) this.crewSide = Math.sign(pose.crewY);
    const m = this.model;
    bodyToLocal(
      m.xMast - EYE_AFT_OF_MAST,
      this.crewSide * (m.cfg.hull.beam / 2 - EYE_INBOARD_OF_GUNWALE),
      m.freeboard + EYE_ABOVE_DECK,
      this.eye.position,
    );
    this.camera.rotation.set(pose.lookPitch, pose.lookYaw, 0);

    this.renderer.render(this.scene, this.camera);
  }
}
