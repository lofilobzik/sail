/** Entry: fixed-step sim loop + interpolated rendering. render/ and debug/ only read sim state. */
import { TestHud } from './debug/hud';
import { DebugOverlay } from './debug/overlay';
import { parseDevOptions } from './debug/urlParams';
import { ControlInput, MOORED_SHEET, isTypingTarget } from './input/controls';
import { MouseLook } from './input/mouseLook';
import { BinocularInput } from './input/binoculars';
import { NavigationInput } from './input/navigation';
import { Navigation } from './nav/navigation';
import { MemoryReadout } from './render/memory';
import { Vector2, Vector3 } from 'three';
import { interpolatePose } from './render/pose';
import { SceneView, type RenderPose } from './render/scene';
import { ForceVectors } from './render/vectors';
import { DEG, FixedStep, NEUTRAL_CONTROLS, WAVE_PARAMETERS, buildBoat, clamp, initialState } from './sim';
import type { BoatState, Controls, Diagnostics } from './physics/types';
import { loadPhysics } from './physics/load';
import { adoptPhysicsConfig } from './physics/bridge';
import { joinServer, serverChoice } from './net/link';
import { ZERO_OFFSET } from './net/correction';
import type { RemotePose } from './net/remote';
import { SailSound } from './audio/sound';
import { gustCue, type GustCue } from './audio/gustCue';
import { LookGuide } from './ui/lookGuide';
import { Hints } from './ui/hints';
import { FlyCamera } from './input/flyCamera';
import { Menu } from './ui/menu';
import { Preferences } from './ui/prefs';
import { ChallengeLog } from './ui/challengeLog';
import { CHALLENGES, lockedSails } from './ui/challengeInfo';
import { openGoals, trackedQuest } from './ui/quests';
import { QuestTracker } from './ui/questTracker';
import { GpsWatch } from './ui/gpsWatch';
import { showToast } from './ui/toast';
import { newSailorCode } from './net/sailorCode';
import type { ChallengeStatus } from './net/protocol';
import { SKY } from './render/skyModel';
import { BAY } from './sim/terrain';
import { BINDINGS } from './input/bindings';
import { GPU_LABELS } from './debug/gpuTimer';
import { QUALITY, detectQuality } from './render/quality';
import { BUILD_HASH } from './version';

const START_SPEED = 1; // TUNING GUESS: initial boat speed, m/s
const FRAME_SMOOTHING = 0.05; // exponential smoothing of the frame-time readout
const BENCH_FRAMES = 200; // ?perf=1: frames rendered back to back, each synchronised with a 1-pixel readback
const BENCH_DELAY_MS = 2000;
const PERF_SETTLE_MS = 1000; // ?perf=1: normal frames between the bench and the recorded window
const PERF_FRAMES = 600; // ?perf=1: normal rAF frames recorded for the perf: line

/**
 * Offline start: moored at the first Westcove berth (data/bay.json `harbour.berths`), waiting for E
 * to cast off; `?start=x,z[,heading]` puts it afloat anywhere else to look around (heading defaults to
 * `harbour.departure`'s).
 */
function harbourStart(): BoatState {
  if (!opts.start) return physics.mooredAt(0, 0);
  const { x, z } = opts.start;
  const headingDeg = opts.start.headingDeg ?? BAY.harbour.departure.headingDeg;
  return { ...initialState(headingDeg * DEG, START_SPEED), x, z };
}

