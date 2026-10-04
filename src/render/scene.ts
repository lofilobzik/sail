/**
 * Three.js scene: lights, sky, shared Gerstner water and snapped grid, the bay's land, buoys, boat
 * and cameras (first-person, plus an outside view for checking). Reads state only.
 */
import * as THREE from 'three';
import { meanWind, type BoatModel, type EnvironmentConfig, type Vec2, type WindConfig } from '../sim';
import { createWaveSample, sampleWaves, waveAmplitude, type WaveConfig } from '../sim/waves';
import { createBoatMesh, type BoatMesh, type BoatPose } from './boatMesh';
import { createBuoys } from './environment';
import { SkyView } from './sky';
import { GustMap } from './gustMap';
import { WakeView } from './wake';
import { createWater, type WaterView } from './water';
import { createLand, type LandView } from './land';
import { Binoculars } from './binoculars';
import type { Navigation } from '../nav/navigation';
import { NavigationView } from './navigation';

const GRID_CELL = 5; // TUNING GUESS: grid cell size, m (grid snaps to multiples of this)
const GRID_CELLS = 80; // TUNING GUESS: grid cells per side
const FOV_DEG = 85; // User-selected vertical cockpit field of view, degrees
// Linear fog (smoothstep between these view depths), visual estimate: land at 2-5 km is hazy but
// clear (about 15-55% fogged); the water is fully fogged well inside its 20 km half-extent, even
// at the screen edges, so it meets the horizon without a seam.
const FOG_NEAR = 0; // m
const FOG_FAR = 9000; // m
// Beyond the water mesh corners (20 km half-extent) and the sky dome (25 km). A reversed depth
// buffer keeps the shoreline free of z-fighting at this near/far ratio.
const CAMERA_FAR = 30000; // m
const MAX_PIXEL_RATIO = 2; // quality cap for high-DPI laptop screens
const OUTSIDE_DISTANCE = 9; // visual estimate: outside camera distance from the boat, m
const OUTSIDE_TARGET_HEIGHT = 1.8; // visual estimate, m

export type CameraMode = 'cockpit' | 'outside';

/** Interpolated pose for one rendered frame. */
export interface RenderPose extends BoatPose {
  /** Interpolated simulation time; matches the water sampled by physics. */
  t: number;
  /** Logical world coordinates, never rebased in the simulation. */
  x: number;
  z: number;
  heading: number;
  /** Interpolated surge speed through the water, m/s (drives the wake). */
  surge: number;
  lookYaw: number;
  lookPitch: number;
}

export class SceneView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly outsideCamera: THREE.PerspectiveCamera;
  readonly boat: BoatMesh;
  readonly wake: WakeView;
  readonly sky: SkyView;
  readonly navigation: NavigationView;
  readonly binoculars: Binoculars;
  /** Gust patches sampled from the sim's wind field. */
  readonly gusts = new GustMap();
  /** Logical position of render-local zero, continuously following the interpolated boat. */
  readonly origin: Vec2 = { x: 0, z: 0 };
  mode: CameraMode = 'cockpit';
  private readonly water: WaterView;
  private readonly grid: THREE.GridHelper;
  private readonly buoys = createBuoys();
  private readonly surface = createWaveSample();
  private readonly land: LandView;

  constructor(
    model: BoatModel, private readonly waves: WaveConfig, env: EnvironmentConfig,
    private readonly wind: WindConfig, navigation: Navigation,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, reversedDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    document.body.appendChild(this.renderer.domElement);
    this.scene.fog = new THREE.Fog(0xffffff, FOG_NEAR, FOG_FAR); // colour set by the sky

    // Strengths and the sun direction are set by the sky (data/sky.json, ?sunElevation=).
    const hemisphere = new THREE.HemisphereLight(0xdfefff, 0x203040);
    this.scene.add(hemisphere);
    const sun = new THREE.DirectionalLight(0xffffff);
    this.scene.add(sun);

    this.sky = new SkyView(sun, hemisphere, this.scene);
    this.scene.add(this.sky.mesh);

    this.boat = createBoatMesh(model);
    this.wake = new WakeView(model, this.boat.layout, env);
    this.water = createWater(waves, this.sky, this.gusts, sun, hemisphere, this.wake);
    this.scene.add(this.water.mesh);

    this.grid = new THREE.GridHelper(GRID_CELL * GRID_CELLS, GRID_CELLS, 0x6f9fbf, 0x4a7a9a);
    this.grid.position.y = 0.01;
    this.scene.add(this.grid);

    this.scene.add(this.buoys);

    this.land = createLand(this.sky);
    this.scene.add(this.land.group);

    this.scene.add(this.boat.yaw);

    this.camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.05, CAMERA_FAR);
    this.camera.rotation.order = 'YXZ';
    this.boat.sailor.eye.add(this.camera);
    this.binoculars = new Binoculars(this.camera, FOV_DEG);
    this.outsideCamera = new THREE.PerspectiveCamera(FOV_DEG * 0.8, 1, 0.1, CAMERA_FAR);
    this.navigation = new NavigationView(navigation, this.boat, this.camera, this.origin);
    // Raising the compass for the first time must not compile shaders or upload textures mid-frame.
    this.navigation.compass.prewarm(this.renderer, this.scene, this.camera);

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
    // Rebase drawing only. Double-precision logical positions remain untouched.
    this.origin.x = pose.x;
    this.origin.z = pose.z;
    const wavesActive = waveAmplitude(this.waves) !== 0;
    sampleWaves(this.waves, pose.x, pose.z, pose.t, 0, this.surface);
    b.yaw.position.set(0, this.surface.y, 0);
    b.yaw.rotation.y = -pose.heading;
    b.update(pose);
    // An immediate debug toggle can precede the next physics/interpolation frame.
    if (!wavesActive) b.pitch.rotation.x = 0;

    // Fixed buoy and land transforms compose in JS doubles before GPU matrix upload/culling.
    this.buoys.position.set(-this.origin.x, 0, -this.origin.z);
    this.land.update(this.origin);
    this.wake.update(pose, this.origin, this.waves, this.surface.y, b.pitch.rotation.x);
    this.water.update(this.origin, pose.t);
    this.gusts.update(this.wind, this.origin, pose.t);
    this.grid.visible = this.water.mesh.visible && !wavesActive;
    this.grid.position.x = Math.round(pose.x / GRID_CELL) * GRID_CELL - this.origin.x;
    this.grid.position.z = Math.round(pose.z / GRID_CELL) * GRID_CELL - this.origin.z;

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
        OUTSIDE_DISTANCE * Math.cos(el) * Math.sin(az),
        this.surface.y + OUTSIDE_TARGET_HEIGHT + OUTSIDE_DISTANCE * Math.sin(el),
        -OUTSIDE_DISTANCE * Math.cos(el) * Math.cos(az),
      );
      c.lookAt(0, this.surface.y + OUTSIDE_TARGET_HEIGHT, 0);
      cam = c;
    }
    // Clouds drift with the mean wind, not each gust.
    this.sky.update(pose.t, meanWind(this.wind));
    this.sky.follow(cam);
    this.navigation.update(this.mode === 'cockpit');
    this.renderer.render(this.scene, cam);
  }
}
