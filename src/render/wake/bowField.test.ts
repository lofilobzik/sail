import { describe, expect, it } from 'vitest';
import { BowWaveField, type BowEmitter } from './bowField';
import { WAKE } from './kelvin';

const center = { x: 0, z: 0 };
const height = 0.04;
const speed = 2;
const foam = 0.8;
const c = speed * Math.sin(WAKE.bowAngleDeg * Math.PI / 180);
const period = 2 * Math.PI * c / 9.81;

function emitter(time: number, overrides: Partial<BowEmitter> = {}): BowEmitter {
  return { x: 0, z: 0, time, height, speed, foam, ...overrides };
}

function sample(field: BowWaveField, x: number, z = 0): Float64Array {
  const out = new Float64Array(4);
  field.sample(x, z, out);
  return out;
}

function maxDifference(a: Float32Array, b: Float32Array, channel?: number): number {
  let difference = 0;
  for (let i = channel ?? 0; i < a.length; i += channel === undefined ? 1 : 4) {
    difference = Math.max(difference, Math.abs(a[i]! - b[i]!));
  }
  return difference;
}

function expectZero(field: BowWaveField): void {
  let maximum = 0;
  for (const value of field.data) maximum = Math.max(maximum, Math.abs(value));
  expect(maximum).toBe(0);
}

function widthAt(field: BowWaveField, radius: number): number {
  const physical = WAKE.bowWidth + WAKE.bowWidthGrowth * radius;
  return Math.sqrt(physical * physical + field.cellSize * field.cellSize / 6);
}

