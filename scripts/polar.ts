/**
 * Headless polar (PHYSICS.md section 5). For each true wind speed and true wind
 * angle: hold the heading with an autopilot, search the sheet for the best boat
 * speed, sail to steady state, record. Also runs a head-to-wind (in irons) test.
 *
 * Usage:
 *   npm run polar -- [--tws 6,7,8] [--twa-step 5] [--disable sail,foils]
 *                    [--disable-terms windage,downwash] [--enable-terms zeroLiftDrift]
 *                    [--model liftSlope=printed,lambda0Unit=rad,lambda0Sign=-1,uprightResistance=tank]
 *                    [--set rig.luffStartBetaEffDeg=20,crew.sitInOffset=0.3] [--quiet]
 *                    [--out polar-out]
 *                    [--waves] [--wave-amplitude 0..2]
 * Layers: apparentWind, sail, foils, hull, heel, yaw.
 * --set overrides numeric values of the boat config (data/laser.json) for tuning experiments.
 * When 9 kn is in --tws, the 9 kn result is compared with Day 2017 Figs 4 and 6 (data/laser-polar-target.json).
 * Outputs <out>/polar.csv, <out>/polar.svg and a summary on stdout.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import laserJson from '../src/data/laser.json';
import target from '../src/data/laser-polar-target.json';
import {
  DEG,
  KNOT,
  buildBoat,
  defaultConfig,
  initialState,
  step,
  setWaveParameters,
  withDisabledLayers,
  type ModelOptions,
  type SimConfig,
  type TermToggles,
} from '../src/sim/index';
import { bestTrim, type SteadyResult } from './lib/steadyState';
import { polarSvg } from './lib/svgPolar';

const { values } = parseArgs({
  options: {
    tws: { type: 'string', default: '6,7,8' },
    'twa-step': { type: 'string', default: '5' },
    disable: { type: 'string', default: '' },
    'disable-terms': { type: 'string', default: '' },
    'enable-terms': { type: 'string', default: '' },
    model: { type: 'string', default: '' },
    set: { type: 'string', default: '' },
    quiet: { type: 'boolean', default: false },
    waves: { type: 'boolean', default: false },
    'wave-amplitude': { type: 'string', default: '1' },
    'wave-period': { type: 'string' },
    'wave-direction': { type: 'string' },
    out: { type: 'string', default: 'polar-out' },
  },
});

const list = (s: string | undefined): string[] => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

function setTerms(cfg: SimConfig, names: string[], on: boolean): SimConfig {
  const terms = { ...cfg.terms };
  for (const name of names) {
    if (!(name in terms)) throw new Error(`unknown term "${name}", expected one of ${Object.keys(terms).join(', ')}`);
    terms[name as keyof TermToggles] = on;
  }
  return { ...cfg, terms };
}

let base = withDisabledLayers(defaultConfig(), list(values.disable));
base.waves.enabled = values.waves ?? false;
base.waves.amplitudeScale = Number(values['wave-amplitude']);
if (!Number.isFinite(base.waves.amplitudeScale)) throw new Error('--wave-amplitude must be finite');
const period = values['wave-period'] === undefined ? base.waves.periodSeconds : Number(values['wave-period']);
const direction = values['wave-direction'] === undefined ? base.waves.directionDeg : Number(values['wave-direction']);
if (!Number.isFinite(period) || !Number.isFinite(direction)) throw new Error('wave period and direction must be finite');
setWaveParameters(base.waves, period, direction);
base = setTerms(base, list(values['disable-terms']), false);
base = setTerms(base, list(values['enable-terms']), true);

const models: Record<string, string | number> = { ...base.models };
for (const kv of list(values.model)) {
  const [key, value] = kv.split('=');
  if (!key || value === undefined || !(key in models)) throw new Error(`bad --model "${kv}", keys: ${Object.keys(models).join(', ')}`);
  models[key] = typeof models[key] === 'number' ? Number(value) : value;
}
base = { ...base, models: models as unknown as ModelOptions };

const boatCfg = structuredClone(laserJson);
for (const kv of list(values.set)) {
  const [path, value] = kv.split('=');
  const keys = (path ?? '').split('.');
  let obj: Record<string, unknown> = boatCfg as unknown as Record<string, unknown>;
  for (const k of keys.slice(0, -1)) obj = obj[k] as Record<string, unknown>;
  const last = keys[keys.length - 1]!;
  if (typeof obj?.[last] !== 'number' || value === undefined) throw new Error(`bad --set "${kv}" (numeric boat config path required)`);
  obj[last] = Number(value);
}

const twsList = list(values.tws).map(Number);
const twaStep = Number(values['twa-step']);
const outDir = values.out ?? 'polar-out';
const boat = buildBoat(boatCfg);

const offLayers = Object.entries(base.layers).filter(([, on]) => !on).map(([k]) => k);
const offTerms = Object.entries(base.terms).filter(([, on]) => !on).map(([k]) => k);
console.log(`Disabled layers: ${offLayers.join(', ') || 'none'}; disabled terms: ${offTerms.join(', ') || 'none'}`);
console.log(`Models: ${JSON.stringify(base.models)}${values.set ? `; boat overrides: ${values.set}` : ''}`);
console.log(`Waves: ${base.waves.enabled ? 'on' : 'off'}; amplitude scale ${base.waves.amplitudeScale}`);
if (base.waves.enabled && base.waves.amplitudeScale > 0) {
  console.log('Warning: waves are periodic forcing; this steady-state polar is not a validated wave-performance prediction.');
}

const rows: string[] = [
  'tws_kn,twa_deg,boat_speed_kn,vmg_kn,leeway_deg,heel_deg,sheet,hike,rudder_deg,aws_kn,awa_deg,luff,stall,converged,sim_s',
];
const curves = [];
const f = (x: number, d = 2) => x.toFixed(d);

for (const tws of twsList) {
  const cfg: SimConfig = { ...base, wind: { ...base.wind, speedKn: tws } };
  const results: SteadyResult[] = [];
  for (let twa = 30; twa <= 180 + 1e-9; twa += twaStep) {
    const r = bestTrim(boat, cfg, twa);
    results.push(r);
    rows.push(
      [tws, twa, f(r.speedKn, 3), f(r.vmgKn, 3), f(r.leewayDeg), f(r.heelDeg), f(r.sheet, 3), f(r.hike), f(r.rudderDeg), f(r.awsKn), f(r.awaDeg, 1), f(r.luffAmount), f(r.stallAmount), r.converged, f(r.simSeconds, 0)].join(','),
    );
  }
  curves.push({ label: `TWS ${tws} kn`, points: results.map((r) => ({ twaDeg: r.twaDeg, speedKn: r.speedKn })) });

  console.log(`\nTWS ${tws} kn`);
  if (!values.quiet) {
    console.log(' TWA  speed  VMG   leeway heel  sheet hike rudder AWA  luff stall conv');
    for (const r of results) {
      console.log(
        `${f(r.twaDeg, 0).padStart(4)} ${f(r.speedKn).padStart(6)} ${f(r.vmgKn).padStart(5)} ${f(r.leewayDeg, 1).padStart(6)} ${f(r.heelDeg, 1).padStart(5)} ${f(r.sheet).padStart(5)} ${f(r.hike).padStart(4)} ${f(r.rudderDeg, 1).padStart(6)} ${f(r.awaDeg, 0).padStart(4)} ${f(r.luffAmount).padStart(5)} ${f(r.stallAmount).padStart(5)} ${r.converged ? 'y' : 'n'}`,
      );
    }
  }
  const upwind = results.reduce((a, b) => (b.vmgKn > a.vmgKn ? b : a));
  const downwind = results.reduce((a, b) => (b.vmgKn < a.vmgKn ? b : a));
  const peak = results.reduce((a, b) => (b.speedKn > a.speedKn ? b : a));
  const run = results[results.length - 1]!;
  console.log(
    `  best upwind VMG ${f(upwind.vmgKn)} kn at TWA ${upwind.twaDeg}; peak speed ${f(peak.speedKn)} kn at TWA ${peak.twaDeg}; ` +
      `dead run ${f(run.speedKn)} kn; best downwind VMG ${f(-downwind.vmgKn)} kn at TWA ${downwind.twaDeg}`,
  );
  const at30 = results[0]!;
  console.log(
    `  TWA 30: ${f(at30.speedKn)} kn (${f((100 * at30.speedKn) / upwind.speedKn, 0)}% of close-hauled speed ${f(upwind.speedKn)} kn), ` +
      `leeway close-hauled ${f(upwind.leewayDeg, 1)} deg, heel close-hauled ${f(upwind.heelDeg, 1)} deg, rudder ${f(upwind.rudderDeg, 1)} deg`,
  );
  if (tws === target.twsKn) {
    const cmp = (twas: number[], speeds: number[]) =>
      twas.map((twa, i) => {
        const r = results.find((x) => Math.abs(x.twaDeg - twa) < 1e-6);
        return r ? `${twa}: ${f(r.speedKn)}/${f(speeds[i]!)} (${f(r.speedKn - speeds[i]!, 2)})` : `${twa}: n/a`;
      });
    console.log(`  vs Day VPP 9 kn Fig 4 (ours/Day): ${cmp(target.upwind.twaDeg, target.upwind.speedKn).join('  ')}`);
    console.log(`  vs Day VPP 9 kn Fig 6 (ours/Day): ${cmp(target.downwind.twaDeg, target.downwind.speedKn).join('  ')}`);
  }

  // In irons: point straight into the wind at 3 kn, tiller centred, sheet half out.
  let s = initialState(cfg.wind.fromDeg * DEG, 3 * KNOT);
  const trace: string[] = [];
  for (let i = 1; i <= Math.round(60 / cfg.dt); i++) {
    s = step(s, { tiller: 0, sheet: 0.5, hike: 0 }, boat, cfg).state;
    if (i % Math.round(10 / cfg.dt) === 0) {
      trace.push(`t=${f(s.t, 0)}s u=${f(s.u / KNOT)}kn hdg_off_wind=${f((s.heading / DEG + 540 - cfg.wind.fromDeg) % 360 - 180, 0)}deg`);
    }
  }
  console.log(`  head to wind: ${trace.join(' | ')}`);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'polar.csv'), rows.join('\n') + '\n');
const title = `Laser polar (disabled: ${[...offLayers, ...offTerms].join(', ') || 'none'})`;
writeFileSync(join(outDir, 'polar.svg'), polarSvg(curves, title));
console.log(`\nWrote ${join(outDir, 'polar.csv')} and ${join(outDir, 'polar.svg')}`);
