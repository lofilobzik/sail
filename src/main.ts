/** Entry: fixed-step sim loop + interpolated rendering. render/ and debug/ only read sim state. */
import { TestHud } from './debug/hud';
import { DebugOverlay } from './debug/overlay';
import { ControlInput, isTypingTarget } from './input/controls';
import { MouseLook } from './input/mouseLook';
import { BinocularInput } from './input/binoculars';
import { NavigationInput } from './input/navigation';
import { Navigation, type ReadingKind } from './nav/navigation';
import { MemoryReadout } from './render/memory';
import { Vector2 } from 'three';
import { SceneView, type RenderPose } from './render/scene';
import { ForceVectors } from './render/vectors';
import { DEG, FixedStep, WAVE_PARAMETERS, browserConfig, buildBoat, clamp, evaluate, initialState, setWaveParameters, step, wrapPi, type BoatState, type Diagnostics } from './sim';
import { joinServer, serverChoice } from './net/link';
import type { RemotePose } from './net/remote';
import { SailSound } from './audio/sound';
import { LookGuide } from './ui/lookGuide';
import { Menu } from './ui/menu';
import { loadPrefs, savePrefs } from './ui/prefs';
import { SKY } from './render/skyModel';

const START_HEADING_DEG = 90; // TUNING GUESS: beam reach for the default wind from 0°
const START_SPEED = 1; // TUNING GUESS: initial boat speed, m/s
const FRAME_SMOOTHING = 0.05; // exponential smoothing of the frame-time readout
const BENCH_FRAMES = 200; // ?perf=1: frames rendered back to back, each synchronised with a 1-pixel readback
const BENCH_DELAY_MS = 2000;

const boat = buildBoat();
const params = new URLSearchParams(location.search);
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
  if (cfg.wind.gusts) cfg.wind.gusts.enabled = params.get('gusts') !== '0';
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
}
const fixed = new FixedStep(cfg.dt);

const navigation = new Navigation();
const memory = new MemoryReadout();
const view = new SceneView(boat, cfg.waves, cfg.env, cfg.wind, navigation);
// ?wake=0 starts with the boat wake and bow wave off.
if (params.get('wake') === '0') view.wake.enabled = false;

// Checking aids: ?sunElevation=<deg>, ?sunAzimuth=<compass deg>, ?clouds=<0..1 coverage>.
const numberParam = (name: string): number | null => {
  const raw = params.get(name);
  return raw !== null && Number.isFinite(Number(raw)) ? Number(raw) : null;
};
let sunElevation = clamp(numberParam('sunElevation') ?? SKY.sunElevationDeg, -10, 90);
let sunAzimuth = numberParam('sunAzimuth') ?? SKY.sunAzimuthDeg;
view.sky.setSun(sunElevation, sunAzimuth);
const clouds = numberParam('clouds');
if (clouds !== null) view.sky.setCloudCoverage(clouds);
const input = new ControlInput(view.renderer.domElement);
const look = new MouseLook(view.renderer.domElement);
const navigationInput = new NavigationInput(() => view.mode === 'cockpit');
const binocularInput = new BinocularInput(() => view.mode === 'cockpit');
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
resetBoat(server ? server.spawn : initialState(START_HEADING_DEG * DEG, START_SPEED));
// The first launch is a departure, not a restart: the reset's "Dead reckoning restarted" note is for respawns.
navigation.message = '';

// Server mode: respawning resets the server's boat; the local one follows on the next snapshot.
const respawn = server ? () => server.reset() : () => resetBoat(initialState(START_HEADING_DEG * DEG, START_SPEED));
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
const prefs = loadPrefs();
const sail = view.boat.sail;
const sailParam = params.get('sail');
if (sailParam !== null) {
  if (sail.designs.some((d) => d.id === sailParam)) sail.setDesign(sailParam);
  else console.warn(`unknown ?sail=${sailParam}; known: ${sail.designs.map((d) => d.id).join(', ')}`);
} else if (prefs.sail !== null && sail.designs.some((d) => d.id === prefs.sail)) {
  sail.setDesign(prefs.sail);
}
// Both the Esc menu and the debug panel pick the sail; either choice updates the other.
const chooseSail = (id: string): void => {
  sail.setDesign(id);
  prefs.sail = id;
  savePrefs(prefs);
  debugSailPicker.value = id;
  menu.setSailDesign(id);
};
const debugSailPicker = overlay.addSelect('sail design', sail.designs.map((d) => ({ value: d.id, label: d.name })), sail.design, chooseSail);
const hud = new TestHud(boat);

