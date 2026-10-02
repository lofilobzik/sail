import { describe, expect, it } from 'vitest';
import { WAKE, bowWave, bowWaveHeight, kelvinWake, wakeSourceAmplitude, type WakeSample } from './kelvin';
import { WakeTrail, type TrailPoint } from './trail';

const G = 9.81;
const pt = (x: number, time: number, z = 0): TrailPoint => ({ x, z, speed: 2, amplitude: 0.03, time });

describe('wake trail', () => {
  it('records a point every trailSpacing metres, not every frame', () => {
    const trail = new WakeTrail(WAKE);
    for (let i = 0; i <= 100; i++) trail.update(pt(i * 0.01 * WAKE.trailSpacing, i * 0.01));
    expect(trail.recorded).toBe(2); // at 0 and at one spacing
  });

  it('keeps at most trailPoints including the live head, and drops points older than maxAge', () => {
    const trail = new WakeTrail(WAKE);
    for (let i = 0; i < 200; i++) trail.update(pt(i * WAKE.trailSpacing, i * 0.01));
    expect(trail.recorded).toBe(WAKE.trailPoints - 1);
    const slow = new WakeTrail(WAKE);
    for (let i = 0; i < 10; i++) slow.update(pt(i * WAKE.trailSpacing, i * 10));
    expect(slow.recorded).toBe(Math.floor(WAKE.maxAge / 10) + 1);
  });

  it('clears on a reset (time going back) or a teleport', () => {
    const trail = new WakeTrail(WAKE);
    for (let i = 0; i < 10; i++) trail.update(pt(i * WAKE.trailSpacing, i));
    trail.update(pt(9 * WAKE.trailSpacing, 0));
    expect(trail.recorded).toBe(1);
    trail.update(pt(9 * WAKE.trailSpacing + WAKE.teleportDistance + 1, 1));
    expect(trail.recorded).toBe(1);
  });

  it('packs arc length and age from the head, and only shifts positions with the render origin', () => {
    const trail = new WakeTrail(WAKE);
    for (let i = 0; i <= 8; i++) trail.update(pt(1e7 + i * WAKE.trailSpacing, i, -3e6));
    const size = WAKE.trailPoints * 4;
    const a0 = new Float32Array(size);
    const b0 = new Float32Array(size);
    const n = trail.pack({ x: 1e7, z: -3e6 }, a0, b0);
    expect(n).toBe(10); // head + 9 recorded (the newest coincides with the head)
    expect(a0[0]).toBeCloseTo(8 * WAKE.trailSpacing, 5); // head local x
    expect(a0[(n - 1) * 4 + 2]).toBeCloseTo(8 * WAKE.trailSpacing, 5); // arc length to the oldest
    expect(b0[(n - 1) * 4 + 1]).toBe(8); // age of the oldest
    const a1 = new Float32Array(size);
    const b1 = new Float32Array(size);
    trail.pack({ x: 1e7 + 5, z: -3e6 - 2 }, a1, b1);
    for (let i = 0; i < n; i++) {
      expect(a1[i * 4]).toBeCloseTo(a0[i * 4]! - 5, 5);
      expect(a1[i * 4 + 1]).toBeCloseTo(a0[i * 4 + 1]! + 2, 5);
      expect(a1[i * 4 + 2]).toBe(a0[i * 4 + 2]);
      expect(b1[i * 4 + 1]).toBe(b0[i * 4 + 1]);
    }
  });
});

describe('wake source', () => {
  it('balances wave energy left behind against wave-making resistance', () => {
    const beam = 1.37;
    const A = wakeSourceAmplitude(9, 1025, beam);
    expect(0.5 * 1025 * G * A * A * WAKE.effectiveWidthFracBeam * beam).toBeCloseTo(9, 9);
    expect(wakeSourceAmplitude(0, 1025, beam)).toBe(0);
  });

  it('bow wave is a fraction of the stagnation head and vanishes at rest', () => {
    expect(bowWaveHeight(2)).toBeCloseTo((WAKE.bowHeadFrac * 4) / (2 * G), 12);
    expect(bowWaveHeight(0)).toBe(0);
  });
});

