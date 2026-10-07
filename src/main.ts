/** Entry: fixed-step sim loop + interpolated rendering. render/ and debug/ only read sim state. */
import { TestHud } from './debug/hud';
import { DebugOverlay } from './debug/overlay';
import { parseDevOptions } from './debug/urlParams';
import { ControlInput, isTypingTarget } from './input/controls';
import { MouseLook } from './input/mouseLook';
import { BinocularInput } from './input/binoculars';
import { NavigationInput } from './input/navigation';
import { Navigation } from './nav/navigation';
import { MemoryReadout } from './render/memory';
import { Vector2 } from 'three';
import { interpolatePose } from './render/pose';
import { SceneView, type RenderPose } from './render/scene';
import { ForceVectors } from './render/vectors';
import { DEG, FixedStep, NEUTRAL_CONTROLS, WAVE_PARAMETERS, browserConfig, buildBoat, clamp, evaluate, initialState, setWaveParameters, step, type BoatState, type Diagnostics } from './sim';
import { joinServer, serverChoice } from './net/link';
import type { RemotePose } from './net/remote';
import { SailSound } from './audio/sound';
import { LookGuide } from './ui/lookGuide';
import { FlyCamera } from './input/flyCamera';
import { Menu } from './ui/menu';
import { Preferences } from './ui/prefs';
import { SKY } from './render/skyModel';
import { BAY } from './sim/terrain';

const START_SPEED = 1; // TUNING GUESS: initial boat speed, m/s
const FRAME_SMOOTHING = 0.05; // exponential smoothing of the frame-time readout
const BENCH_FRAMES = 200; // ?perf=1: frames rendered back to back, each synchronised with a 1-pixel readback
const BENCH_DELAY_MS = 2000;

/**
 * Offline start: afloat in Westcove Harbour, bow where data/bay.json `harbour.departure` points it (a
 * beam reach for the default wind from 0°); `?start=x,z[,heading]` puts it anywhere else to look around.
 */
function harbourStart(): BoatState {
  const { x, z, headingDeg } = opts.start
    ? { ...opts.start, headingDeg: opts.start.headingDeg ?? BAY.harbour.departure.headingDeg }
    : BAY.harbour.departure;
  return { ...initialState(headingDeg * DEG, START_SPEED), x, z };
}

const boat = buildBoat();
const params = new URLSearchParams(location.search);
const opts = parseDevOptions(params);
// The built site joins its own server (wss://<host>/ws); `npm run dev` sails offline unless
// ?server[=ws://host:port/ws] is given, and ?offline always sails locally. With a server, the Go
// server owns the seed, the config and the boat (src/net), the page predicts with the TS sim, and
// the URL physics parameters below are ignored. An unreachable server falls back to offline.
const serverUrl = serverChoice(params, import.meta.env.PROD);
const server = serverUrl === null ? null : await joinServer(serverUrl);
// Choose a sea pattern once. All subsequent sampling remains seeded and world-anchored.
const cfg = server?.cfg ?? browserConfig(Math.floor(Math.random() * 0x100000000));
if (!server) {
  // Browser sailing has gusts and shifts (seeded like the sea); ?gusts=0 keeps the wind constant.
  // Headless runs and the polar use defaultConfig, where they are off.
  if (cfg.wind.gusts) cfg.wind.gusts.enabled = opts.gusts;
  if (!opts.waves) cfg.waves.enabled = false;
  if (opts.waveAmplitude !== null) {
    cfg.waves.amplitudeScale = clamp(opts.waveAmplitude, 0, WAVE_PARAMETERS.maxAmplitudeScale);
  }
  setWaveParameters(cfg.waves, opts.wavePeriod ?? cfg.waves.periodSeconds, opts.waveDirection ?? cfg.waves.directionDeg);
}
const fixed = new FixedStep(cfg.dt);

const navigation = new Navigation();
const memory = new MemoryReadout();
const view = new SceneView(boat, cfg.waves, cfg.env, cfg.wind, navigation);
if (!opts.wake) view.wake.enabled = false;

