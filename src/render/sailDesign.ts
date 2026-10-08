/**
 * Procedural sail designs (data/sail-designs.json), drawn onto a 2D canvas context.
 * No Three.js and no DOM: the context is passed in, so parsing and layout are testable under Node.
 *
 * Design space: x 0..1 aft of the luff over the widest chord, y 0..1 up the physical luff length.
 * The canvas has the physical aspect of that rectangle, so circles, stars and pattern cells stay
 * true on the cloth; their sizes are fractions of the sail width.
 */
import { drawSailConstruction, type SailConstruction } from './sailConstruction';

export type Point = [number, number];
export interface Wave {
  /** Fraction of the sail height. */
  amplitude: number;
  cycles: number;
}

export type Layer =
  | { type: 'fill'; color: string }
  | { type: 'gradient'; stops: [number, string][]; wave?: Wave }
  | { type: 'polygon'; points: Point[]; color: string; alpha: number }
  | { type: 'stripes'; color: string; bands: [number, number][]; slope: number; wave?: Wave }
  | { type: 'rays'; cx: number; cy: number; count: number; duty: number; rotation: number; color: string }
  | { type: 'star'; cx: number; cy: number; r: number; points: number; inner: number; rotation: number; color: string }
  | { type: 'circle'; cx: number; cy: number; r: number; color: string; alpha: number }
  | {
    type: 'pattern'; shape: 'text' | 'circle' | 'diamond' | 'square'; text: string; colors: string[];
    cell: number; size: number; brick: boolean; rotation: number; region: [number, number, number, number];
  };

export interface SailDesign {
  id: string;
  name: string;
  layers: Layer[];
  /** Cloth opacity above 0 and at most 1; absent means the sail's default translucency. */
  opacity?: number;
  /** Light scattered through the cloth, 0..1: keeps printed colours alive on the shaded side. */
  glow?: number;
}

/** A design without its drawing layers: what the sail needs to apply it. */
export type DesignInfo = Omit<SailDesign, 'layers'>;

export interface Finish {
  grain: number;
  grainAlpha: number;
  seed: number;
}

export interface DesignFile {
  default: string;
  textureWidth: number;
  finish: Finish;
  designs: SailDesign[];
}

// ---- parsing: strict, with errors that name the design and layer being edited ----

type Obj = Record<string, unknown>;
const COLOR = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\))$/;

function fail(where: string, message: string): never {
  throw new Error(`sail-designs.json ${where}: ${message}`);
}

function obj(v: unknown, where: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(where, 'expected an object');
  return v as Obj; // narrowed by the checks above; keys are read through the typed helpers below
}

function num(o: Obj, key: string, where: string, fallback?: number): number {
  const v = o[key];
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(where, `"${key}" must be a number`);
  return v;
}

function str(o: Obj, key: string, where: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v === '') fail(where, `"${key}" must be a non-empty string`);
  return v;
}

function color(o: Obj, key: string, where: string): string {
  const v = str(o, key, where);
  if (!COLOR.test(v)) fail(where, `"${key}" is not a CSS colour (#rgb, #rrggbb or rgba(...)): ${v}`);
  return v;
}

function list(o: Obj, key: string, where: string): unknown[] {
  const v = o[key];
  if (!Array.isArray(v) || v.length === 0) fail(where, `"${key}" must be a non-empty array`);
  return v;
}

function pair(v: unknown, where: string): Point {
  if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    fail(where, 'expected a [number, number] pair');
  }
  return [v[0] as number, v[1] as number];
}

function wave(o: Obj, where: string): Wave | undefined {
  if (o.wave === undefined) return undefined;
  const w = obj(o.wave, `${where}.wave`);
  return { amplitude: num(w, 'amplitude', `${where}.wave`), cycles: num(w, 'cycles', `${where}.wave`) };
}