const boat = buildBoat();
const params = new URLSearchParams(location.search);
const opts = parseDevOptions(params);
const physics = await fetch(new URL(`wasm/sim.wasm?v=${BUILD_HASH}`, document.baseURI)).then(loadPhysics).catch((error: unknown) => {
  const banner = document.createElement('div');
  banner.style.cssText =
    'position:fixed;top:8px;left:50%;transform:translateX(-50%);padding:4px 10px;z-index:20;' +
    'background:rgba(0,0,0,0.7);color:#e8e8e8;font:13px/1.35 ui-monospace,monospace;';
  banner.textContent = 'Physics failed to load. Reload the page.';
  document.body.appendChild(banner);
  throw error; // Stop initialization: there is no second physics implementation to fall back to.
});
// The built site joins its own server (wss://<host>/ws); `npm run dev` sails offline unless
// ?server[=ws://host:port/ws] is given, and ?offline always sails locally. With a server, the Go
// server owns the seed, the config and the boat (src/net), the page predicts with the Go wasm sim, and
// the URL physics parameters below are ignored. An unreachable server falls back to offline.
// Preferences come first: the sailor code they keep (generated on the first visit) joins the server.
const prefs = new Preferences();
if (prefs.value.player === null) prefs.set({ player: newSailorCode() });
const player = prefs.value.player!;
const serverUrl = serverChoice(params, import.meta.env.PROD);
const server = serverUrl === null ? null : await joinServer(serverUrl, player, physics);
// Choose a sea pattern once. All subsequent sampling remains seeded and world-anchored.
let cfg = server?.cfg ?? physics.browserConfig(Math.floor(Math.random() * 0x100000000));
if (!server) {
  // Browser sailing has gusts and shifts (seeded like the sea); ?gusts=0 keeps the wind constant.
  // Headless runs and the polar use Go's DefaultConfig, where they are off.
  if (cfg.wind.gusts) cfg.wind.gusts.enabled = opts.gusts;
  if (!opts.waves) cfg.waves.enabled = false;
  if (opts.waveAmplitude !== null) {
    cfg.waves.amplitudeScale = clamp(opts.waveAmplitude, 0, WAVE_PARAMETERS.maxAmplitudeScale);
  }
  cfg.waves.periodSeconds = opts.wavePeriod ?? cfg.waves.periodSeconds;
  cfg.waves.directionDeg = opts.waveDirection ?? cfg.waves.directionDeg;
  cfg = physics.setConfig(cfg);
}
const syncPhysicsConfig = (): void => { adoptPhysicsConfig(cfg, physics.setConfig(cfg)); };
const fixed = new FixedStep(cfg.dt);

const navigation = new Navigation();
const memory = new MemoryReadout();
const gpsWatch = new GpsWatch(prefs.value.watchColour);
// Graphics: ?quality= for checking, else the player's menu choice, else detected from the GPU.
const detectedQuality = detectQuality();
const quality = opts.quality ?? (prefs.value.graphics === 'auto' ? detectedQuality : prefs.value.graphics);
const view = new SceneView(boat, cfg.waves, cfg.env, cfg.wind, navigation, quality);
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
let lastApplied: Controls = { ...NEUTRAL_CONTROLS };
/** E was pressed at a berth: the next fixed step casts off. */
let castOffRequested = false;

/**
 * Puts the boat at `start` and restarts navigation from it, the known departure: on a server the
 * spawn it announced (position and room time), offline the berth (or `?start`).
 */
function resetBoat(start: BoatState): void {
  curr = prev = { ...start };
  navigationInput.cancel();
  navigation.reset(start);
  view.navigation.chart.reset(start);
  memory.update(navigation, false);
  input.reset(start.moored ? MOORED_SHEET : undefined);
  castOffRequested = false;
  lastApplied = input.update(0);
  diagnostics = physics.evaluate(curr, lastApplied);
}
resetBoat(server ? server.spawn : harbourStart());
// The first launch is a departure, not a restart: the reset's "Dead reckoning restarted" note is for respawns.
navigation.message = '';