const sound = new SailSound(prefs.volume, prefs.muted);
// Mute from the menu checkbox or the M key: the sound, the checkbox and the saved preference follow.
function setMuted(muted: boolean): void {
  sound.setMuted(muted);
  menu.setMuted(muted);
  prefs.muted = muted;
  savePrefs(prefs);
}
const guide = new LookGuide(view.boat.lookTargets, prefs);
const menu = new Menu({
  canvas: view.renderer.domElement,
  sailDesigns: sail.designs,
  sailDesign: sail.design,
  onSailDesign: chooseSail,
  volume: prefs.volume,
  muted: prefs.muted,
  onVolume: (v) => {
    sound.setVolume(v);
    prefs.volume = v;
    savePrefs(prefs);
  },
  onMuted: setMuted,
  onRespawn: respawn,
  onShowGuidance: () => guide.reset(),
});
// M: mute or unmute.
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyM' || e.repeat || isTypingTarget(e.target)) return;
  setMuted(!prefs.muted);
});

// V: switch between the first-person view and an outside view for checking the model.
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyV' || e.repeat || isTypingTarget(e.target)) return;
  navigationInput.cancel();
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
let lastRemotes: ReadonlyMap<number, RemotePose> | undefined;
let wantedReading: ReadingKind | null = null;
function frame(now: number): void {
  const t0 = performance.now();
  const frameSeconds = (now - last) / 1000;
  last = now;
  frameMs += (frameSeconds * 1000 - frameMs) * FRAME_SMOOTHING;

  // B raises the binoculars unless a reading is under way; while they are up F is ignored.
  const glassesUp = binocularInput.held && !wantedReading;
  view.binoculars.update(frameSeconds, glassesUp);
  look.sensitivityScale = 1 / view.binoculars.zoom;

  // F starts one reading when pressed: the wake if the sailor is looking astern with no mark under the
  // crosshair, otherwise a compass bearing (a mark astern is still a bearing). It is not repeated
  // until the key is released, and the kind is fixed for the whole press.
  if (!navigationInput.held || glassesUp) {
    if (wantedReading) navigation.cancelReading();
    wantedReading = null;
  } else if (!wantedReading) {
    wantedReading = view.navigation.lookingAstern && !view.navigation.aimedMark ? 'speed' : 'bearing';
    navigation.beginReading(wantedReading);
  }
  navigation.setAim(wantedReading === 'bearing' ? view.navigation.bearing : null);
  navigation.setAimedMark(wantedReading === 'bearing' ? view.navigation.aimedMark : null);
  navigation.setAimedBow(wantedReading === 'bearing' && view.navigation.aimedBow);
  navigation.setAstern(view.navigation.lookingAstern);
  const lookingAtChart = view.navigation.chartInView;
  navigation.setLooking(lookingAtChart);
  if (navigationInput.takeReckon()) {
    if (lookingAtChart) navigation.beginAutoPlot();
    else navigation.message = 'Look down at the chart to reckon.';
  }
  // Server mode: fold in a reconnect's welcome and the newest snapshot first; a jump is not
  // interpolated, and a new boat (fresh spawn or reset) restarts navigation from its spawn.
  if (server) {
    const sync = server.sync(curr);
    if (sync === 'respawned') resetBoat(server.spawn);
    else if (sync === 'jumped') prev = curr;
  }
  const steps = fixed.advance(frameSeconds);
  for (let i = 0; i < steps; i++) {
    const controls = input.update(cfg.dt);
    const result = step(curr, controls, boat, cfg);
    prev = curr;
    curr = result.state;
    diagnostics = result.diagnostics;
    server?.afterStep(curr, controls);
    // Narrow instrument boundary: only the speed through the water; no true x/z, heading or sway.
    navigation.advance({ t: curr.t, speed: (prev.u + curr.u) / 2 }, cfg.dt);
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
  view.navigation.sighting = wantedReading === 'bearing';
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
      busy: view.mode !== 'cockpit' || glassesUp || wantedReading !== null,
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
      view.render(lastPose, lastRemotes);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    }
    const ms = (performance.now() - t0) / BENCH_FRAMES;
    const size = view.renderer.getDrawingBufferSize(new Vector2());
    console.log(`bench: ${ms.toFixed(2)} ms/frame at ${size.x}x${size.y}, ${view.renderer.info.render.triangles} triangles, ${view.renderer.info.render.calls} draw calls, ${view.remoteBoats.count} remote boats`);
  }, BENCH_DELAY_MS);
}