describe('irregular bow crest', () => {
  const height = 0.04;

  it('pins both arms at hull contact despite changing world position and time', () => {
    for (const side of [-WAKE.bowOffset, WAKE.bowOffset]) {
      for (const [x, z, p1, p2] of [[0, 0, 0, 0], [18, -7, 2, 3], [-5, 41, 5, 1]]) {
        expect(bowWave(0, side, height, x!, z!, p1!, p2!)).toBeCloseTo(height, 12);
      }
    }
  });

  it('stays positive and bounded, decays aft, and adds no displacement ahead of the bow or while disabled', () => {
    for (const aft of [0, 0.2, 0.7, 2, 5]) {
      const bound = height * (1 + WAKE.bowHeightVariation) * Math.exp(-aft / WAKE.bowLength);
      for (let side = -3; side <= 3; side += 0.07) {
        const h = bowWave(aft, side, height, side + 11, aft - 3, 1.7, 0.4);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThanOrEqual(bound);
      }
    }
    expect(bowWave(-WAKE.bowAhead, 0.2, height, 12, -4, 1, 2)).toBe(0);
    expect(bowWave(0.7, 0.3, 0, 12, -4, 1, 2)).toBe(0);
  });

  it('preserves the crest when floating-origin and time phases wrap', () => {
    const h = bowWave(0.9, 0.6, height, 3.2, -7.1, 0.4, 1.7);
    expect(bowWave(0.9, 0.6, height, 3.2 + WAKE.foamNoisePeriod, -7.1, 0.4, 1.7)).toBeCloseTo(h, 12);
    expect(bowWave(0.9, 0.6, height, 3.2, -7.1 - WAKE.foamNoisePeriod, 0.4 + 2 * Math.PI, 1.7 - 2 * Math.PI)).toBeCloseTo(h, 12);
  });
});

describe('Kelvin pattern', () => {
  const speed = 2;
  const lambda = (2 * Math.PI * speed * speed) / G;
  const out: WakeSample = { h: 0, dhds: 0, dhdn: 0 };
  const h = (s: number, n: number, footprint = 0) => kelvinWake(s, n, speed, 0.03, 0, 1, footprint, out).h;

  it('transverse waves on the track have wavelength 2 pi V^2 / g', () => {
    const s0 = 10 * lambda;
    const crossings: number[] = [];
    let prev = h(s0, 0);
    for (let s = s0; s < s0 + 3 * lambda; s += lambda / 2000) {
      const v = h(s, 0);
      if (prev < 0 !== v < 0) crossings.push(s);
      prev = v;
    }
    const spacing = (crossings[crossings.length - 1]! - crossings[0]!) / (crossings.length - 1);
    expect(spacing / (lambda / 2)).toBeCloseTo(1, 2);
  });

  it('divergent waves are strongest near the 19.47 degree cusp line', () => {
    const s = 6 * lambda;
    let best = 0;
    let bestN = 0;
    for (let n = 0; n < 2 * s * Math.tan(WAKE.kelvinHalfAngleDeg * (Math.PI / 180)); n += 0.005) {
      if (Math.abs(h(s, n)) > best) {
        best = Math.abs(h(s, n));
        bestN = n;
      }
    }
    const cusp = s * Math.tan(WAKE.kelvinHalfAngleDeg * (Math.PI / 180));
    const sigma = WAKE.armWidthFracWavelength * lambda + WAKE.armWidthGrowth * s;
    expect(Math.abs(bestN - cusp)).toBeLessThan(sigma);
  });

  it('is mirror-symmetric about the track', () => {
    for (const [s, n] of [[3, 0.7], [8, 2.1], [15, 4.9]] as const) {
      const left = { ...kelvinWake(s, n, speed, 0.03, 1, 1, 0, out) };
      const right = kelvinWake(s, -n, speed, 0.03, 1, 1, 0, out);
      expect(right.h).toBeCloseTo(left.h, 12);
      expect(right.dhds).toBeCloseTo(left.dhds, 12);
      expect(right.dhdn).toBeCloseTo(-left.dhdn, 12);
    }
  });

  it('is zero ahead of the stem, below minSpeed, and where the sampling cell cannot resolve it', () => {
    expect(h(-1, 0.3)).toBe(0);
    expect(kelvinWake(5, 1, WAKE.minSpeed * 0.9, 0.03, 0, 1, 0, out).h).toBe(0);
    expect(Math.abs(h(4 * lambda, 1.2))).toBeGreaterThan(0);
    expect(h(4 * lambda, 1.2, lambda)).toBe(0);
  });

  it('fades with age', () => {
    const young = Math.abs(kelvinWake(6, 0.2, speed, 0.03, 0, 1, 0, out).h);
    const old = Math.abs(kelvinWake(6, 0.2, speed, 0.03, WAKE.decayTime, 1, 0, out).h);
    expect(old / young).toBeCloseTo(Math.exp(-1), 9);
  });
});