// Server mode: respawning resets the server's boat; the local one follows on the next snapshot.
const respawn = server ? () => server.reset() : () => resetBoat(harbourStart());
const overlay = new DebugOverlay(cfg, respawn, server !== null, { onConfigChange: syncPhysicsConfig });
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
const sail = view.boat.sail;
const knownSail = (id: string | null): id is string => sail.designs.some((d) => d.id === id);
if (opts.sail !== null) {
  if (knownSail(opts.sail)) sail.setDesign(opts.sail);
  else console.warn(`unknown ?sail=${opts.sail}; known: ${sail.designs.map((d) => d.id).join(', ')}`);
} else if (knownSail(prefs.value.sail) && lockedSails(null).get(prefs.value.sail) === undefined) {
  // A saved choice of a sail that is no longer obtainable falls back to the default.
  sail.setDesign(prefs.value.sail);
}
const debugSailPicker = overlay.addSelect('sail design', sail.designs.map((d) => ({ value: d.id, label: d.name })), sail.design, (id) => prefs.set({ sail: id }));
const hud = new TestHud(boat);

const sound = new SailSound(prefs.value.volume, prefs.value.muted);
const guide = new LookGuide(view.boat.lookTargets, prefs);
const hints = new Hints(prefs);
const tracker = new QuestTracker();
const menu = new Menu({
  canvas: view.renderer.domElement,
  sailDesigns: sail.designs,
  sailDesign: sail.design,
  onSailDesign: (id) => prefs.set({ sail: id }),
  volume: prefs.value.volume,
  muted: prefs.value.muted,
  onVolume: (volume) => prefs.set({ volume }),
  onMuted: (muted) => prefs.set({ muted }),
  lookSensitivity: prefs.value.lookSensitivity,
  onLookSensitivity: (lookSensitivity) => prefs.set({ lookSensitivity }),
  graphics: prefs.value.graphics,
  detectedGraphics: detectedQuality,
  onGraphics: (graphics) => {
    prefs.set({ graphics });
    location.reload();
  },
  watchColour: prefs.value.watchColour,
  onWatchColour: (watchColour) => prefs.set({ watchColour }),
  onRespawn: respawn,
  onShowGuidance: () => {
    guide.reset();
    hints.reset();
  },
  logOpen: (): boolean => challengeLog.open,
  sailor: server
    ? {
        code: player,
        onRestore: (code) => {
          prefs.set({ player: code });
          location.reload();
        },
      }
    : undefined,
});
look.playerSensitivity = prefs.value.lookSensitivity;
// E: cast off from the berth on the next fixed step (fly mode uses E for up, so cockpit only). Its
// hint is in ui/hints.ts.
window.addEventListener('keydown', (e) => {
  if (e.code !== BINDINGS.castOff.keys.press || e.repeat || isTypingTarget(e.target)) return;
  if (view.mode === 'cockpit' && !menu.open && curr.moored) castOffRequested = true;
});
// Sails no challenge awards stay locked everywhere; reward sails lock once progress arrives.
menu.setLockedSails(lockedSails(null));
const sailName = (id: string): string => sail.designs.find((d) => d.id === id)?.name ?? id;
// J: the challenge log. Progress comes from the server (verified there), now or on any later
// welcome, so every update goes through applyChallenges.
const challengeLog: ChallengeLog = new ChallengeLog({
  canvas: view.renderer.domElement,
  canOpen: (): boolean => !menu.open,
  beforeRelease: () => menu.expectRelease(),
  sailName,
  tracked: () => trackedNow()?.id ?? null,
  onTrack: (id) => prefs.set({ questTracking: id === null ? { kind: 'none' } : { kind: 'quest', id } }),
});
let shownChallenges: ChallengeStatus[] | null = null;
/** The quest followed in the tracker and by the ring; null offline (no progress) or when untracked. */
const trackedNow = () => (shownChallenges ? trackedQuest(prefs.value.questTracking, shownChallenges) : null);
const applyChallenges = (list: ChallengeStatus[]): void => {
  const prev = shownChallenges;
  shownChallenges = list;
  menu.setChallenges(list);
  menu.setLockedSails(lockedSails(list));
  challengeLog.setChallenges(list);
  if (prev) announceChallenges(prev, list);
};
/**
 * Toasts every step and completion in `list` that `prev` did not have. The tracked quest's steps show
 * in the tracker instead (its swoosh); its completion also plays the tracker's banner.
 */
