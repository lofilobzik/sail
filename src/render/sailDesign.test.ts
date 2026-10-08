import { describe, expect, it } from 'vitest';
import construction from '../../data/sail-construction.json';
import { parseDesignFile, patternCells, starVertices } from './sailDesign';
import { layoutSailConstruction } from './sailConstruction';

/** Minimal valid file with one design whose layers are replaced per test. */
function fileWith(layers: unknown[], extra: Record<string, unknown> = {}): unknown {
  return {
    default: 'a',
    textureWidth: 64,
    finish: { grain: 0, grainAlpha: 0, seed: 1 },
    designs: [{ id: 'a', name: 'A', layers }],
    ...extra,
  };
}

describe('sail design parsing', () => {
  it('names the design and layer when a colour is wrong', () => {
    const bad = fileWith([{ type: 'fill', color: '#ffffff' }, { type: 'circle', cx: 0.5, cy: 0.5, r: 0.1, color: 'blue-ish' }]);
    expect(() => parseDesignFile(bad)).toThrow(/design "a" layer 1.*"color".*blue-ish/);
  });

  it('rejects unknown layer types, a missing first cover layer, bad polygons and unknown defaults', () => {
    expect(() => parseDesignFile(fileWith([{ type: 'fill', color: '#fff' }, { type: 'swirl' }]))).toThrow(/unknown layer type "swirl"/);
    expect(() => parseDesignFile(fileWith([{ type: 'circle', cx: 0, cy: 0, r: 0.1, color: '#fff' }]))).toThrow(/first layer must be a fill or gradient/);
    expect(() => parseDesignFile(fileWith([{ type: 'fill', color: '#fff' }, { type: 'polygon', points: [[0, 0], [1, 1]], color: '#000' }]))).toThrow(/at least 3 points/);
    expect(() => parseDesignFile(fileWith([{ type: 'fill', color: '#fff' }], { default: 'zzz' }))).toThrow(/"default" zzz is not a design id/);
  });

  it('rejects duplicate ids', () => {
    const dup = fileWith([{ type: 'fill', color: '#fff' }], {
      designs: [
        { id: 'a', name: 'A', layers: [{ type: 'fill', color: '#fff' }] },
        { id: 'a', name: 'B', layers: [{ type: 'fill', color: '#000' }] },
      ],
    });
    expect(() => parseDesignFile(dup)).toThrow(/duplicate id "a"/);
  });


  it('keeps opacity in (0, 1] and glow in [0, 1], and leaves them undefined otherwise', () => {
    const layers = [{ type: 'fill', color: '#fff' }];
    const withExtras = (extras: Record<string, number>) => fileWith(layers, {
      designs: [{ id: 'a', name: 'A', layers, ...extras }],
    });
    expect(parseDesignFile(withExtras({ opacity: 0.85, glow: 0.3 })).designs[0]).toMatchObject({ opacity: 0.85, glow: 0.3 });
    const plain = parseDesignFile(fileWith(layers)).designs[0]!;
    expect(plain.opacity).toBeUndefined();
    expect(plain.glow).toBeUndefined();
    expect(parseDesignFile(withExtras({ glow: 0 })).designs[0]!.glow).toBe(0);
    expect(() => parseDesignFile(withExtras({ opacity: 0 }))).toThrow(/"opacity" must be above 0/);
    expect(() => parseDesignFile(withExtras({ opacity: 1.5 }))).toThrow(/"opacity" must be above 0/);
    expect(() => parseDesignFile(withExtras({ glow: 2 }))).toThrow(/"glow" must be between 0 and 1/);
  });
});

