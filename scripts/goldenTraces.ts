/**
 * Golden fixtures for the Go port of the sim (server/sim). The TypeScript sim is the reference:
 * this script samples waves, wind, terrain and the boat model, and runs scripted scenarios through
 * step(), writing compact JSON into server/sim/testdata/golden/ for the Go tests to compare against
 * within tolerance. Controls are deterministic functions of the step index, so regenerating gives
 * byte-identical files.
 *
 * Usage: npm run golden
 *
 * Trace record i holds the state after step(i) with controls[i] and that step's diagnostics
 * (evaluated at the state before the step, first substep). Records: every step below
 * RECORD_EVERY_UNTIL, then every RECORD_STRIDE-th step.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEG,
  browserConfig,
  buildBoat,
  defaultConfig,
  defaultWaves,
  getWind,
  initialState,
  sampleWaves,
  setWaveLayers,
  setWaveParameters,
  setWaveWind,
  step,
  waveAmplitude,
  withDisabledLayers,
  createWaveSample,
  LAYER_IDS,
  type BoatState,
  type Controls,
  type Diagnostics,
  type SimConfig,
  type WaveConfig,
  type WindConfig,
} from '../src/sim/index';
import { LANDMARKS, terrainGradient, terrainHeight } from '../src/sim/terrain';

export const GOLDEN_DIR = join('server', 'sim', 'testdata', 'golden');
const RECORD_EVERY_UNTIL = 120;
const RECORD_STRIDE = 30;
/** A seed above 2^31: the server draws uint32 seeds, so int32 wrap-around must match in Go. */
const BIG_SEED = 0x9e3779b9;

const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;

/** JSON.stringify writes the shortest round-trip decimal; non-finite values would become null. */
function toJson(value: unknown): string {
  return JSON.stringify(value, (key, v: unknown) => {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`non-finite number at "${key}"`);
    return v;
  });
}

// --- Samples -------------------------------------------------------------------------------------

interface WaveSpec {
  enabled: boolean;
  amplitudeScale: number;
  bigScale: number;
  rippleScale: number;
  seed: number;
  windSpeedKn: number;
  periodSeconds: number;
  directionDeg: number;
}

/** Same construction the Go test uses: defaults for the seed, then layers, parameters, wind. */
function compiledWaves(spec: Omit<WaveSpec, 'enabled' | 'amplitudeScale'> & { amplitudeScale?: number }): WaveConfig {
  const w = defaultWaves(spec.seed);
  setWaveLayers(w, spec.bigScale, spec.rippleScale);
  setWaveParameters(w, spec.periodSeconds, spec.directionDeg);
  setWaveWind(w, spec.windSpeedKn);
  w.enabled = true;
  if (spec.amplitudeScale !== undefined) w.amplitudeScale = spec.amplitudeScale;
  return w;
}