function parseLayer(raw: unknown, where: string): Layer {
  const o = obj(raw, where);
  const type = str(o, 'type', where);
  switch (type) {
    case 'fill':
      return { type, color: color(o, 'color', where) };
    case 'gradient': {
      const stops = list(o, 'stops', where).map((s, i): [number, string] => {
        const a = Array.isArray(s) ? s : fail(`${where}.stops[${i}]`, 'expected [position, colour]');
        if (typeof a[0] !== 'number' || typeof a[1] !== 'string' || !COLOR.test(a[1])) {
          fail(`${where}.stops[${i}]`, 'expected [position 0..1, CSS colour]');
        }
        return [a[0], a[1]];
      });
      return { type, stops, wave: wave(o, where) };
    }
    case 'polygon': {
      const points = list(o, 'points', where).map((p, i) => pair(p, `${where}.points[${i}]`));
      if (points.length < 3) fail(where, '"points" needs at least 3 points');
      return { type, points, color: color(o, 'color', where), alpha: num(o, 'alpha', where, 1) };
    }
    case 'stripes': {
      const bands = list(o, 'bands', where).map((b, i) => pair(b, `${where}.bands[${i}]`));
      return { type, color: color(o, 'color', where), bands, slope: num(o, 'slope', where, 0), wave: wave(o, where) };
    }
    case 'rays':
      return {
        type, cx: num(o, 'cx', where), cy: num(o, 'cy', where), count: Math.round(num(o, 'count', where)),
        duty: num(o, 'duty', where, 0.5), rotation: num(o, 'rotation', where, 0), color: color(o, 'color', where),
      };
    case 'star':
      return {
        type, cx: num(o, 'cx', where), cy: num(o, 'cy', where), r: num(o, 'r', where),
        points: Math.round(num(o, 'points', where)), inner: num(o, 'inner', where, 0.4),
        rotation: num(o, 'rotation', where, 0), color: color(o, 'color', where),
      };
    case 'circle':
      return {
        type, cx: num(o, 'cx', where), cy: num(o, 'cy', where), r: num(o, 'r', where),
        color: color(o, 'color', where), alpha: num(o, 'alpha', where, 1),
      };
    case 'pattern': {
      const shape = str(o, 'shape', where);
      if (shape !== 'text' && shape !== 'circle' && shape !== 'diamond' && shape !== 'square') {
        fail(where, `"shape" must be text, circle, diamond or square, got ${shape}`);
      }
      const colors = list(o, 'colors', where).map((c, i) => {
        if (typeof c !== 'string' || !COLOR.test(c)) fail(`${where}.colors[${i}]`, 'expected a CSS colour');
        return c;
      });
      const region = o.region === undefined ? [-0.2, -0.2, 1.2, 1.2] : list(o, 'region', where).map((n) => {
        if (typeof n !== 'number' || !Number.isFinite(n)) fail(where, '"region" must be [x0, y0, x1, y1] numbers');
        return n;
      });
      if (region.length !== 4) fail(where, '"region" must be [x0, y0, x1, y1]');
      const cell = num(o, 'cell', where);
      if (cell <= 0.005) fail(where, '"cell" must be a width fraction above 0.005');
      return {
        type, shape, text: shape === 'text' ? str(o, 'text', where) : '', colors, cell,
        size: num(o, 'size', where, 0.6), brick: o.brick === true, rotation: num(o, 'rotation', where, 0),
        region: [region[0]!, region[1]!, region[2]!, region[3]!],
      };
    }
    default:
      return fail(where, `unknown layer type "${type}"`);
  }
}

/** Validate the whole file; the first problem throws with the design id and layer index. */
export function parseDesignFile(raw: unknown): DesignFile {
  const root = obj(raw, 'root');
  const finishRaw = obj(root.finish, 'finish');
  const finish: Finish = {
    grain: Math.round(num(finishRaw, 'grain', 'finish')),
    grainAlpha: num(finishRaw, 'grainAlpha', 'finish'),
    seed: Math.round(num(finishRaw, 'seed', 'finish')),
  };
  const seen = new Set<string>();
  const designs = list(root, 'designs', 'root').map((d, i): SailDesign => {
    const o = obj(d, `designs[${i}]`);
    const id = str(o, 'id', `designs[${i}]`);
    if (seen.has(id)) fail(`designs[${i}]`, `duplicate id "${id}"`);
    seen.add(id);
    const layers = list(o, 'layers', `design "${id}"`).map((l, k) => parseLayer(l, `design "${id}" layer ${k}`));
    const first = layers[0]!;
    if (first.type !== 'fill' && first.type !== 'gradient') {
      fail(`design "${id}" layer 0`, 'the first layer must be a fill or gradient so the whole sail is covered');
    }
    const opacity = num(o, 'opacity', `design "${id}"`, -1);
    if (opacity !== -1 && (opacity <= 0 || opacity > 1)) fail(`design "${id}"`, '"opacity" must be above 0 and at most 1');
    const glow = num(o, 'glow', `design "${id}"`, -1);
    if (glow !== -1 && (glow < 0 || glow > 1)) fail(`design "${id}"`, '"glow" must be between 0 and 1');
    return {
      id, name: str(o, 'name', `design "${id}"`), layers,
      opacity: opacity === -1 ? undefined : opacity,
      glow: glow === -1 ? undefined : glow,
    };
  });
  const def = str(root, 'default', 'root');
  if (!seen.has(def)) fail('root', `"default" ${def} is not a design id`);
  return { default: def, textureWidth: Math.round(num(root, 'textureWidth', 'root')), finish, designs };
}

