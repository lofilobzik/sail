/** Entry: fixed-step sim loop + interpolated rendering. render/ and debug/ only read sim state. */
import { TestHud } from './debug/hud';
import { DebugOverlay } from './debug/overlay';
import { ControlInput, isTypingTarget } from './input/controls';
import { MouseLook } from './input/mouseLook';
import { Vector2 } from 'three';
import { SceneView, type RenderPose } from './render/scene';
import { ForceVectors } from './render/vectors';
import { DEG, FixedStep, WAVE_PARAMETERS, buildBoat, clamp, defaultConfig, evaluate, initialState, setWaveParameters, setWaveWind, step, wrapPi, type BoatState, type Diagnostics } from './sim';

const START_HEADING_DEG = 90; // TUNING GUESS: beam reach for the default wind from 0°
const START_SPEED = 1; // TUNING GUESS: initial boat speed, m/s
const FRAME_SMOOTHING = 0.05; // exponential smoothing of the frame-time readout
const BENCH_FRAMES = 200; // ?perf=1: frames rendered back to back, each synchronised with a 1-pixel readback
const BENCH_DELAY_MS = 2000;

const boat = buildBoat();
// Choose a sea pattern once. All subsequent sampling remains seeded and world-anchored.
const cfg = defaultConfig(Math.floor(Math.random() * 0x100000000));
cfg.waves.enabled = true;
setWaveWind(cfg.waves, cfg.wind.speedKn);
const params = new URLSearchParams(location.search);
if (params.get('waves') === '0') cfg.waves.enabled = false;
const waveScale = params.get('waveAmplitude');
if (waveScale !== null && Number.isFinite(Number(waveScale))) {
  cfg.waves.amplitudeScale = clamp(Number(waveScale), 0, WAVE_PARAMETERS.maxAmplitudeScale);
}
const wavePeriod = params.get('wavePeriod');
const waveDirection = params.get('waveDirection');
setWaveParameters(
  cfg.waves,
  wavePeriod !== null && Number.isFinite(Number(wavePeriod)) ? Number(wavePeriod) : cfg.waves.periodSeconds,
  waveDirection !== null && Number.isFinite(Number(waveDirection)) ? Number(waveDirection) : cfg.waves.directionDeg,
);
const fixed = new FixedStep(cfg.dt);

const view = new SceneView(boat, cfg.waves, cfg.env);
// ?wake=0 starts with the boat wake and bow wave off.
if (params.get('wake') === '0') view.wake.enabled = false;
const input = new ControlInput(view.renderer.domElement);
const look = new MouseLook(view.renderer.domElement);
const vectors = new ForceVectors(boat, view.scene, view.boat.yaw, view.boat.heel);

let prev: BoatState;
let curr: BoatState;
let diagnostics: Diagnostics;

function resetBoat(): void {
  curr = prev = initialState(START_HEADING_DEG * DEG, START_SPEED);
  input.reset();
  diagnostics = evaluate(curr, input.update(0), boat, cfg);
}
resetBoat();

const overlay = new DebugOverlay(cfg, resetBoat);
overlay.addToggle('wake (visual)', view.wake.enabled, (v) => (view.wake.enabled = v));
const hud = new TestHud(boat);

// V: switch between the first-person view and an outside view for checking the model.
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyV' || isTypingTarget(e.target)) return;
  view.mode = view.mode === 'cockpit' ? 'outside' : 'cockpit';
});

// Checking aids: ?view=outside&look=<yawDeg>,<pitchDeg> sets the initial view without pointer lock;
// ?water=0 hides the water and grid to show the foils.
if (params.get('view') === 'outside') view.mode = 'outside';
if (params.get('water') === '0') view.setWaterVisible(false);
const lookParam = params.get('look')?.split(',').map(Number);
if (lookParam && lookParam.length === 2 && lookParam.every(Number.isFinite)) {
  look.yaw = lookParam[0]! * DEG;
  look.pitch = lookParam[1]! * DEG;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

let last = performance.now();
let frameMs = 16.7;
let cpuMs = 0;
let lastPose: RenderPose | null = null;
function frame(now: number): void {
  const t0 = performance.now();
  const frameSeconds = (now - last) / 1000;
  last = now;
  frameMs += (frameSeconds * 1000 - frameMs) * FRAME_SMOOTHING;

  const steps = fixed.advance(frameSeconds);
  for (let i = 0; i < steps; i++) {
    const result = step(curr, input.update(cfg.dt), boat, cfg);
    prev = curr;
    curr = result.state;
    diagnostics = result.diagnostics;
  }

  const a = fixed.alpha;
  const x = lerp(prev.x, curr.x, a);
  const z = lerp(prev.z, curr.z, a);
  const c = diagnostics.controls;
  lastPose = {
    t: lerp(prev.t, curr.t, a),
    x,
    z,
    heading: prev.heading + wrapPi(curr.heading - prev.heading) * a,
    surge: lerp(prev.u, curr.u, a),
    heel: lerp(prev.heel, curr.heel, a),
    pitch: lerp(prev.pitch, curr.pitch, a),
    boom: lerp(prev.boom, curr.boom, a),
    crewY: lerp(prev.crewY, curr.crewY, a),
    rudderAngle: c.tiller * boat.cfg.rudder.maxAngleDeg * DEG,
    sheet: c.sheet,
    apparentU: diagnostics.apparent.u,
    apparentV: diagnostics.apparent.v,
    luffAmount: diagnostics.sail?.luffAmount ?? 0,
    stallAmount: diagnostics.sail?.stallAmount ?? 0,
    dt: frameSeconds,
    lookYaw: look.yaw,
    lookPitch: look.pitch,
  };
  view.render(lastPose);

  if (overlay.visible) vectors.update(diagnostics, view.boat.yaw.position, overlay.arrows);
  else vectors.hideAll();
  overlay.update(diagnostics, curr);
  const info = view.renderer.info.render;
  hud.update(diagnostics, curr, { frameMs, cpuMs, triangles: info.triangles, calls: info.calls }, now);
  cpuMs += (performance.now() - t0 - cpuMs) * FRAME_SMOOTHING;

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// Checking aid: ?perf=1 renders BENCH_FRAMES frames back to back, each followed by a 1-pixel
// readPixels (which waits for the GPU, unlike gl.finish in Chrome), and logs the mean frame cost.
if (params.get('perf') === '1') {
  setTimeout(() => {
    if (!lastPose) return;
    const gl = view.renderer.getContext();
    const pixel = new Uint8Array(4);
    const t0 = performance.now();
    for (let i = 0; i < BENCH_FRAMES; i++) {
      view.render(lastPose);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    }
    const ms = (performance.now() - t0) / BENCH_FRAMES;
    const size = view.renderer.getDrawingBufferSize(new Vector2());
    console.log(`bench: ${ms.toFixed(2)} ms/frame at ${size.x}x${size.y}, ${view.renderer.info.render.triangles} triangles, ${view.renderer.info.render.calls} draw calls`);
  }, BENCH_DELAY_MS);
}