let sunElevation = clamp(opts.sunElevation ?? SKY.sunElevationDeg, -10, 90);
let sunAzimuth = opts.sunAzimuth ?? SKY.sunAzimuthDeg;
view.sky.setSun(sunElevation, sunAzimuth);
if (opts.clouds !== null) view.sky.setCloudCoverage(opts.clouds);
const input = new ControlInput(view.renderer.domElement);
const look = new MouseLook(view.renderer.domElement);
const navigationInput = new NavigationInput(() => view.mode === 'cockpit');
const binocularInput = new BinocularInput(() => view.mode === 'cockpit' || view.mode === 'fly');
const vectors = new ForceVectors(boat, view.scene, view.boat.yaw, view.boat.heel);

let prev: BoatState;
let curr: BoatState;
let diagnostics: Diagnostics;

/**
 * Puts the boat at `start` and restarts navigation from the known departure: on a server the spawn
 * it announced (position and room time), offline the chart's start.
 */
function resetBoat(start: BoatState): void {
  curr = prev = { ...start };
  navigationInput.cancel();
  const departure = server ? start : undefined;
  navigation.reset(departure);
  view.navigation.chart.reset(departure);
  memory.update(navigation, false);
  input.reset();
  diagnostics = evaluate(curr, input.update(0), boat, cfg);
}
resetBoat(server ? server.spawn : harbourStart());
// The first launch is a departure, not a restart: the reset's "Dead reckoning restarted" note is for respawns.
navigation.message = '';

// Server mode: respawning resets the server's boat; the local one follows on the next snapshot.
const respawn = server ? () => server.reset() : () => resetBoat(harbourStart());
const overlay = new DebugOverlay(cfg, respawn, server !== null);
let showNavigationTruth = false;
overlay.addToggle('navigation: show true position on chart', false, (v) => { showNavigationTruth = v; });
overlay.addToggle('wake: Kelvin waves', true, (v) => view.wake.setLayer('kelvin', v));
overlay.addToggle('wake: bow V waves', true, (v) => view.wake.setLayer('bowWaves', v));
overlay.addToggle('wake: foam (bow + stern)', true, (v) => view.wake.setLayer('foam', v));
overlay.addNumber('sun elevation ° (-10–90)', sunElevation, (v, el) => {
  sunElevation = clamp(v, -10, 90);
  view.sky.setSun(sunElevation, sunAzimuth);
  el.value = String(sunElevation);
});
overlay.addNumber('sun azimuth ° (compass)', sunAzimuth, (v, el) => {
  sunAzimuth = ((v % 360) + 360) % 360;
  view.sky.setSun(sunElevation, sunAzimuth);
  el.value = String(sunAzimuth);
});
overlay.addNumber('cloud coverage (0–1)', view.sky.cloudCoverage, (v, el) => {
  view.sky.setCloudCoverage(v);
  el.value = String(view.sky.cloudCoverage);
});

// The sail design is a player preference; ?sail=<id> (data/sail-designs.json) overrides it.
const prefs = new Preferences();
const sail = view.boat.sail;
const knownSail = (id: string | null): id is string => sail.designs.some((d) => d.id === id);
if (opts.sail !== null) {
  if (knownSail(opts.sail)) sail.setDesign(opts.sail);
  else console.warn(`unknown ?sail=${opts.sail}; known: ${sail.designs.map((d) => d.id).join(', ')}`);
} else if (knownSail(prefs.value.sail)) {
  sail.setDesign(prefs.value.sail);
}
const debugSailPicker = overlay.addSelect('sail design', sail.designs.map((d) => ({ value: d.id, label: d.name })), sail.design, (id) => prefs.set({ sail: id }));
const hud = new TestHud(boat);

