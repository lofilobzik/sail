import { describe, expect, it } from 'vitest';
import laser from '../../../data/laser.json';
import { Cloth, type ClothInput } from './cloth';
import { buildPlanform } from './planform';
import { telltalePoints, type V3 } from './telltale';

const s = laser.visual.sail;
const planform = buildPlanform({
  luff: laser.rig.luff,
  foot: laser.rig.foot,
  rake: (5.7 * Math.PI) / 180,
  leechFracs: s.leechFracs,
  widths: s.widths,
  headWidth: s.headWidth,
  camberDepthFrac: s.camberDepthFrac,
  camberPosFrac: s.camberPosFrac,
  cols: s.chordPoints,
  rows: s.heightPoints,
});
const params = laser.visual.cloth;

const filled = (leeward: number): ClothInput => ({ dt: 1 / 60, leeward, fill: 1, luff: 0, windDir: [leeward, 0, 0.3], windScale: 1 });
const luffing: ClothInput = { dt: 1 / 60, leeward: 0, fill: 0, luff: 1, windDir: [0, 0, 1], windScale: 1 };

function run(cloth: Cloth, input: ClothInput, seconds: number): void {
  for (let t = 0; t < seconds; t += input.dt) cloth.update(input);
}

function meanX(cloth: Cloth): number {
  let sum = 0;
  for (let i = 0; i < cloth.positions.length; i += 3) sum += cloth.positions[i]!;
  return sum / (cloth.positions.length / 3);
}

describe('sail planform', () => {
  it('closes the ILCA triangle: foot along the boom, roach widths at the leech fractions', () => {
    const { cols, rows, flat } = planform;
    const p = (i: number, k: number) => [flat[(k * cols + i) * 3 + 1]!, flat[(k * cols + i) * 3 + 2]!];
    expect(p(cols - 1, 0)).toEqual([0, expect.closeTo(laser.rig.foot, 5)]); // clew on the boom
    const head = p(0, rows - 1);
    expect(Math.hypot(head[0]!, head[1]!)).toBeCloseTo(laser.rig.luff, 4);
  });
});

describe('cloth', () => {
  it('keeps the luff and clew pinned, stays bounded and nearly inextensible', () => {
    const cloth = new Cloth(planform, params);
    run(cloth, filled(1), 4);
    const { cols, rows, flat } = planform;
    for (const idx of [0, (rows - 1) * cols, cols - 1, 5 * cols]) {
      for (let d = 0; d < 3; d++) expect(cloth.positions[idx * 3 + d]).toBeCloseTo(flat[idx * 3 + d]!, 6);
    }
    // Ignore the centimetre-long links near the head, where millimetres read as large ratios.
    expect(cloth.maxStretch(0.1)).toBeLessThan(0.1);
    expect(cloth.positions.every(Number.isFinite)).toBe(true);
  });

  it('billows to the pressure side and mirrors on the other tack', () => {
    const stbd = new Cloth(planform, params);
    const port = new Cloth(planform, params);
    run(stbd, filled(1), 4);
    run(port, filled(-1), 4);
    expect(meanX(stbd)).toBeGreaterThan(0.05);
    expect(meanX(port)).toBeCloseTo(-meanX(stbd), 2);
  });

  it('settles when filled and keeps moving when luffing', () => {
    const motion = (input: ClothInput) => {
      const cloth = new Cloth(planform, params);
      run(cloth, input, 4);
      const before = Float32Array.from(cloth.positions);
      run(cloth, input, 0.25);
      let max = 0;
      for (let i = 0; i < before.length; i++) max = Math.max(max, Math.abs(cloth.positions[i]! - before[i]!));
      return max;
    };
    expect(motion(filled(1))).toBeLessThan(0.01);
    expect(motion(luffing)).toBeGreaterThan(0.05);
  });
});

describe('telltales', () => {
  const shape = (lift: number) => ({ stream: [0, 0, 1] as V3, away: [1, 0, 0] as V3, lift, time: 0.37, phase: 0, segmentLength: 0.04 });
  const tip = (lift: number): V3 => {
    const out = telltalePoints([0, 0, 0], shape(lift), 4, new Float32Array(15));
    return [out[12]!, out[13]!, out[14]!];
  };

  it('streams aft along the surface when the flow is attached', () => {
    const [x, y, z] = tip(0);
    expect(z).toBeCloseTo(0.16, 2);
    expect(Math.abs(x)).toBeLessThan(0.02);
    expect(Math.abs(y)).toBeLessThan(1e-9);
  });

  it('leaves the surface and droops when the flow separates', () => {
    const [x, y, z] = tip(1);
    expect(z).toBeLessThan(0.12);
    expect(y).toBeLessThan(-0.03);
    expect(Math.hypot(x, y)).toBeGreaterThan(0.05);
  });
});
