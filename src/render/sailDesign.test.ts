import { describe, expect, it } from 'vitest';
import designFile from '../../data/sail-designs.json';
import { drawSailDesign, parseDesignFile, patternCells, starVertices } from './sailDesign';

/** Minimal valid file with one design whose layers are replaced per test. */
function fileWith(layers: unknown[], extra: Record<string, unknown> = {}): unknown {
  return {
    default: 'a',
    textureWidth: 64,
    finish: { seams: 0, seamAlpha: 0, seamSlope: 0, grain: 0, grainAlpha: 0, seed: 1 },
    designs: [{ id: 'a', name: 'A', layers }],
    ...extra,
  };
}

/** Canvas context stand-in that records method calls; properties are plain settable values. */
function recordingContext(): { ctx: CanvasRenderingContext2D; calls: string[] } {
  const calls: string[] = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(state, {
    get: (target, prop: string) => {
      if (prop in target) return target[prop];
      return (...args: unknown[]) => {
        calls.push(prop);
        // createLinearGradient returns an object with addColorStop.
        return prop === 'createLinearGradient' ? { addColorStop: () => undefined } : args[0];
      };
    },
    set: (target, prop: string, value) => {
      target[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D; // test double for the DOM context; only drawing calls are recorded
  return { ctx, calls };
}

describe('sail designs file', () => {
  const file = parseDesignFile(designFile);

  it('parses, has unique ids, and the default exists', () => {
    const ids = file.designs.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(file.default);
    expect(ids.length).toBeGreaterThanOrEqual(10); // white default plus the nine printed designs
  });

  it('draws every design without error, filling the sail first and putting ink on it', () => {
    for (const design of file.designs) {
      const { ctx, calls } = recordingContext();
      drawSailDesign(ctx, design, file.finish, 192, 360);
      expect(calls.length, design.id).toBeGreaterThan(3);
      expect(calls.some((c) => c === 'fillRect' || c === 'createLinearGradient'), design.id).toBe(true);
    }
  });
});

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

  it('fills in documented defaults for optional numbers', () => {
    const parsed = parseDesignFile(fileWith([
      { type: 'fill', color: '#fff' },
      { type: 'pattern', shape: 'circle', colors: ['#000'], cell: 0.1 },
      { type: 'stripes', color: '#000', bands: [[0.1, 0.2]] },
    ]));
    const [, pattern, stripes] = parsed.designs[0]!.layers;
    expect(pattern).toMatchObject({ size: 0.6, brick: false, rotation: 0, region: [-0.2, -0.2, 1.2, 1.2] });
    expect(stripes).toMatchObject({ slope: 0 });
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
