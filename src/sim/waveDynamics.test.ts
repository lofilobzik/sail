import { describe, expect, it } from 'vitest';
import { buildBoat } from './boat';
import { defaultConfig, withDisabledLayers, type SimConfig } from './config';
import { DEG, G } from './frames';
import { initialState, type BoatState } from './state';
import { evaluate, step } from './step';
import type { WaveComponent } from './waves';

const boat = buildBoat();
const controls = { tiller: 0, sheet: 0.5, hike: 0 };

function waveConfig(dx: number, dz: number, phase: number): SimConfig {
  // Deliberate deterministic test sea, not boat response tuning.
  const k = 2 * Math.PI / 12;
  const component: WaveComponent = { dx, dz, k, omega: Math.sqrt(G * k), amplitude: 0.12, phase, choppiness: 1 };
  const cfg = withDisabledLayers(defaultConfig(), ['sail', 'hull', 'apparentWind']);
  return {
    ...cfg,
    substeps: 1,
    wind: { speedKn: 0, fromDeg: 0 },
    terms: { ...cfg.terms, downwash: false, zeroLiftDrift: false, munkMoment: false },
    waves: { ...cfg.waves, enabled: true, amplitudeScale: 1, components: [component] },
  };
}

function advance(state: BoatState, cfg: SimConfig, count: number): BoatState {
  for (let i = 0; i < count; i++) state = step(state, controls, boat, cfg).state;
  return state;
}