const sound = new SailSound(prefs.value.volume, prefs.value.muted);
const guide = new LookGuide(view.boat.lookTargets, prefs);
const menu = new Menu({
  canvas: view.renderer.domElement,
  sailDesigns: sail.designs,
  sailDesign: sail.design,
  onSailDesign: (id) => prefs.set({ sail: id }),
  volume: prefs.value.volume,
  muted: prefs.value.muted,
  onVolume: (volume) => prefs.set({ volume }),
  onMuted: (muted) => prefs.set({ muted }),
  onRespawn: respawn,
  onShowGuidance: () => guide.reset(),
});
// The menu, the debug panel and the M key all change preferences; the sound, the sail and both
// panels follow from here.
let savedSail = prefs.value.sail;
prefs.subscribe((p) => {
  sound.setVolume(p.volume);
  sound.setMuted(p.muted);
  menu.setMuted(p.muted);
  // Only a changed sail choice acts, so a ?sail= override survives unrelated changes.
  if (p.sail !== savedSail && knownSail(p.sail)) {
    savedSail = p.sail;
    sail.setDesign(p.sail);
    debugSailPicker.value = p.sail;
    menu.setSailDesign(p.sail);
  }
});
// M: mute or unmute.
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyM' || e.repeat || isTypingTarget(e.target)) return;
  prefs.set({ muted: !prefs.value.muted });
});

// G: free-fly debug camera (WASD, E up, Q down, Shift fast). The boat gets neutral controls and
// sails on by itself; the mouse look turns the camera in world space. G or V returns to the cockpit.
const fly = new FlyCamera();
let cockpitLook = { yaw: 0, pitch: 0 };
function setFly(on: boolean, at?: { x: number; y: number; z: number; yaw: number; pitch: number }): void {
  if (on === (view.mode === 'fly')) return;
  navigationInput.cancel();
  if (on) {
    cockpitLook = { yaw: look.yaw, pitch: look.pitch };
    if (at) {
      [fly.x, fly.y, fly.z, look.yaw, look.pitch] = [at.x, at.y, at.z, at.yaw, at.pitch];
    } else {
      // Start where the head is, looking where it looks.
      [fly.x, fly.y, fly.z] = [curr.x, 2.2, curr.z];
      look.yaw = look.yaw - curr.heading;
    }
    view.mode = 'fly';
  } else {
    look.yaw = cockpitLook.yaw;
    look.pitch = cockpitLook.pitch;
    view.mode = 'cockpit';
  }
}
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyG' || e.repeat || isTypingTarget(e.target)) return;
  setFly(view.mode !== 'fly');
});

// V: switch between the first-person view and an outside view for checking the model.
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyV' || e.repeat || isTypingTarget(e.target)) return;
  if (view.mode === 'fly') {
    setFly(false);
    return;
  }
  navigationInput.cancel();
  view.mode = view.mode === 'cockpit' ? 'outside' : 'cockpit';
});

// Checking aids: ?view=outside&look=<yawDeg>,<pitchDeg> sets the initial view without pointer lock.
if (opts.outsideView) view.mode = 'outside';
if (!opts.water) view.setWaterVisible(false);
if (!opts.detailFade) view.setDetailFade(false);
if (opts.look) {
  look.yaw = opts.look.yawDeg * DEG;
  look.pitch = opts.look.pitchDeg * DEG;
}
if (opts.fly) {
  setFly(true, { x: opts.fly.x, y: opts.fly.height, z: opts.fly.z, yaw: -opts.fly.bearingDeg * DEG, pitch: opts.fly.pitchDeg * DEG });
}