function waveSamples() {
  const specs = [
    // Defaults (reference wind 7 kn, seed from waves.json).
    { seed: 1987, bigScale: 1, rippleScale: 1, windSpeedKn: 7, periodSeconds: 3.3953, directionDeg: 180 },
    // Browser default seed path and a uint32 seed above 2^31.
    { seed: 1, bigScale: 1, rippleScale: 1, windSpeedKn: 7, periodSeconds: 3.3953, directionDeg: 180 },
    { seed: BIG_SEED, bigScale: 1, rippleScale: 1, windSpeedKn: 12, periodSeconds: 4.5, directionDeg: 225 },
    // Light wind below minLengthRatio, layers scaled, direction wrapped from negative.
    { seed: 42, bigScale: 0.5, rippleScale: 2, windSpeedKn: 1.5, periodSeconds: 3, directionDeg: -30 },
    // Strong steep sea: amplitudeLimit set by maxSteepness; out-of-range period/layers are clamped.
    { seed: 7, bigScale: 2.5, rippleScale: 1.5, windSpeedKn: 16, periodSeconds: 1, directionDeg: 400, amplitudeScale: 2 },
    // Zero wind: zero height, amplitudeLimit 0, waveAmplitude 0.
    { seed: 3, bigScale: 1, rippleScale: 1, windSpeedKn: 0, periodSeconds: 9, directionDeg: 90 },
  ];
  const points: { x: number; z: number; t: number; depth: number }[] = [];
  const depths = [0, -0.2, -0.75, -1.3, -3];
  const positions = [[0, 0], [3.7, -11.2], [-25.5, 40.25], [1700, 0], [-812.3, 1543.9], [12345.6, -9876.5]];
  const times = [0, 0.25, 7.3, 61.017, 3600.5];
  for (const [x, z] of positions) {
    for (const t of times) {
      for (const depth of depths) points.push({ x: x!, z: z!, t, depth });
    }
  }
  const out = createWaveSample();
  return specs.map((s) => {
    const w = compiledWaves(s);
    const spec: WaveSpec = {
      enabled: w.enabled, amplitudeScale: w.amplitudeScale, bigScale: w.bigScale, rippleScale: w.rippleScale,
      seed: w.seed, windSpeedKn: w.windSpeedKn, periodSeconds: w.periodSeconds, directionDeg: w.directionDeg,
    };
    return {
      spec,
      components: w.components,
      amplitudeLimit: w.amplitudeLimit,
      amplitude: waveAmplitude(w),
      points: points.map((p) => {
        sampleWaves(w, p.x, p.z, p.t, p.depth, out);
        return { ...p, out: { ...out } };
      }),
    };
  });
}

function windSamples() {
  const configs: WindConfig[] = [
    { speedKn: 7, fromDeg: 0, gusts: { enabled: false, seed: 1, gustScale: 1, shiftScale: 1 } },
    { speedKn: 7, fromDeg: 0 },
    { speedKn: 7, fromDeg: 0, gusts: { enabled: true, seed: 1, gustScale: 1, shiftScale: 1 } },
    { speedKn: 12.5, fromDeg: 237, gusts: { enabled: true, seed: BIG_SEED, gustScale: 1.5, shiftScale: 0.5 } },
    // Seed near 2^32: seed + 1 and seed + 99 overflow uint32 before the | 0 wrap.
    { speedKn: 4, fromDeg: 315, gusts: { enabled: true, seed: 0xffffffff, gustScale: 2, shiftScale: 2 } },
    // Strong gust scale drives the factor to its minFactor floor in lulls.
    { speedKn: 9, fromDeg: 45, gusts: { enabled: true, seed: 12345, gustScale: 3, shiftScale: 1 } },
    { speedKn: 0, fromDeg: 0, gusts: { enabled: true, seed: 5, gustScale: 1, shiftScale: 1 } },
  ];
  const points: { x: number; z: number; t: number }[] = [];
  for (let i = 0; i < 60; i++) {
    // Deterministic scatter across the bay and a long time span (gust patches and shifts).
    points.push({ x: round4(-2000 + ((i * 397) % 4000) + 0.37 * i), z: round4(-2000 + ((i * 613) % 4000) - 0.21 * i), t: round4((i * 37.3) % 600) });
  }
  points.push({ x: -1e-3, z: -1e-3, t: 0 }, { x: 90, z: -90, t: 1e4 }, { x: -4500.5, z: 3999.9, t: 86400 });
  return configs.map((config) => ({
    config,
    points: points.map((p) => {
      const w = getWind({ x: p.x, z: p.z }, p.t, config);
      return { ...p, out: { x: w.x, z: w.z } };
    }),
  }));
}