// ---- layout helpers (pure) ----

export interface PatternCell {
  /** Centre in design space. */
  x: number;
  y: number;
  column: number;
  row: number;
}

/**
 * Pattern cells covering `region`, anchored at its lower-left corner. `cell` is a fraction of the
 * sail width, so a cell is `cell * aspect` tall in y units (aspect = width / height). With `brick`,
 * odd rows shift by half a cell. Cells one step beyond the region are included so clipping is clean.
 */
export function patternCells(
  region: readonly [number, number, number, number], cell: number, aspect: number, brick: boolean,
): PatternCell[] {
  const [x0, y0, x1, y1] = region;
  const cw = cell;
  const ch = cell * aspect;
  const columns = Math.ceil((x1 - x0) / cw) + 1;
  const rows = Math.ceil((y1 - y0) / ch) + 1;
  const cells: PatternCell[] = [];
  for (let row = -1; row < rows; row++) {
    const shift = brick && Math.abs(row) % 2 === 1 ? cw / 2 : 0;
    for (let column = -1; column < columns; column++) {
      cells.push({ x: x0 + (column + 0.5) * cw + shift, y: y0 + (row + 0.5) * ch, column, row });
    }
  }
  return cells;
}

/** Vertices of a star with `points` tips, alternating outer radius 1 and `inner`, tip first at -90 deg + rotation. */
export function starVertices(points: number, inner: number, rotationDeg: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < points * 2; i++) {
    const a = ((rotationDeg - 90) * Math.PI) / 180 + (i * Math.PI) / points;
    const r = i % 2 === 0 ? 1 : inner;
    out.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return out;
}

// ---- drawing ----