function announceChallenges(prev: readonly ChallengeStatus[], list: readonly ChallengeStatus[]): void {
  const trackedBefore = trackedQuest(prefs.value.questTracking, prev)?.id;
  for (const c of list) {
    const before = prev.find((p) => p.id === c.id);
    const info = CHALLENGES.find((i) => i.id === c.id);
    for (const step of c.steps) {
      if (before?.steps.includes(step) || c.id === trackedBefore) continue;
      showToast(`${info?.title ?? c.id} · Buoy ${step}: ${c.steps.indexOf(step) + 1} of ${c.total}`);
    }
    if (c.completedAt !== undefined && before?.completedAt === undefined && info) {
      showToast(`${info.title} complete!${info.reward ? ` Unlocked sail: ${sailName(info.reward.id)}` : ''}`, 6000);
      if (c.id === trackedBefore) tracker.complete(info.title);
    }
  }
}
if (server) {
  server.client.onChallenges = applyChallenges;
  if (server.client.challenges) applyChallenges(server.client.challenges);
}
// The menu and the debug panel change preferences; the sound, the sail and both panels follow from
// here.
let savedSail = prefs.value.sail;
prefs.subscribe((p) => {
  sound.setVolume(p.volume);
  sound.setMuted(p.muted);
  look.playerSensitivity = p.lookSensitivity;
  gpsWatch.setColour(p.watchColour);
  // Only a changed sail choice acts, so a ?sail= override survives unrelated changes.
  if (p.sail !== savedSail && knownSail(p.sail)) {
    savedSail = p.sail;
    sail.setDesign(p.sail);
    debugSailPicker.value = p.sail;
    menu.setSailDesign(p.sail);
  }
});
// M: show or hide the paper chart (hidden at every start; cockpit only, where it is drawn).
window.addEventListener('keydown', (e) => {
  if (e.code !== BINDINGS.chart.keys.toggle || e.repeat || isTypingTarget(e.target) || menu.open) return;
  if (view.mode === 'cockpit') view.navigation.setChartShown(!view.navigation.chartShown);
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
  if (e.code !== BINDINGS.freeFly.keys.toggle || e.repeat || isTypingTarget(e.target)) return;
  setFly(view.mode !== 'fly');
});