function terrainSamples() {
  const points: { x: number; z: number }[] = [];
  // Coarse grid over the bay, shores, islands and open water beyond.
  for (let x = -3000; x <= 3000; x += 150) {
    for (let z = -3000; z <= 3000; z += 150) points.push({ x, z });
  }
  // East shore along the grounding run (z = 0) and the beach/hill transition.
  for (let x = 1700; x <= 2300; x += 7.5) points.push({ x, z: 0 });
  // Shoal crossings: Holm Spit (150, -800) and Little Holm Ledge (700, 1150).
  for (let d = -300; d <= 300; d += 12.5) points.push({ x: 150 + d, z: -800 }, { x: 700, z: 1150 + d });
  // Island shores and centres (Great Holm, Little Holm); far sea and far land.
  points.push(
    { x: -750, z: -950 }, { x: -1400, z: -950 }, { x: -750, z: -620 }, { x: 950, z: 850 }, { x: 1140, z: 850 },
    { x: 0, z: 0 }, { x: -7999, z: -7999 }, { x: 7999, z: 2600 }, { x: 0, z: 5000 }, { x: 0.5, z: -0.5 },
  );
  return points.map(({ x, z }) => {
    const g = terrainGradient(x, z);
    return { x, z, h: terrainHeight(x, z), gx: g.x, gz: g.z };
  });
}

function boatSamples() {
  const boat = buildBoat();
  const scalars: Record<string, number> = {};
  for (const [key, value] of Object.entries(boat)) {
    if (typeof value === 'number') scalars[key] = value;
  }
  const spline = (s: { at(x: number): number }, xs: number[]) => xs.map((x) => ({ x, y: s.at(x) }));
  const range = (from: number, to: number, by: number) => {
    const xs: number[] = [];
    for (let i = 0; from + i * by <= to + 1e-9; i++) xs.push(round4(from + i * by));
    return xs;
  };
  return {
    ...scalars,
    board: boat.board,
    rudder: boat.rudder,
    splines: {
      clTable: spline(boat.clTable, range(-10, 190, 2.5)),
      cdvTable: spline(boat.cdvTable, range(-10, 190, 2.5)),
      residuaryRatio: spline(boat.residuaryRatio, range(0.05, 0.85, 0.0125)),
    },
  };
}

// --- Traces --------------------------------------------------------------------------------------

type Script = (i: number) => Controls;

interface Scenario {
  name: string;
  description: string;
  config: SimConfig;
  initial: BoatState;
  steps: number;
  controls: Script;
}

const control = (tiller: number, sheet: number, hike: number): Controls => ({
  tiller: round4(tiller), sheet: round4(sheet), hike: round4(hike),
});

/** Beam-reach trim (weather helm held off) with a slow tiller, sheet and hike weave. */
const reach: Script = (i) => control(-0.07 + 0.03 * Math.sin(i / 70), 0.5 + 0.1 * Math.sin(i / 150), 0.15 + 0.15 * Math.sin(i / 200));

/**
 * Close-hauled with a tack every 15 s, alternating sides: trim, 6 s hard over (tiller beyond +/-1
 * checks the step's control clamp), trim on the new side. Open loop: from the second tack on the
 * boat stalls head to wind and makes sternway, which exercises negative u and reversed flow.
 */
const tacking: Script = (i) => {
  const phase = i % 900, side = Math.floor(i / 900) % 2 === 0 ? 1 : -1;
  if (phase < 300) return control(-0.1 * side, 0.15, 0.3);
  if (phase < 660) return control(1.2 * side, 0.15, 0);
  return control(0.1 * side, 0.15, 0.3);
};

/** Broad reaches either side of dead downwind with a gybe every 12 s: trim, 4 s turn, trim. */
const gybing: Script = (i) => {
  const phase = i % 720, side = Math.floor(i / 720) % 2 === 0 ? 1 : -1;
  if (phase < 200) return control(-0.06 * side, 0.8, 0);
  if (phase < 440) return control(-0.5 * side, 0.2, 0);
  return control(0.06 * side, 0.8, 0);
};

function withWind(cfg: SimConfig, speedKn: number): SimConfig {
  cfg.wind.speedKn = speedKn;
  setWaveWind(cfg.waves, speedKn);
  return cfg;
}