describe('pattern and star layout', () => {
  it('keeps cells square on the cloth: height in y units is cell times width over height', () => {
    const cells = patternCells([0, 0, 1, 1], 0.2, 0.5, false);
    const a = cells.find((c) => c.column === 0 && c.row === 0)!;
    const b = cells.find((c) => c.column === 1 && c.row === 0)!;
    const c = cells.find((c) => c.column === 0 && c.row === 1)!;
    expect(b.x - a.x).toBeCloseTo(0.2, 12);
    expect(c.y - a.y).toBeCloseTo(0.2 * 0.5, 12);
    // Cell centres are anchored half a cell inside the region's lower-left corner.
    expect(a.x).toBeCloseTo(0.1, 12);
    expect(a.y).toBeCloseTo(0.05, 12);
  });

  it('shifts odd rows by half a cell only for brick patterns, and covers the whole region', () => {
    const plain = patternCells([0, 0, 1, 1], 0.25, 1, false);
    const brick = patternCells([0, 0, 1, 1], 0.25, 1, true);
    const x = (cells: typeof plain, row: number) => cells.find((c) => c.row === row && c.column === 0)!.x;
    expect(x(brick, 0)).toBeCloseTo(x(plain, 0), 12);
    expect(x(brick, 1) - x(plain, 1)).toBeCloseTo(0.125, 12);
    for (const cells of [plain, brick]) {
      // Every point of the region is within half a cell (x) of some cell centre in its own row band.
      const xs = cells.filter((c) => c.row === 1).map((c) => c.x);
      for (let t = 0; t <= 1; t += 0.05) {
        expect(Math.min(...xs.map((v) => Math.abs(v - t)))).toBeLessThanOrEqual(0.125 + 1e-9);
      }
    }
  });

  it('puts a star tip straight up with alternating outer and inner radii', () => {
    const v = starVertices(5, 0.4, 0);
    expect(v).toHaveLength(10);
    expect(v[0]![0]).toBeCloseTo(0, 12);
    expect(v[0]![1]).toBeCloseTo(-1, 12); // canvas y points down, so -1 is up
    v.forEach(([x, y], i) => expect(Math.hypot(x, y)).toBeCloseTo(i % 2 === 0 ? 1 : 0.4, 12));
  });
});

describe('sail construction layout', () => {
  // A sloping foot, curved leech and narrow head: unlike an arbitrary texture rectangle.
  const uv = new Float32Array([
    0, 0, 1, 0.04,
    0, 0.45, 0.65, 0.48,
    0, 1, 0.035, 1,
  ]);
  const aspect = 0.5;

  it('ends all three pockets on the actual interpolated leech, preserving physical lengths', () => {
    const layout = layoutSailConstruction(uv, 2, 3, aspect);
    expect(layout.pockets).toHaveLength(3);
    const heights = construction.pockets.map((p) => p.height);
    const lengths = construction.pockets.map((p) => p.length);
    for (const [i, pocket] of layout.pockets.entries()) {
      const row = heights[i]! * 2;
      const lo = Math.floor(row);
      const t = row - lo;
      const x = uv[lo * 4 + 2]! * (1 - t) + uv[(lo + 1) * 4 + 2]! * t;
      const y = uv[lo * 4 + 3]! * (1 - t) + uv[(lo + 1) * 4 + 3]! * t;
      expect(pocket.end[0]).toBeCloseTo(x);
      expect(pocket.end[1]).toBeCloseTo(y);
      expect(Math.hypot(pocket.end[0] - pocket.start[0], (pocket.end[1] - pocket.start[1]) / aspect)).toBeCloseTo(lengths[i]!);
      expect(pocket.start[0]).toBeLessThan(pocket.end[0]);
    }
  });

  it('anchors reinforcements to the head, tack and clew, with the sleeve inside the narrow head', () => {
    const layout = layoutSailConstruction(uv, 2, 3, aspect);
    expect(layout.corners[0]!.point[1]).toBe(1);
    expect(layout.corners[1]!.point).toEqual([0, 0]);
    expect(layout.corners[2]!.point[0]).toBe(1);
    expect(layout.corners[2]!.point[1]).toBeCloseTo(0.04);
    expect(layout.sleeve.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
    expect(Math.max(...layout.sleeve.map(([x]) => x))).toBeLessThanOrEqual(construction.sleeveWidth);
    expect(layout.outline).toContainEqual([1, uv[3]!]);
  });

  it('shortens pockets to fit a narrow chord instead of crossing the luff', () => {
    const narrow = new Float32Array([0, 0, 0.01, 0, 0, 1, 0.01, 1]);
    const layout = layoutSailConstruction(narrow, 2, 2, aspect);
    for (const pocket of layout.pockets) {
      expect(pocket.start[0]).toBe(0);
      expect(pocket.end[0]).toBeCloseTo(0.01);
      expect(pocket.start[1]).toBeCloseTo(pocket.end[1]);
    }
  });

  it('rejects an incomplete grid or a nonphysical aspect', () => {
    expect(() => layoutSailConstruction(uv, 1, 3, aspect)).toThrow(/UV grid/);
    expect(() => layoutSailConstruction(uv, 2, 4, aspect)).toThrow(/UV grid/);
    expect(() => layoutSailConstruction(uv, 2, 3, 0)).toThrow(/positive physical aspect/);
  });
});