describe('physical wave response', () => {
  it('preserves the exact flat-water trajectory and diagnostics at zero amplitude', () => {
    const off = defaultConfig();
    const zero = { ...off, waves: { ...off.waves, enabled: true, amplitudeScale: 0 } };
    let a = { ...initialState(55 * DEG, 2), heel: 0.1, p: -0.02, v: 0.15, r: 0.01 };
    let b = { ...a };
    for (let i = 0; i < 600; i++) {
      const ra = step(a, controls, boat, off);
      const rb = step(b, controls, boat, zero);
      expect(rb).toEqual(ra);
      expect(ra.diagnostics.waves).toBeNull();
      a = ra.state;
      b = rb.state;
    }
  });

  it('a signed transverse surface slope applies restoring torque to actual roll state', () => {
    const plus = withDisabledLayers(waveConfig(1, 0, 0), ['foils']);
    const minus = withDisabledLayers(waveConfig(-1, 0, 0), ['foils']);
    const start = initialState();
    const a = step(start, controls, boat, plus);
    const b = step(start, controls, boat, minus);
    expect(a.diagnostics.waves!.rollTarget).toBeLessThan(0);
    expect(a.diagnostics.waves!.rollMoment).toBeLessThan(0);
    const steepness = plus.waves.components[0]!.k * plus.waves.components[0]!.amplitude;
    expect(Math.abs(a.diagnostics.waves!.rollTarget)).toBeGreaterThan(0.9 * steepness);
    expect(Math.abs(a.diagnostics.waves!.rollTarget)).toBeLessThan(1.1 * steepness);
    expect(a.state.p).toBeLessThan(0);
    expect(a.state.heel).toBeLessThan(0);
    expect(b.state.p).toBeCloseTo(-a.state.p, 12);
    expect(b.state.heel).toBeCloseTo(-a.state.heel, 12);
  });

  it('a signed longitudinal surface slope drives bow-up/down pitch, not a pose-only offset', () => {
    const plus = withDisabledLayers(waveConfig(0, -1, 0), ['foils']);
    const minus = withDisabledLayers(waveConfig(0, 1, 0), ['foils']);
    const a = step(initialState(), controls, boat, plus);
    const b = step(initialState(), controls, boat, minus);
    expect(a.diagnostics.waves!.pitchTarget).toBeGreaterThan(0);
    expect(a.state.pitchRate).toBeGreaterThan(0);
    expect(a.state.pitch).toBeGreaterThan(0);
    expect(b.state.pitchRate).toBeCloseTo(-a.state.pitchRate, 12);
    expect(b.state.pitch).toBeCloseTo(-a.state.pitch, 12);
  });

  it('opposite side-wave orbital flow reverses foil side force and course deflection', () => {
    const plus = withDisabledLayers(waveConfig(1, 0, Math.PI / 2), ['heel']);
    const minus = withDisabledLayers(waveConfig(-1, 0, Math.PI / 2), ['heel']);
    const start = initialState(0, 2);
    const da = evaluate(start, controls, boat, plus);
    const db = evaluate(start, controls, boat, minus);
    expect(da.waves!.boardV).toBeGreaterThan(0);
    const primary = plus.waves.components[0]!;
    expect(da.waves!.boardV).toBeCloseTo(
      primary.amplitude * primary.omega * Math.exp(primary.k * boat.board.z), 10,
    );
    expect(da.foils!.fy).toBeGreaterThan(0);
    expect(Math.abs(da.foils!.yawMoment)).toBeGreaterThan(1e-3);
    expect(db.foils!.fy).toBeCloseTo(-da.foils!.fy, 10);
    expect(db.foils!.yawMoment).toBeCloseTo(-da.foils!.yawMoment, 10);
    const a = advance(start, plus, 30);
    const b = advance(start, minus, 30);
    expect(a.v).toBeGreaterThan(0);
    expect(Math.abs(a.heading)).toBeGreaterThan(1e-5);
    expect(b.v).toBeCloseTo(-a.v, 10);
    expect(b.heading).toBeCloseTo(-a.heading, 10);
    expect(b.x).toBeCloseTo(-a.x, 10);
  });

  it('samples depth independently: a deeper board loses orbital forcing without changing the rudder', () => {
    const cfg = withDisabledLayers(waveConfig(1, 0, Math.PI / 2), ['heel']);
    const start = initialState(0, 2);
    const shallow = evaluate(start, controls, boat, cfg);
    const deeperBoat = { ...boat, board: { ...boat.board, z: boat.board.z - 1 } };
    const deep = evaluate(start, controls, deeperBoat, cfg);
    expect(deep.waves!.boardV / shallow.waves!.boardV).toBeCloseTo(Math.exp(-cfg.waves.components[0]!.k), 10);
    expect(Math.abs(deep.foils!.board.fy)).toBeLessThan(Math.abs(shallow.foils!.board.fy));
    expect(deep.foils!.rudder).toEqual(shallow.foils!.rudder);
    expect(deep.waves!.rudderV).toBe(shallow.waves!.rudderV);
  });

  it('samples distinct fore/aft positions: half-wavelength separation reverses each foil load', () => {
    const cfg = withDisabledLayers(waveConfig(0, -1, Math.PI / 2), ['heel']);
    // Oblique heading exposes both the fore/aft phase difference and lateral flow.
    cfg.waves = { ...cfg.waves, components: [{ ...cfg.waves.components[0]!, dx: 1, dz: 0 }] };
    const start = initialState(Math.PI / 4, 2);
    const base = evaluate(start, controls, boat, cfg);
    const shiftedBoat = { ...boat, rudder: { ...boat.rudder, x: boat.rudder.x + 6 / Math.sin(start.heading) } };
    const shifted = evaluate(start, controls, shiftedBoat, cfg);
    expect(shifted.foils!.board).toEqual(base.foils!.board);
    expect(base.waves!.rudderV * shifted.waves!.rudderV).toBeLessThan(0);
    expect(base.foils!.rudder.fy * shifted.foils!.rudder.fy).toBeLessThan(0);
  });

  it('heel/pitch geometry changes submerged inflow and disabled layers remain inactive', () => {
    const cfg = waveConfig(1, 0, 0);
    const start = { ...initialState(0.3, 2), heel: 0.2, pitch: 0.15, pitchRate: 0.1 };
    const tilted = evaluate(start, controls, boat, cfg);
    const level = evaluate({ ...start, heel: 0, pitch: 0, pitchRate: 0 }, controls, boat, cfg);
    expect(Math.abs(tilted.waves!.boardV - level.waves!.boardV)).toBeGreaterThan(1e-3);
    expect(Math.abs(tilted.foils!.board.fx - level.foils!.board.fx)).toBeGreaterThan(1e-3);
    const snapshot = { ...tilted.waves! };
    evaluate({ ...start, t: 5 }, controls, boat, cfg);
    expect(tilted.waves).toEqual(snapshot);
    const disabled = withDisabledLayers(cfg, ['heel', 'yaw', 'foils']);
    const result = step(start, controls, boat, disabled);
    expect(result.diagnostics.foils).toBeNull();
    expect(result.diagnostics.waves!.rollMoment).toBe(0);
    expect(result.state.heel).toBe(0);
    expect(result.state.pitch).toBe(0);
    expect(result.state.r).toBe(0);
    expect(result.state.heading).toBe(start.heading);
  });
});