function scenarios(): Scenario[] {
  const reachStart = initialState(90 * DEG, 1);
  const list: Scenario[] = [
    {
      name: 'flat-reach', description: 'defaultConfig: calm water, constant 7 kn, beam reach with a tiller weave',
      config: defaultConfig(), initial: reachStart, steps: 1800, controls: reach,
    },
  ];
  for (const layer of LAYER_IDS) {
    list.push({
      name: `no-${layer}`, description: `flat-reach with the ${layer} layer disabled`,
      config: withDisabledLayers(defaultConfig(), [layer]), initial: reachStart, steps: 900, controls: reach,
    });
  }
  const gusts = defaultConfig();
  if (gusts.wind.gusts) gusts.wind.gusts.enabled = true;
  const wavesNoGusts = browserConfig(1);
  if (wavesNoGusts.wind.gusts) wavesNoGusts.wind.gusts.enabled = false;
  const steep = withWind(defaultConfig(), 16);
  steep.waves.enabled = true;
  steep.waves.amplitudeScale = 2;
  setWaveLayers(steep.waves, 2, 1);
  setWaveParameters(steep.waves, 2, 135);
  const groundEast = defaultConfig();
  groundEast.land = true;
  const groundShoal = defaultConfig();
  groundShoal.land = true;
  const printed = defaultConfig();
  printed.models.liftSlope = 'printed';
  const tank = defaultConfig();
  tank.models.uprightResistance = 'tank';
  const rad = defaultConfig();
  rad.models.lambda0Unit = 'rad';
  list.push(
    {
      name: 'upwind-tacks', description: 'close-hauled, tack every 15 s (boom flip, crew crossing, tiller clamp, sternway in irons)',
      config: defaultConfig(), initial: initialState(55 * DEG, 2), steps: 3600, controls: tacking,
    },
    {
      name: 'downwind-gybes', description: 'broad reaches through dead downwind, gybe every 12 s (boom flip, crew crossing)',
      config: defaultConfig(), initial: initialState(150 * DEG, 2), steps: 2880, controls: gybing,
    },
    {
      name: 'heel-clamp', description: '16 kn, sheeted in, sitting in: heel reaches the heel limit; sheet/hike below 0 are clamped',
      config: withWind(defaultConfig(), 16), initial: reachStart, steps: 900, controls: () => control(0, -0.1, -0.2),
    },
    {
      name: 'waves', description: 'browserConfig(1) with gusts off: waves sized by the wind, bay seabed on',
      config: wavesNoGusts, initial: reachStart, steps: 1800, controls: reach,
    },
    {
      name: 'waves-steep', description: '16 kn, 2 s steep sea at the steepness limit, quartering: pitch clamp',
      config: steep, initial: initialState(0, 2), steps: 1800, controls: (i) => control(0.05 * Math.sin(i / 60), 0.3, 1),
    },
    {
      name: 'gusts', description: 'defaultConfig with gusts and shifts on, flat water',
      config: gusts, initial: reachStart, steps: 1800, controls: reach,
    },
    {
      name: 'browser', description: 'full browserConfig with a uint32 seed above 2^31 (waves, gusts, bay)',
      config: browserConfig(BIG_SEED), initial: reachStart, steps: 1800, controls: reach,
    },
    {
      name: 'ground-east', description: 'bay on: reach east from (1700, 0) onto the east shore, ground, then ease the sheet',
      config: groundEast, initial: { ...reachStart, x: 1700, z: 0, u: 2 }, steps: 8400,
      controls: (i) => (i < 7200 ? reach(i) : control(-0.07, 1, 0)),
    },
    {
      name: 'ground-shoal', description: 'bay on: reach across Holm Spit (150, -800, top 0.3 m deep), touching the shoal',
      config: groundShoal, initial: { ...reachStart, x: 40, z: -800, u: 2 }, steps: 3600, controls: reach,
    },
    {
      name: 'zero-wind', description: 'no wind: the boat coasts to rest from 2 m/s with a turned tiller',
      config: withWind(defaultConfig(), 0), initial: initialState(30 * DEG, 2), steps: 1800,
      controls: (i) => control(i < 600 ? 0.5 : 0, 0.5, 0),
    },
    {
      name: 'model-liftslope-printed', description: 'flat-reach with models.liftSlope = printed',
      config: printed, initial: reachStart, steps: 900, controls: reach,
    },
    {
      name: 'model-tank', description: 'flat-reach with models.uprightResistance = tank',
      config: tank, initial: reachStart, steps: 900, controls: reach,
    },
    {
      name: 'model-lambda0-rad', description: 'upwind with models.lambda0Unit = rad (large zero-lift drift)',
      config: rad, initial: initialState(55 * DEG, 2), steps: 900, controls: tacking,
    },
  );
  return list;
}