describe('independent emitted bow fronts', () => {
  it('propagates an isolated circular crest with inner and outer signed troughs and birth reference channels', () => {
    const field = new BowWaveField(WAKE);
    field.update(emitter(0), center);
    for (const radius of [1, 3, 5]) {
      const age = (radius - WAKE.bowOffset) / c;
      field.update(emitter(age, { height: 0, speed: 0, foam: 0 }), center);
      const width = widthAt(field, radius);
      const crest = sample(field, radius);
      expect(crest[0]).toBeGreaterThan(0);
      expect(crest[0]).toBeLessThan(height);
      expect(crest[0]).toBeCloseTo(height * Math.exp(-age / WAKE.bowDecayTime) / Math.sqrt(1 + radius / WAKE.bowLength), 7);
      expect(crest[1]).toBeCloseTo(height, 7);
      expect(crest[2]).toBeCloseTo(foam * Math.exp(-age / WAKE.bowDecayTime), 6);
      expect(crest[3]).toBeCloseTo(width, 7);
      for (const sign of [-1, 1]) {
        expect(sample(field, sign * (radius - 1.5 * width))[0]).toBeLessThan(0);
        expect(sample(field, sign * (radius + 1.5 * width))[0]).toBeLessThan(0);
        expect(sample(field, sign * radius)[0]).toBeCloseTo(crest[0]!, 7);
        expect(sample(field, 0, sign * radius)[0]).toBeCloseTo(crest[0]!, 7);
      }
      expect(sample(field, radius + 4 * width + field.cellSize)[0]).toBe(0);
      if (age > 1) expect(sample(field, WAKE.bowOffset + c)[0]).toBe(0);
    }
  });

  it('does not translate or retune an old front when pitch shifts current contact or source strength', () => {
    const shifted = new BowWaveField(WAKE);
    const isolated = new BowWaveField(WAKE);
    for (const field of [shifted, isolated]) field.update(emitter(0), center);
    shifted.update(emitter(0.3, { x: 20, height: 0.12, speed: 5, foam: 0.3 }), center);
    isolated.update(emitter(0.3, { height: 0 }), center);
    expect(maxDifference(shifted.data, isolated.data)).toBe(0);

    shifted.update(emitter(0.9, { x: 20, height: 0.12, speed: 5, foam: 0.3 }), center);
    // A later source change must leave the second birth's speed and strength intact too.
    shifted.update(emitter(1.05, { x: -20, height: 0.005, speed: 1, foam: 0 }), center);
    isolated.update(emitter(1.05, { height: 0, speed: 0, foam: 0 }), center);
    const oldRadius = WAKE.bowOffset + c * 1.05;
    const old = sample(shifted, oldRadius);
    const reference = sample(isolated, oldRadius);
    for (let channel = 0; channel < 4; channel++) expect(old[channel]).toBe(reference[channel]);
    const secondAge = 1.05 - period;
    const secondC = 5 * Math.sin(WAKE.bowAngleDeg * Math.PI / 180);
    const second = sample(shifted, 20 + WAKE.bowOffset + secondC * secondAge);
    expect(second[0]).toBeGreaterThan(0);
    expect(second[1]).toBeCloseTo(0.12, 7);
    expect(second[2]).toBeCloseTo(0.3 * Math.exp(-secondAge / WAKE.bowDecayTime), 7);
    expect(second[3]).toBeCloseTo(widthAt(shifted, WAKE.bowOffset + secondC * secondAge), 7);
  });

  it('keeps old fronts through dry contact and stops, emits immediately on reentry, and never bridges a dry gap', () => {
    const field = new BowWaveField(WAKE);
    field.update(emitter(0), center);
    field.update(emitter(0.2, { height: 0 }), center);
    field.update(emitter(2, { x: 10, height: 0.08 }), center);
    field.update(emitter(2.2, { x: 10, speed: 0, foam: 0 }), center);
    const first = sample(field, WAKE.bowOffset + c * 2.2);
    const reentry = sample(field, 10 + WAKE.bowOffset + c * 0.2);
    expect(first[0]).toBeGreaterThan(0);
    expect(first[1]).toBeCloseTo(height, 7);
    expect(first[2]).toBeGreaterThan(0);
    expect(reentry[0]).toBeGreaterThan(0);
    expect(reentry[1]).toBeCloseTo(0.08, 7);
    expect(sample(field, 5)[0]).toBe(0);
    field.update(emitter(3, { x: 10, speed: WAKE.minSpeed * 0.5 }), center);
    expect(sample(field, 10 + WAKE.bowOffset + c)[1]).toBeCloseTo(0.08, 7);
    field.update(emitter(4, { x: -10 }), center);
    field.update(emitter(4.2, { height: 0 }), center);
    expect(sample(field, -10 + WAKE.bowOffset + c * 0.2)[0]).toBeGreaterThan(0);
    expect(sample(field, WAKE.bowOffset + c * 4.2)[0]).toBeGreaterThan(0);
  });

  it('ages height and foam while retaining the source reference, then smoothly expires while dry', () => {
    const field = new BowWaveField(WAKE);
    field.update(emitter(0), center);
    field.update(emitter(3, { height: 0, speed: 0, foam: 0 }), center);
    const young = sample(field, WAKE.bowOffset + c * 3);
    field.update(emitter(7, { height: 0, speed: 0, foam: 0 }), center);
    const old = sample(field, WAKE.bowOffset + c * 7);
    expect(old[0]).toBeGreaterThan(0);
    expect(old[0]).toBeLessThan(young[0]!);
    expect(old[1]).toBeCloseTo(young[1]!, 7);
    expect(old[2]! / young[2]!).toBeCloseTo(Math.exp(-4 / WAKE.bowDecayTime), 6);
    const expiryAge = WAKE.bowMaxAge - period / 2;
    field.update(emitter(expiryAge, { height: 0 }), center);
    const expiring = sample(field, WAKE.bowOffset + c * expiryAge);
    expect(expiring[0]).toBeGreaterThan(0);
    expect(expiring[1]).toBeCloseTo(height, 7);
    expect(expiring[2]).toBeCloseTo(0.5 * foam * Math.exp(-expiryAge / WAKE.bowDecayTime), 7);
    field.update(emitter(WAKE.bowMaxAge + 0.01, { height: 0 }), center);
    expectZero(field);
  });

  it('smooths each birth rather than popping and bounds overlapping signed heights by source strength', () => {
    const field = new BowWaveField(WAKE);
    field.update(emitter(0), center);
    expectZero(field);
    const halfRise = period * WAKE.bowRiseFraction / 2;
    field.update(emitter(halfRise, { height: 0 }), center);
    const emerging = sample(field, WAKE.bowOffset + c * halfRise);
    expect(emerging[0]).toBeGreaterThan(0);
    expect(emerging[0]).toBeLessThan(height / 2);
    expect(emerging[1]).toBeCloseTo(height, 7);
    expect(emerging[2]).toBeCloseTo(0.5 * foam * Math.exp(-halfRise / WAKE.bowDecayTime), 7);

    const ongoing = new BowWaveField(WAKE);
    const oldOnly = new BowWaveField(WAKE);
    for (const f of [ongoing, oldOnly]) f.update(emitter(0), center);
    ongoing.update(emitter(period), center);
    oldOnly.update(emitter(period, { height: 0 }), center);
    expect(maxDifference(ongoing.data, oldOnly.data)).toBe(0);
    ongoing.update(emitter(period + 0.001), center);
    oldOnly.update(emitter(period + 0.001, { height: 0 }), center);
    expect(maxDifference(ongoing.data, oldOnly.data, 0)).toBeLessThan(height * 0.001);

    ongoing.update(emitter(4), center);
    let strongest = 0;
    let trough = 0;
    let reference = 0;
    for (let i = 0; i < ongoing.data.length; i += 4) {
      strongest = Math.max(strongest, ongoing.data[i]!);
      trough = Math.min(trough, ongoing.data[i]!);
      reference = Math.max(reference, ongoing.data[i + 1]!);
    }
    expect(Math.max(strongest, -trough)).toBeLessThanOrEqual(height);
    expect(reference).toBeLessThanOrEqual(height);
    expect(strongest).toBeGreaterThan(height * 0.1);
    expect(trough).toBeLessThan(-height * 0.01);
  });

  it('bounds dense slow-speed trough overlap as well as positive crests', () => {
    const field = new BowWaveField(WAKE);
    const slow = WAKE.minSpeed + 0.01;
    let deepest = 0;
    let strongest = 0;
    for (let frame = 0; frame <= 16; frame++) {
      const time = frame / 2;
      const moving = { x: 0, z: -slow * time };
      field.update(emitter(time, { ...moving, speed: slow }), moving);
      for (let index = 0; index < field.data.length; index += 4) {
        const displacement = field.data[index]!;
        deepest = Math.min(deepest, displacement);
        strongest = Math.max(strongest, Math.abs(displacement));
      }
    }
    expect(strongest).toBeLessThanOrEqual(height * (1 + 1e-6));
    expect(deepest).toBeLessThan(-height * 0.1);
  });

  it('interpolates exact birth properties independently of render cadence for a changing moving source', () => {
    const coarse = new BowWaveField(WAKE);
    const fine = new BowWaveField(WAKE);
    for (const [field, steps] of [[coarse, 13], [fine, 65]] as const) {
      for (let step = 0; step <= steps; step++) {
        const time = 3.25 * step / steps;
        field.update(emitter(time, {
          x: 1.5 * time,
          z: -0.5 * time,
          speed: 2 + 0.25 * time,
          height: 0.02 + 0.002 * time,
          foam: 0.7 - 0.02 * time,
        }), center);
      }
    }
    expect(sample(coarse, -(WAKE.bowOffset + c * 3.25))[0]).toBeGreaterThan(0.02 * 0.1);
    expect(maxDifference(coarse.data, fine.data)).toBeLessThan(1e-6);
  });

  it('skips stale births across a long wet time jump without changing the surviving emission phase', () => {
    const jumped = new BowWaveField(WAKE);
    const recent = new BowWaveField(WAKE);
    const time = 1e6 + 0.123;
    const firstSurvivor = Math.ceil((time - WAKE.bowMaxAge) / period) * period;
    jumped.update(emitter(0), center);
    jumped.update(emitter(time), center);
    recent.update(emitter(firstSurvivor), center);
    recent.update(emitter(time), center);
    expect(sample(jumped, WAKE.bowOffset + c * 3)[1]).toBeCloseTo(height, 7);
    expect(maxDifference(jumped.data, recent.data)).toBeLessThan(1e-5);
  });
});