let last = performance.now();
let frameMs = 16.7;
let cpuMs = 0;
let lastPose: RenderPose | null = null;
let lastRemotes: ReadonlyMap<number, RemotePose> | undefined;
function frame(now: number): void {
  const t0 = performance.now();
  const frameSeconds = (now - last) / 1000;
  last = now;
  frameMs += (frameSeconds * 1000 - frameMs) * FRAME_SMOOTHING;

  // B raises the binoculars unless a reading is under way; while they are up F is ignored.
  const glassesUp = binocularInput.held && !navigationInput.reading;
  view.binoculars.update(frameSeconds, glassesUp);
  look.sensitivityScale = 1 / view.binoculars.zoom;
  navigationInput.update(navigation, view.navigation, glassesUp);

  // Server mode: fold in a reconnect's welcome and the newest snapshot first; a jump is not
  // interpolated, and a new boat (fresh spawn or reset) restarts navigation from its spawn.
  if (server) {
    const sync = server.sync(curr);
    if (sync === 'respawned') resetBoat(server.spawn);
    else if (sync === 'jumped') prev = curr;
  }
  const steps = fixed.advance(frameSeconds);
  for (let i = 0; i < steps; i++) {
    // Flying the camera borrows WASD: the boat sails on with neutral controls.
    const controls = view.mode === 'fly' ? (input.reset(), { ...NEUTRAL_CONTROLS }) : input.update(cfg.dt);
    const result = step(curr, controls, boat, cfg);
    prev = curr;
    curr = result.state;
    diagnostics = result.diagnostics;
    server?.afterStep(curr, controls);
    // Narrow instrument boundary: only the speed through the water; no true x/z, heading or sway.
    navigation.advance({ t: curr.t, speed: (prev.u + curr.u) / 2 }, cfg.dt);
  }

  const c = diagnostics.controls;
  lastPose = interpolatePose(prev, curr, fixed.alpha, diagnostics, boat, frameSeconds, look);
  if (view.mode === 'fly') {
    fly.update(frameSeconds, look.yaw, look.pitch);
    [view.fly.x, view.fly.y, view.fly.z] = [fly.x, fly.y, fly.z];
  }
  view.navigation.sighting = navigationInput.reading === 'bearing';
  memory.update(navigation, view.mode === 'cockpit');
  view.navigation.chart.debugPosition = showNavigationTruth ? { x: curr.x, z: curr.z } : null;
  lastRemotes = server?.client.remote.sample(now / 1000);
  view.render(lastPose, lastRemotes);
  const luffAmount = diagnostics.sail?.luffAmount ?? 0;
  guide.update(
    {
      dt: frameSeconds,
      camera: view.camera,
      looking: document.pointerLockElement === view.renderer.domElement,
      busy: view.mode !== 'cockpit' || glassesUp || navigationInput.reading !== null,
      tiller: c.tiller,
      speed: diagnostics.speed,
      luffAmount,
      trimTravel: input.trimTravel,
    },
    menu.open,
  );
  sound.update({ speed: diagnostics.speed, apparentSpeed: diagnostics.apparent.speed, luffAmount });

  if (overlay.visible) vectors.update(diagnostics, view.boat.yaw.position, overlay.arrows);
  else vectors.hideAll();
  overlay.update(diagnostics, curr);
  if (server && overlay.visible) overlay.setNetwork(server.describe());
  const info = view.renderer.info.render;
  hud.update(diagnostics, curr, { frameMs, cpuMs, triangles: info.triangles, calls: info.calls, reversedDepth: view.reversedDepth }, now);
  cpuMs += (performance.now() - t0 - cpuMs) * FRAME_SMOOTHING;

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// Checking aid: ?perf=1 renders BENCH_FRAMES frames back to back, each followed by a 1-pixel
// readPixels (which waits for the GPU, unlike gl.finish in Chrome), and logs the mean frame cost.
if (opts.perf) {
  setTimeout(() => {
    if (!lastPose) return;
    const gl = view.renderer.getContext();
    const pixel = new Uint8Array(4);
    const t0 = performance.now();
    for (let i = 0; i < BENCH_FRAMES; i++) {
      view.render(lastPose, lastRemotes);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    }
    const ms = (performance.now() - t0) / BENCH_FRAMES;
    const size = view.renderer.getDrawingBufferSize(new Vector2());
    console.log(`bench: ${ms.toFixed(2)} ms/frame at ${size.x}x${size.y}, ${view.renderer.info.render.triangles} triangles, ${view.renderer.info.render.calls} draw calls, ${view.remoteBoats.count} remote boats`);
  }, BENCH_DELAY_MS);
}
