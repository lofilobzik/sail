import { describe, expect, it } from 'vitest';
import { browserConfig } from './config';
import { buildBoat } from './boat';
import { BERTHS, castOff, mooredAt } from './mooring';
import type { BoatState, Controls } from './state';
import { step, type Diagnostics } from './step';

const boat = buildBoat();
const EASED: Controls = { tiller: 0, sheet: 1, hike: 0 };
const STEPS = 900;
const SETTLE = 300; // measure after the start transient

function config(waves: boolean) {
  const cfg = browserConfig(1);
  if (cfg.wind.gusts) cfg.wind.gusts.enabled = false;
  cfg.waves.enabled = waves;
  return cfg;
}

/** Steps a boat moored at berth 0 with the sheet eased; returns every state and the last diagnostics. */
function moored(waves: boolean) {
  const cfg = config(waves);
  let s = mooredAt(BERTHS[0]!, boat, cfg);
  const states: BoatState[] = [];
  let maxPitchTarget = 0;
  let last: Diagnostics | null = null;
  for (let i = 0; i < STEPS; i++) {
    const r = step(s, EASED, boat, cfg);
    s = r.state;
    last = r.diagnostics;
    states.push(s);
    if (i >= SETTLE) maxPitchTarget = Math.max(maxPitchTarget, Math.abs(r.diagnostics.waves?.pitchTarget ?? 0));
  }
  const measured = states.slice(SETTLE);
  const heels = measured.map((m) => m.heel);
  return {
    cfg, states, measured, last: last!, maxPitchTarget,
    maxPitch: Math.max(...measured.map((m) => Math.abs(m.pitch))),
    heelRange: Math.max(...heels) - Math.min(...heels),
  };
}

describe('moored at a berth', () => {
  const withWaves = moored(true);
  const flat = moored(false);
  const berth = BERTHS[0]!;

  it('holds position, heading and velocities on every step', () => {
    for (const s of withWaves.states) {
      expect(s.moored).toBe(true);
      expect([s.x, s.z, s.heading]).toEqual([berth.x, berth.z, berth.headingDeg * Math.PI / 180]);
      expect([s.u, s.v, s.r]).toEqual([0, 0, 0]);
    }
  });

  it('pitches with the waves that reach the berth, and not at all without them', () => {
    expect(withWaves.maxPitchTarget).toBeGreaterThan(0.1 * Math.PI / 180);
    expect(withWaves.maxPitch).toBeGreaterThanOrEqual(0.3 * withWaves.maxPitchTarget);
    for (const s of flat.states) expect(s.pitch).toBe(0);
  });

  it('rolls on the waves', () => {
    expect(withWaves.heelRange).toBeGreaterThanOrEqual(5 * flat.heelRange);
  });

  it('luffs with the sheet eased', () => {
    expect(withWaves.last.sail?.luffAmount).toBeGreaterThan(0.5);
  });

  it('sails away once released', () => {
    let s: BoatState = { ...withWaves.states.at(-1)!, moored: false };
    const start = { x: s.x, z: s.z };
    for (let i = 0; i < 1200; i++) {
      s = step(s, { ...EASED, sheet: 0.25 }, boat, withWaves.cfg).state;
      expect(s.moored).toBe(false);
    }
    expect(Math.hypot(s.x - start.x, s.z - start.z)).toBeGreaterThan(5);
  });

  it('casts off forward and clear of the pontoon', () => {
    // Sheet eased, flat water: compare the shove with a plain release over two seconds.
    const drift = (shove: boolean) => {
      let s: BoatState = { ...flat.states.at(-1)! };
      if (shove) castOff(s);
      else s.moored = false;
      for (let t = 0; t < 2; t += flat.cfg.dt) s = step(s, EASED, boat, flat.cfg).state;
      const h = berth.headingDeg * Math.PI / 180;
      const dx = s.x - berth.x, dz = s.z - berth.z;
      // Compass heading, x east, z south: forward (sin h, -cos h), starboard (cos h, sin h).
      const away = berth.side === 'port' ? 1 : -1;
      return { ahead: dx * Math.sin(h) - dz * Math.cos(h), clear: away * (dx * Math.cos(h) + dz * Math.sin(h)) };
    };
    const pushed = drift(true);
    const released = drift(false);
    expect(pushed.ahead).toBeGreaterThan(released.ahead + 0.3);
    expect(pushed.clear).toBeGreaterThan(released.clear + 0.1);
    expect(pushed.clear).toBeGreaterThan(0);
  });
});