const WAVE_SAMPLES = 48;
const GRADIENT_STRIP_PX = 4;
const TEXT_FONT = '"Trebuchet MS", "Helvetica Neue", Arial, sans-serif';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draw one design (and the cloth finish) into a w x h canvas; design y = 1 is the top row. */
export function drawSailDesign(
  ctx: CanvasRenderingContext2D, design: SailDesign, finish: Finish, construction: SailConstruction, w: number, h: number,
): void {
  const px = (x: number): number => x * w;
  const py = (y: number): number => (1 - y) * h;
  const aspect = w / h;
  const wobble = (wv: Wave | undefined, x: number): number => (wv ? wv.amplitude * Math.sin(2 * Math.PI * wv.cycles * x) : 0);

  const polygon = (pts: readonly Point[]): void => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
  };

  for (const layer of design.layers) {
    ctx.save();
    switch (layer.type) {
      case 'fill':
        ctx.fillStyle = layer.color;
        ctx.fillRect(0, 0, w, h);
        break;
      case 'gradient': {
        // Top of the canvas is the head: stop 0 = head, stop 1 = foot.
        const strips = layer.wave ? Math.ceil(w / GRADIENT_STRIP_PX) : 1;
        const stripWidth = w / strips;
        for (let s = 0; s < strips; s++) {
          const shift = layer.wave ? wobble(layer.wave, (s + 0.5) / strips) * h : 0;
          const g = ctx.createLinearGradient(0, shift, 0, h + shift);
          for (const [t, c] of layer.stops) g.addColorStop(Math.min(Math.max(t, 0), 1), c);
          ctx.fillStyle = g;
          ctx.fillRect(s * stripWidth, 0, stripWidth + 1, h);
        }
        break;
      }
      case 'polygon':
        ctx.globalAlpha = layer.alpha;
        ctx.fillStyle = layer.color;
        polygon(layer.points.map(([x, y]): Point => [px(x), py(y)]));
        ctx.fill();
        break;
      case 'stripes': {
        ctx.fillStyle = layer.color;
        const edge = (x: number): number => layer.slope * x + wobble(layer.wave, x);
        for (const [y0, y1] of layer.bands) {
          const top: Point[] = [];
          const bottom: Point[] = [];
          for (let i = 0; i <= WAVE_SAMPLES; i++) {
            const x = -0.1 + (1.2 * i) / WAVE_SAMPLES;
            top.push([px(x), py(y1 + edge(x))]);
            bottom.push([px(x), py(y0 + edge(x))]);
          }
          polygon([...top, ...bottom.reverse()]);
          ctx.fill();
        }
        break;
      }
      case 'rays': {
        ctx.fillStyle = layer.color;
        const step = (2 * Math.PI) / layer.count;
        const reach = Math.hypot(w, h) * 1.5;
        const cx = px(layer.cx);
        const cy = py(layer.cy);
        for (let i = 0; i < layer.count; i++) {
          const a0 = (layer.rotation * Math.PI) / 180 + i * step;
          const a1 = a0 + step * layer.duty;
          polygon([
            [cx, cy],
            [cx + Math.cos(a0) * reach, cy - Math.sin(a0) * reach],
            [cx + Math.cos(a1) * reach, cy - Math.sin(a1) * reach],
          ]);
          ctx.fill();
        }
        break;
      }
      case 'star': {
        ctx.fillStyle = layer.color;
        const radius = layer.r * w;
        polygon(starVertices(layer.points, layer.inner, layer.rotation).map(([x, y]): Point => [px(layer.cx) + x * radius, py(layer.cy) + y * radius]));
        ctx.fill();
        break;
      }
      case 'circle':
        ctx.globalAlpha = layer.alpha;
        ctx.fillStyle = layer.color;
        ctx.beginPath();
        ctx.arc(px(layer.cx), py(layer.cy), layer.r * w, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'pattern': {
        const [rx0, ry0, rx1, ry1] = layer.region;
        ctx.beginPath();
        ctx.rect(px(rx0), py(ry1), px(rx1) - px(rx0), py(ry0) - py(ry1));
        ctx.clip();
        const cellPx = layer.cell * w;
        const extent = layer.size * cellPx;
        if (layer.shape === 'text') {
          ctx.font = `bold ${extent}px ${TEXT_FONT}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
        }
        for (const c of patternCells(layer.region, layer.cell, aspect, layer.brick)) {
          ctx.fillStyle = layer.colors[Math.abs(c.column + c.row) % layer.colors.length]!;
          ctx.save();
          ctx.translate(px(c.x), py(c.y));
          ctx.rotate((layer.rotation * Math.PI) / 180);
          if (layer.shape === 'text') {
            ctx.fillText(layer.text, 0, 0);
          } else if (layer.shape === 'circle') {
            ctx.beginPath();
            ctx.arc(0, 0, extent / 2, 0, Math.PI * 2);
            ctx.fill();
          } else if (layer.shape === 'diamond') {
            polygon([[0, -extent / 2], [extent / 2, 0], [0, extent / 2], [-extent / 2, 0]]);
            ctx.fill();
          } else {
            ctx.fillRect(-extent / 2, -extent / 2, extent, extent);
          }
          ctx.restore();
        }
        break;
      }
    }
    ctx.restore();
  }

  drawFinish(ctx, finish, w, h);
  drawSailConstruction(ctx, construction, w, h);
}

/** Sparse seeded speckle retains the cloth weave on every procedural design. */
function drawFinish(ctx: CanvasRenderingContext2D, f: Finish, w: number, h: number): void {
  ctx.save();
  const rng = mulberry32(f.seed);
  for (const style of [`rgba(0,0,0,${f.grainAlpha})`, `rgba(255,255,255,${f.grainAlpha})`]) {
    ctx.fillStyle = style;
    ctx.beginPath();
    for (let i = 0; i < f.grain / 2; i++) {
      const s = rng() < 0.2 ? 2 : 1;
      ctx.rect(rng() * w, rng() * h, s, s);
    }
    ctx.fill();
  }
  ctx.restore();
}