// V: switch between the first-person view and an outside view for checking the model.
window.addEventListener('keydown', (e) => {
  if (e.code !== BINDINGS.outside.keys.toggle || e.repeat || isTypingTarget(e.target)) return;
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
let speedOverGround = 0; // m/s, from the last fixed step (the GPS watch and dead reckoning read it)
let lastPose: RenderPose | null = null;
let lastRemotes: ReadonlyMap<number, RemotePose> | undefined;
const hudBuffer = new Vector2(); // drawing buffer size for the H overlay, reused every frame
const listenerFacing = new Vector3(); // camera direction for panning the gust warning, reused every frame
const gustSound: GustCue = { approach: 0, pan: 0, excess: 0 }; // reused every frame
/** ?perf=1: per-frame rAF interval and frame() CPU time over the recorded window. */
let perfWindow: { frame: number[]; cpu: number[]; done: () => void } | null = null;
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

  // Reconcile the whole timeline before stepping; only the drawn pose carries a visual offset.
  if (server) {
    const sync = server.sync(prev, curr, lastPose, fixed.alpha);
    if (sync.kind === 'respawned') resetBoat(server.spawn);
    else if (sync.kind === 'moved') {
      prev = sync.prev;
      curr = sync.curr;
      diagnostics = physics.evaluate(curr, lastApplied);
    }
    server.decay(frameSeconds);
  }
  const steps = fixed.advance(frameSeconds);
  for (let i = 0; i < steps; i++) {
    // Flying the camera borrows WASD: the boat sails on with neutral controls.
    const controls = view.mode === 'fly' ? (input.reset(), { ...NEUTRAL_CONTROLS }) : input.update(cfg.dt);
    const castingOff = castOffRequested && curr.moored;
    if (castingOff) {
      curr = physics.castOff(curr);
      castOffRequested = false;
    }
    const next = physics.step(curr, controls);
    prev = curr;
    curr = next;
    // The step clamps like the server does; send and record exactly what it applied.
    const applied = physics.appliedControls();
    lastApplied = applied;
    // GPS watch: speed over ground, from how far the boat moved this step.
    speedOverGround = Math.hypot(curr.x - prev.x, curr.z - prev.z) / cfg.dt;
    server?.afterStep(curr, applied, castingOff);
    // Narrow instrument boundary: only the watch's speed over ground; no true x/z, heading or sway.
    navigation.advance({ t: curr.t, speed: speedOverGround }, cfg.dt);
  }
  if (steps > 0) diagnostics = physics.diagnostics();

  lastPose = interpolatePose(prev, curr, fixed.alpha, diagnostics, boat, frameSeconds, look, server?.offset ?? ZERO_OFFSET);
  if (view.mode === 'fly') {
    fly.update(frameSeconds, look.yaw, look.pitch);
    [view.fly.x, view.fly.y, view.fly.z] = [fly.x, fly.y, fly.z];
  }
  view.navigation.sighting = navigationInput.reading;
  gpsWatch.update(speedOverGround, frameSeconds);
  memory.update(navigation, view.mode === 'cockpit');
  view.navigation.chart.debugPosition = showNavigationTruth ? { x: curr.x, z: curr.z } : null;
  lastRemotes = server?.client.remote.sample(now / 1000);
  view.render(lastPose, lastRemotes);
  const luffAmount = diagnostics.sail?.luffAmount ?? 0;
  // The tracked quest: its open goals in the tracker (with distances), the first under the ring.
  const quest = trackedNow();
  const goals = quest ? openGoals(quest, shownChallenges?.find((s) => s.id === quest.id), curr) : [];
  tracker.update(quest && {
    questId: quest.id,
    title: quest.title,
    // A course reads as directions, an any-order list as the buoys still to visit.
    goals: goals.map((g) => ({ step: g.step, text: quest.kind === 'course' ? `Sail to ${g.buoy}` : `Buoy ${g.buoy}`, distance: g.distance })),
  }, menu.open);
  hints.update({ state: curr, diagnostics, mode: view.mode, tracked: quest?.id ?? null }, menu.open);
  const goal = goals[0];
  const goalMarker = goal ? view.buoyMarkers.get(goal.buoy) : undefined;
  guide.update(
    {
      dt: frameSeconds,
      camera: view.camera,
      looking: document.pointerLockElement === view.renderer.domElement,
      busy: view.mode !== 'cockpit' || glassesUp || navigationInput.reading,
      speed: diagnostics.speed,
      luffAmount,
      trimTravel: input.trimTravel,
      pointAt: goal && goalMarker ? { object: goalMarker, label: goal.buoy } : null,
    },
    menu.open,
  );
  view.camera.getWorldDirection(listenerFacing);
  gustCue(curr, cfg.wind, listenerFacing.x, listenerFacing.z, gustSound);
  sound.update({ speed: diagnostics.speed, apparentSpeed: diagnostics.apparent.speed, luffAmount, gust: gustSound });

  if (overlay.visible) vectors.update(diagnostics, view.boat.yaw.position, overlay.arrows);
  else vectors.hideAll();
  if (overlay.refreshDue(now)) {
    overlay.update(diagnostics, curr);
    if (server) overlay.setNetwork(server.describe());
  }
  const info = view.renderer.info.render;
  view.renderer.getDrawingBufferSize(hudBuffer);
  hud.update(diagnostics, curr, {
    frameMs, cpuMs, gpu: view.gpu.lastFrame, quality: view.quality, trees: QUALITY[view.quality].trees,
    triangles: info.triangles, calls: info.calls, width: hudBuffer.x, height: hudBuffer.y,
  }, now);
  cpuMs += (performance.now() - t0 - cpuMs) * FRAME_SMOOTHING;
  if (perfWindow) {
    perfWindow.frame.push(frameSeconds * 1000);
    perfWindow.cpu.push(performance.now() - t0);
    if (perfWindow.frame.length === PERF_FRAMES) perfWindow.done();
  }

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// Checking aid: ?perf=1 renders BENCH_FRAMES frames back to back, each followed by a 1-pixel
// readPixels (which waits for the GPU, unlike gl.finish in Chrome), and logs the mean frame cost.
// After PERF_SETTLE_MS more, it records PERF_FRAMES normal frames and logs one perf: line with
// frame, CPU and GPU (timer query) percentiles.
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
    const benchMs = (performance.now() - t0) / BENCH_FRAMES;
    const size = view.renderer.getDrawingBufferSize(new Vector2());
    console.log(`bench: ${benchMs.toFixed(2)} ms/frame at ${size.x}x${size.y}, ${view.renderer.info.render.triangles} triangles, ${view.renderer.info.render.calls} draw calls, ${view.remoteBoats.count} remote boats`);
    setTimeout(() => void recordPerf(benchMs), PERF_SETTLE_MS);
  }, BENCH_DELAY_MS);
}

