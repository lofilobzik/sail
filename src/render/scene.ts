/**
 * Three.js scene: lights, sky, shared Gerstner water and snapped grid, buoys, boat and
 * cameras (first-person, plus an outside view for checking). Reads state only.
 */
import * as THREE from 'three';
import type { BoatModel } from '../sim';
import { createWaveSample, sampleWaves, waveAmplitude, type WaveConfig } from '../sim/waves';
import { createBoatMesh, type BoatMesh, type BoatPose } from './boatMesh';
import { SKY_HORIZON, createBuoys, createSky } from './environment';
import { createWater, type WaterView } from './water';

const GRID_CELL = 5; // TUNING GUESS: grid cell size, m (grid snaps to multiples of this)
const GRID_CELLS = 80; // TUNING GUESS: grid cells per side
const FOV_DEG = 75; // TUNING GUESS
const FOG_NEAR = 400; // visual estimate, m
const FOG_FAR = 2500; // visual estimate, m
const MAX_PIXEL_RATIO = 2; // quality cap for high-DPI laptop screens
const OUTSIDE_DISTANCE = 9; // visual estimate: outside camera distance from the boat, m
const OUTSIDE_TARGET_HEIGHT = 1.8; // visual estimate, m

export type CameraMode = 'cockpit' | 'outside';

/** Interpolated pose for one rendered frame. */
export interface RenderPose extends BoatPose {
  /** Interpolated simulation time; matches the water sampled by physics. */
  t: number;
  x: number;
  z: number;
  heading: number;
  lookYaw: number;
  lookPitch: number;
}

export class SceneView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly outsideCamera: THREE.PerspectiveCamera;
  readonly boat: BoatMesh;
  mode: CameraMode = 'cockpit';
  private readonly water: WaterView;
  private readonly grid: THREE.GridHelper;
  private readonly sky: THREE.Mesh;
  private readonly surface = createWaveSample();

  constructor(model: BoatModel, private readonly waves: WaveConfig) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    document.body.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(SKY_HORIZON);
    this.scene.fog = new THREE.Fog(SKY_HORIZON, FOG_NEAR, FOG_FAR);

    const hemisphere = new THREE.HemisphereLight(0xdfefff, 0x203040, 1.2); // TUNING GUESS
    this.scene.add(hemisphere);
    const sun = new THREE.DirectionalLight(0xffffff, 1.5); // TUNING GUESS
    sun.position.set(30, 60, 20);
    this.scene.add(sun);

    this.sky = createSky();
    this.scene.add(this.sky);

    this.water = createWater(waves, this.sky, sun, hemisphere, GRID_CELL);
    this.scene.add(this.water.mesh);

    this.grid = new THREE.GridHelper(GRID_CELL * GRID_CELLS, GRID_CELLS, 0x6f9fbf, 0x4a7a9a);
    this.grid.position.y = 0.01;
    this.scene.add(this.grid);

    this.scene.add(createBuoys());

    this.boat = createBoatMesh(model);
    this.scene.add(this.boat.yaw);

    this.camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.05, 5000);
    this.camera.rotation.order = 'YXZ';
    this.boat.sailor.eye.add(this.camera);
    this.outsideCamera = new THREE.PerspectiveCamera(FOV_DEG * 0.8, 1, 0.1, 5000);

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    for (const cam of [this.camera, this.outsideCamera]) {
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
    }
  }

  /** Checking aid: hide water and grid to see the underwater parts. */
  setWaterVisible(on: boolean): void {
    this.water.mesh.visible = on;
    this.grid.visible = on && waveAmplitude(this.waves) === 0;
  }

  render(pose: RenderPose): void {
    const b = this.boat;
    const wavesActive = waveAmplitude(this.waves) !== 0;
    sampleWaves(this.waves, pose.x, pose.z, pose.t, 0, this.surface);
    b.yaw.position.set(pose.x, this.surface.y, pose.z);
    b.yaw.rotation.y = -pose.heading;
    b.update(pose);
    // An immediate debug toggle can precede the next physics/interpolation frame.
    if (!wavesActive) b.pitch.rotation.x = 0;

    // Both grids snap, while the shader phase stays anchored to world coordinates.
    this.water.update(pose.x, pose.z, pose.t);
    this.grid.visible = this.water.mesh.visible && !wavesActive;
    this.grid.position.x = Math.round(pose.x / GRID_CELL) * GRID_CELL;
    this.grid.position.z = Math.round(pose.z / GRID_CELL) * GRID_CELL;

    let cam: THREE.PerspectiveCamera;
    if (this.mode === 'cockpit') {
      this.camera.rotation.set(pose.lookPitch, pose.lookYaw, 0);
      cam = this.camera;
    } else {
      // Orbit: behind the boat at look yaw 0; mouse look turns and tilts the orbit.
      const az = pose.heading + Math.PI - pose.lookYaw;
      const el = Math.min(Math.max(0.3 - pose.lookPitch, 0.03), 1.4);
      const c = this.outsideCamera;
      c.position.set(
        pose.x + OUTSIDE_DISTANCE * Math.cos(el) * Math.sin(az),
        this.surface.y + OUTSIDE_TARGET_HEIGHT + OUTSIDE_DISTANCE * Math.sin(el),
        pose.z - OUTSIDE_DISTANCE * Math.cos(el) * Math.cos(az),
      );
      c.lookAt(pose.x, this.surface.y + OUTSIDE_TARGET_HEIGHT, pose.z);
      cam = c;
    }
    cam.getWorldPosition(this.sky.position);
    this.renderer.render(this.scene, cam);
  }
}