describe('world-space bow field cache', () => {
  it('rolls on an absolute world grid without moving a front or changing bilinear samples', () => {
    const field = new BowWaveField(WAKE);
    field.update(emitter(0), center);
    field.update(emitter(2, { height: 0 }), center);
    const points = [[2.08, 0], [1.9, 0.37], [-2.08, 0], [0, -2.5]] as const;
    const before = points.map(([x, z]) => sample(field, x, z));
    expect(field.update(emitter(2, { x: 18, height: 0 }), { x: field.cellSize * 0.8, z: 0 })).toBe(false);
    expect(field.update(emitter(2, { x: 18, height: 0 }), { x: field.cellSize * 3.4, z: -field.cellSize * 2.1 })).toBe(true);
    for (let point = 0; point < points.length; point++) {
      const [x, z] = points[point]!;
      const after = sample(field, x, z);
      for (let channel = 0; channel < 4; channel++) expect(after[channel]).toBeCloseTo(before[point]![channel]!, 8);
    }
  });

  it('retains the same front at large logical-world coordinates independently of floating render origins', () => {
    const local = new BowWaveField(WAKE);
    const distant = new BowWaveField(WAKE);
    const shift = { x: 1e9, z: -3e8 };
    local.update(emitter(0, { x: 0.125, z: -0.375 }), center);
    distant.update(emitter(0, { x: shift.x + 0.125, z: shift.z - 0.375 }), shift);
    local.update(emitter(3, { height: 0 }), center);
    distant.update(emitter(3, { height: 0, x: shift.x, z: shift.z }), shift);
    expect(maxDifference(local.data, distant.data)).toBe(0);
    for (const [x, z] of [[3.205, -0.375], [0.625, 2.525], [-2.625, -0.5]]) {
      const near = sample(local, x!, z!);
      const far = sample(distant, shift.x + x!, shift.z + z!);
      for (let channel = 0; channel < 4; channel++) expect(far[channel]).toBeCloseTo(near[channel]!, 6);
    }
  });

  it('lets an outgoing front reach zero height and foam with a smooth boundary slope', () => {
    const field = new BowWaveField(WAKE);
    const edgeX = -WAKE.bowFieldSize / 2;
    field.update(emitter(0, { x: edgeX + WAKE.bowOffset + c }), center);
    field.update(emitter(1, { height: 0 }), center);
    const atEdge = sample(field, edgeX);
    expect(Math.abs(atEdge[0]!)).toBe(0);
    expect(Math.abs(atEdge[2]!)).toBe(0);
    // A C1 fade approaches the boundary quadratically, not as a hard cut or a linear ramp.
    const near = sample(field, edgeX + 0.001);
    const twice = sample(field, edgeX + 0.002);
    for (const channel of [0, 2]) {
      expect(twice[channel]!).toBeGreaterThan(3 * near[channel]!);
      expect(twice[channel]!).toBeLessThan(5 * near[channel]!);
    }
    expect(sample(field, edgeX - 0.001)).toEqual(new Float64Array(4));
    expect(sample(field, edgeX + WAKE.bowFieldSize)).toEqual(new Float64Array(4));
  });

  it('clears on rewind, boat teleport and explicit disable, but emitter displacement alone never resets', () => {
    const field = new BowWaveField(WAKE);
    field.update(emitter(0), center);
    field.update(emitter(1, { height: 0 }), center);
    const crest = sample(field, WAKE.bowOffset + c);
    field.update(emitter(1, { x: 30, height: 0 }), center);
    expect(sample(field, WAKE.bowOffset + c)[0]).toBe(crest[0]);
    field.update(emitter(0.5, { height: 0 }), center);
    expectZero(field);

    field.update(emitter(0.5), center);
    field.update(emitter(0.8, { height: 0 }), center);
    const fresh = new BowWaveField(WAKE);
    fresh.update(emitter(0.5), center);
    fresh.update(emitter(0.8, { height: 0 }), center);
    expect(sample(field, WAKE.bowOffset + c * 0.3)[0]).toBeGreaterThan(0);
    expect(maxDifference(field.data, fresh.data)).toBe(0);
    // The old birth remains inside the cache after this boat jump, so zero
    // proves reset rather than merely cropping the old front out of view.
    field.update(emitter(0.9, { height: 0 }), { x: WAKE.teleportDistance + 1, z: 0 });
    expectZero(field);
    field.update(emitter(1), center);
    field.update(emitter(1.3, { height: 0 }), center);
    expect(sample(field, WAKE.bowOffset + c * 0.3)[0]).toBeGreaterThan(0);
    field.clear();
    expectZero(field);
    field.update(emitter(10, { height: 0 }), center);
    expectZero(field);
    field.update(emitter(10), center);
    field.update(emitter(10.3, { height: 0 }), center);
    expect(sample(field, WAKE.bowOffset + c * 0.3)[0]).toBeGreaterThan(0);
  });
});