async function recordPerf(benchMs: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const samples = { frame: [] as number[], cpu: [] as number[], done: resolve };
  const gpuFrames = view.gpu.recordFrames(PERF_FRAMES);
  perfWindow = samples;
  await promise;
  perfWindow = null;
  const info = view.renderer.info.render;
  const size = view.renderer.getDrawingBufferSize(new Vector2());
  const frames = await gpuFrames;
  // Nearest-rank percentile of an ascending array.
  const pct = (sorted: number[], p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
  const ms = (v: number, digits = 2) => v.toFixed(digits);
  const frame = [...samples.frame].sort((a, b) => a - b);
  const cpu = [...samples.cpu].sort((a, b) => a - b);
  let gpu = 'gpu n/a';
  if (view.gpu.supported) {
    const valid = frames.filter((f) => f.valid);
    const totals = valid.map((f) => f.total).sort((a, b) => a - b);
    const mean = (values: number[]) => values.reduce((s, v) => s + v, 0) / Math.max(1, values.length);
    const labels = GPU_LABELS.map((l) => `${l} ${ms(mean(valid.map((f) => f.ms[l]!)), 3)}`).join(' ');
    gpu = valid.length === 0
      ? `gpu total n/a [no valid frames] valid 0/${PERF_FRAMES}`
      : `gpu total mean ${ms(mean(totals), 3)} p50 ${ms(pct(totals, 0.5))} p95 ${ms(pct(totals, 0.95))} p99 ${ms(pct(totals, 0.99))} max ${ms(totals[totals.length - 1]!)} ms [${labels} mean ms] valid ${valid.length}/${PERF_FRAMES}`;
  }
  console.log(
    `perf: bench ${ms(benchMs)} ms · frame p50 ${ms(pct(frame, 0.5))} p95 ${ms(pct(frame, 0.95))} p99 ${ms(pct(frame, 0.99))} max ${ms(frame[frame.length - 1]!)} ms · ` +
    `cpu p50 ${ms(pct(cpu, 0.5))} p95 ${ms(pct(cpu, 0.95))} max ${ms(cpu[cpu.length - 1]!)} ms · ${gpu} · ` +
    `${(info.triangles / 1000).toFixed(1)}k tris · ${info.calls} calls · ${size.x}x${size.y} · quality ${view.quality}`,
  );
}