function selectDiagnostics(d: Diagnostics) {
  return {
    total: d.total,
    trueWind: d.trueWind,
    apparent: { u: d.apparent.u, v: d.apparent.v, speed: d.apparent.speed, angle: d.apparent.angle },
    speed: d.speed,
    leeway: d.leeway,
    vmg: d.vmg,
    boomTarget: d.boomTarget,
    boomSide: d.boomSide,
    sail: d.sail && { luffAmount: d.sail.luffAmount, stallAmount: d.sail.stallAmount },
    waves: d.waves && { height: d.waves.height, rollTarget: d.waves.rollTarget, pitchTarget: d.waves.pitchTarget },
    ground: d.ground && { depth: d.ground.depth, penetration: d.ground.penetration },
  };
}

/** One trace and a one-line summary of the edge cases it reached (printed by `npm run golden`). */
function runTrace(s: Scenario): { trace: unknown; summary: string } {
  const boat = buildBoat();
  const controls: Controls[] = [];
  const record = [];
  let state = s.initial;
  let flips = 0, maxHeel = 0, maxPitch = 0, maxPenetration = 0;
  for (let i = 0; i < s.steps; i++) {
    const c = s.controls(i);
    controls.push(c);
    const result = step(state, c, boat, s.config);
    if (result.state.boomSide !== state.boomSide) flips++;
    state = result.state;
    maxHeel = Math.max(maxHeel, Math.abs(state.heel) / DEG);
    maxPitch = Math.max(maxPitch, Math.abs(state.pitch) / DEG);
    maxPenetration = Math.max(maxPenetration, result.diagnostics.ground?.penetration ?? 0);
    if (i < RECORD_EVERY_UNTIL || i % RECORD_STRIDE === 0) {
      record.push({ step: i, state, diag: selectDiagnostics(result.diagnostics) });
    }
  }
  return {
    trace: { name: s.name, description: s.description, config: s.config, initial: s.initial, steps: s.steps, controls, record },
    summary: `${s.name.padEnd(24)} boom flips ${flips}, max heel ${maxHeel.toFixed(1)} deg, max pitch ${maxPitch.toFixed(1)} deg, `
      + `max penetration ${maxPenetration.toFixed(2)} m, final (${state.x.toFixed(0)}, ${state.z.toFixed(0)}) `
      + `heading ${(state.heading / DEG).toFixed(0)} deg, u ${state.u.toFixed(2)} m/s`,
  };
}

/** Every fixture file name with its JSON text, plus per-trace summaries. Deterministic. */
export function goldenFiles(): { files: Map<string, string>; summaries: string[] } {
  const files = new Map<string, string>();
  const summaries: string[] = [];
  files.set('samples.json', toJson({
    waves: waveSamples(),
    wind: windSamples(),
    terrain: terrainSamples(),
    landmarks: LANDMARKS.map((l) => ({ name: l.name, base: l.base })),
    boat: boatSamples(),
  }) + '\n');
  for (const s of scenarios()) {
    const { trace, summary } = runTrace(s);
    files.set(`trace-${s.name}.json`, toJson(trace) + '\n');
    summaries.push(summary);
  }
  return { files, summaries };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { files, summaries } = goldenFiles();
  for (const line of summaries) console.log(line);
  mkdirSync(GOLDEN_DIR, { recursive: true });
  for (const [name, text] of files) {
    writeFileSync(join(GOLDEN_DIR, name), text);
    console.log(`wrote ${join(GOLDEN_DIR, name)} (${(text.length / 1024).toFixed(0)} KiB)`);
  }
}
