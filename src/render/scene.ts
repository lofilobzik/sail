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
import { setDetailFade, setDetailScale } from './land/detailFade';
import { createWater, type WaterView } from './water';
import { createLand, type LandView } from './land';
import { Binoculars } from './binoculars';
import type { Navigation } from '../nav/navigation';
import { NavigationView } from './navigation';
import { RemoteBoatsView } from './remoteBoats';
import type { RemotePose } from '../net/remote';

const GRID_CELL = 5; // TUNING GUESS: grid cell size, m (grid snaps to multiples of this)
const GRID_CELLS = 80; // TUNING GUESS: grid cells per side
const FOV_DEG = 85; // User-selected vertical cockpit field of view, degrees
// Linear fog (smoothstep between these view depths), visual estimate: land at 2-5 km is hazy but
// clear (about 15-55% fogged); the water is fully fogged well inside its 20 km half-extent, even
// at the screen edges, so it meets the horizon without a seam.
const FOG_NEAR = 0; // m
const FOG_FAR = 9000; // m
// Beyond the water mesh corners (20 km half-extent) and the sky dome (25 km). The split-depth passes in
// render keep the far shore free of z-fighting at this range.
const CAMERA_FAR = 30000; // m
// Split depth (see render): the far pass's near plane, m, and how far the near pass reaches past it.
const NEAR_SPLIT = 8; // TUNING GUESS: covers the whole 6.16 m mast and sail from the cockpit
const SPLIT_OVERLAP = 1.02;
const MAX_PIXEL_RATIO = 2; // quality cap for high-DPI laptop screens
const OUTSIDE_FOV_DEG = FOV_DEG * 0.8; // the orbit camera sees a little narrower than the cockpit
const OUTSIDE_DISTANCE = 9; // visual estimate: outside camera distance from the boat, m
const OUTSIDE_TARGET_HEIGHT = 1.8; // visual estimate, m
const NO_REMOTES: ReadonlyMap<number, RemotePose> = new Map();

