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

  it('keeps its shape independent of frame rate and survives a stall', () => {
    const settle = (dts: number[], stallAt?: number) => {
      const cloth = new Cloth(planform, params);
      let stalled = stallAt === undefined;
      for (let t = 0, i = 0; t < 4; i++) {
        const dt = !stalled && t >= stallAt! ? ((stalled = true), 0.5) : dts[i % dts.length]!;
        cloth.update({ ...filled(1), dt });
        t += dt;
      }
      return cloth;
    };
    const reference = meanX(settle([1 / 60]));
    for (const cloth of [settle([1 / 60]), settle([1 / 30]), settle([1 / 120]), settle([1 / 30, 1 / 120]), settle([1 / 60], 2)]) {
      expect(Math.abs(meanX(cloth) / reference - 1)).toBeLessThan(0.05);
      expect(cloth.maxStretch(0.1)).toBeLessThan(0.1);
      expect(cloth.positions.every(Number.isFinite)).toBe(true);
    }
  });

  it('keeps normals finite, unit length and facing the same side as the triangle normals', () => {
    const { cols, rows } = planform;
    const check = (cloth: Cloth) => {
      const pos = cloth.positions;
      const faces = new Float64Array(pos.length);
      const corner = (v: number, d: number) => pos[v * 3 + d]!;
      for (let k = 0; k < rows - 1; k++) {
        for (let i = 0; i < cols - 1; i++) {
          const a = k * cols + i;
          const b = a + cols;
          // Same triangles and winding as the sail mesh (sail.ts).
          for (const [p, q, r] of [[a, a + 1, b], [a + 1, b + 1, b]] as const) {
            const u = [0, 1, 2].map((d) => corner(q, d) - corner(p, d));
            const v = [0, 1, 2].map((d) => corner(r, d) - corner(p, d));
            // Unnormalised cross product: twice the area, so the sum is area-weighted.
            const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
            for (const vert of [p, q, r]) for (let d = 0; d < 3; d++) faces[vert * 3 + d]! += n[d]!;
          }
        }
      }
      for (let v = 0; v < cols * rows; v++) {
        const n = [0, 1, 2].map((d) => cloth.normals[v * 3 + d]!);
        expect(n.every(Number.isFinite)).toBe(true);
        expect(Math.abs(Math.hypot(n[0]!, n[1]!, n[2]!) - 1)).toBeLessThan(1e-4);
        expect(n[0]! * faces[v * 3]! + n[1]! * faces[v * 3 + 1]! + n[2]! * faces[v * 3 + 2]!).toBeGreaterThan(0);
      }
    };
    const cloth = new Cloth(planform, params);
    run(cloth, filled(1), 4);
    check(cloth);
    run(cloth, luffing, 1);
    check(cloth);
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