export type CameraMode = 'cockpit' | 'outside' | 'fly';

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
  /** Other players' boats (server mode). */
  readonly remoteBoats: RemoteBoatsView;
  readonly wake: WakeView;
  readonly sky: SkyView;
  readonly navigation: NavigationView;
  readonly binoculars: Binoculars;
  /** Gust patches sampled from the sim's wind field. */
  readonly gusts = new GustMap();
  /** Logical position of render-local zero, continuously following the interpolated boat. */
  readonly origin: Vec2 = { x: 0, z: 0 };
  mode: CameraMode = 'cockpit';
  /** Debug free-fly camera position, logical world metres (y up); used in 'fly' mode, where the look yaw is absolute. */
  readonly fly = { x: 0, y: 3, z: 0 };
  private readonly water: WaterView;
  private readonly grid: THREE.GridHelper;
  private readonly buoys = createBuoys();
  private readonly surface = createWaveSample();
  private readonly land: LandView;
  /** The far and near passes' cameras (see render); never in the scene graph, placed from the real camera. */
  private readonly farPass = SceneView.passCameraObject();
  private readonly nearPass = SceneView.passCameraObject();

  private static passCameraObject(): THREE.PerspectiveCamera {
    const camera = new THREE.PerspectiveCamera();
    camera.matrixAutoUpdate = false;
    camera.matrixWorldAutoUpdate = false;
    return camera;
  }

  /** Drawing buffer height, px: the detail fade measures on-screen size against it. */
  private bufferHeight = 1;

  constructor(
    model: BoatModel, private readonly waves: WaveConfig, env: EnvironmentConfig,
    private readonly wind: WindConfig, navigation: Navigation,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    // The frame is drawn in two passes (see render): count both.
    this.renderer.info.autoReset = false;
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
    this.scene.add(this.water.mesh, this.water.nearMesh);

    this.grid = new THREE.GridHelper(GRID_CELL * GRID_CELLS, GRID_CELLS, 0x6f9fbf, 0x4a7a9a);
    this.grid.position.y = 0.01;
    this.scene.add(this.grid);

    this.scene.add(this.buoys);

    this.land = createLand(this.sky);
    this.scene.add(this.land.group);

    this.scene.add(this.boat.yaw);
    this.remoteBoats = new RemoteBoatsView(model);
    this.scene.add(this.remoteBoats.group);

    this.camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.05, CAMERA_FAR);
    this.camera.rotation.order = 'YXZ';
    this.boat.sailor.eye.add(this.camera);
    this.binoculars = new Binoculars(this.camera, FOV_DEG);
    this.outsideCamera = new THREE.PerspectiveCamera(OUTSIDE_FOV_DEG, 1, 0.1, CAMERA_FAR);
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
    this.bufferHeight = this.renderer.getDrawingBufferSize(new THREE.Vector2()).y;
    for (const cam of [this.camera, this.outsideCamera]) {
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
    }
  }

  /** Checking aid (?detailfade=0): draw windows and doors at every size instead of fading them out. */
  setDetailFade(on: boolean): void {
    setDetailFade(on);
  }

  /** Checking aid: hide water and grid to see the underwater parts. */
  setWaterVisible(on: boolean): void {
    this.water.mesh.visible = on;
    this.grid.visible = on && waveAmplitude(this.waves) === 0;
  }

  /** Draws one frame: the own boat at `pose`, the other players' boats at `remotes`. */
  render(pose: RenderPose, remotes: ReadonlyMap<number, RemotePose> = NO_REMOTES): void {
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
    this.land.update(this.origin, this.waves, pose.t);
    this.remoteBoats.update(remotes, this.origin, this.waves, pose.t, pose.dt);
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
    } else if (this.mode === 'fly') {
      const c = this.outsideCamera;
      c.position.set(this.fly.x - this.origin.x, this.fly.y, this.fly.z - this.origin.z);
      c.rotation.order = 'YXZ';
      c.rotation.set(pose.lookPitch, pose.lookYaw, 0);
      // The binoculars narrow the cockpit camera's field of view; the free camera follows it.
      if (c.fov !== this.camera.fov) {
        c.fov = this.camera.fov;
        c.updateProjectionMatrix();
      }
      cam = c;
    } else {
      // Orbit: behind the boat at look yaw 0; mouse look turns and tilts the orbit.
      const az = pose.heading + Math.PI - pose.lookYaw;
      const el = Math.min(Math.max(0.3 - pose.lookPitch, 0.03), 1.4);
      const c = this.outsideCamera;
      if (c.fov !== OUTSIDE_FOV_DEG) {
        c.fov = OUTSIDE_FOV_DEG;
        c.updateProjectionMatrix();
      }
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
    this.renderer.info.reset();
    setDetailScale(this.bufferHeight, cam.fov);
    // Split depth: one depth range from 5 cm to 30 km is not precise far away in the canvas's
    // fixed-point depth buffer. So the scene is
    // drawn beyond NEAR_SPLIT first, with the near plane pushed out there, which is precise enough that
    // far houses, trees and window panes stop z-fighting; then the depth is cleared and everything
    // within NEAR_SPLIT (hands, compass, chart, the whole rig, hull and water) is drawn again on top with the
    // usual near plane. The sky dome is skipped there: it sits on the far plane and would cover the
    // first pass. A little overlap hides the seam.
    // Each pass has its own camera object: three re-uploads a projection only when the camera changes.
    this.scene.updateMatrixWorld();
    cam.updateMatrixWorld();
    this.renderer.render(this.scene, this.passCamera(this.farPass, cam, NEAR_SPLIT, cam.far));
    // A colour background makes three clear the colour on every render, autoClear or not: drop it
    // for the near pass so the far pass's picture survives.
    const background = this.scene.background;
    this.scene.background = null;
    this.sky.mesh.visible = false;
    // Only the water near the camera can be within the near pass's reach: draw a small patch of it.
    const waterVisible = this.water.mesh.visible;
    this.water.mesh.visible = false;
    this.water.nearMesh.visible = waterVisible;
    const eye = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    this.water.placeNear(eye.x, eye.z);
    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    this.renderer.render(this.scene, this.passCamera(this.nearPass, cam, cam.near, NEAR_SPLIT * SPLIT_OVERLAP));
    this.renderer.autoClear = true;
    this.sky.mesh.visible = true;
    this.water.mesh.visible = waterVisible;
    this.water.nearMesh.visible = false;
    this.scene.background = background;
  }

  /** `pass` placed and aimed like `cam`, with its own near and far planes. */
  private passCamera(pass: THREE.PerspectiveCamera, cam: THREE.PerspectiveCamera, near: number, far: number): THREE.PerspectiveCamera {
    pass.matrixWorld.copy(cam.matrixWorld);
    pass.matrixWorldInverse.copy(cam.matrixWorld).invert();
    pass.fov = cam.fov;
    pass.aspect = cam.aspect;
    pass.zoom = cam.zoom;
    pass.near = near;
    pass.far = far;
    pass.updateProjectionMatrix();
    return pass;
  }
}
