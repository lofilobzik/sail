/**
 * The sailor's GPS watch, lower right and always visible: speed over ground in knots on a dinghy
 * racing watch, drawn as one inline SVG (round plastic bezel in the player's colour, black inner
 * ring, decorative buttons, a pale LCD with 7-segment digits, a fabric strap peeking out). Like a
 * real watch it ticks once a second with a smoothed speed, so the decimal does not jitter; an arrow
 * in the screen's corner shows the trend over the last few seconds; the session's best speed sits
 * on the small top row and blinks when a record that had stood a while is beaten. Display only:
 * main.ts feeds it the boat's speed over ground. (No planing cue: the physics has no planing regime.)
 */
import { KNOT } from '../sim/frames';

const SMOOTHING_SECONDS = 1.5; // time constant of the speed behind the digits, s; VISUAL ESTIMATE
const TICK_SECONDS = 1; // the display updates once a second, as GPS watches do
const TREND_TICKS = 3; // the arrow compares now with this many ticks (seconds) ago
const TREND_KN = 0.15; // kn of change over TREND_TICKS that counts as rising or falling; TUNING GUESS
// A new best only flashes if the old one had stood this long (s): while the boat is still picking up
// speed the best rises every tick, and flashing each time would mean nothing.
const RECORD_STOOD_SECONDS = 10;

export type Trend = 'up' | 'down' | 'steady';

/** What the watch shows after a tick. */
export interface WatchFace {
  /** Smoothed speed over ground, kn, rounded to the shown tenth. */
  knots: number;
  trend: Trend;
  /** Best `knots` shown this session. */
  best: number;
  /** This tick beat a best that had stood at least RECORD_STOOD_SECONDS. */
  record: boolean;
}

/** The watch's arithmetic, apart from the page: smoothing, the once-a-second tick, trend and best. */
export class WatchReadout {
  private smoothed = 0;
  private sinceTick = Infinity;
  /** Shown speeds of the last TREND_TICKS + 1 ticks, oldest first. */
  private readonly history: number[] = [];
  private best = 0;
  private bestSince = 0;
  private clock = 0;

  /** Feeds `speed` (m/s over ground) for `dt` s; returns the new face on a tick, else null. */
  step(speed: number, dt: number): WatchFace | null {
    this.clock += dt;
    this.smoothed += (speed - this.smoothed) * (1 - Math.exp(-dt / SMOOTHING_SECONDS));
    this.sinceTick += dt;
    if (this.sinceTick < TICK_SECONDS) return null;
    this.sinceTick = 0;
    const knots = Math.round((this.smoothed / KNOT) * 10) / 10;
    this.history.push(knots);
    if (this.history.length > TREND_TICKS + 1) this.history.shift();
    const change = knots - this.history[0]!;
    const trend: Trend = change >= TREND_KN ? 'up' : change <= -TREND_KN ? 'down' : 'steady';
    let record = false;
    if (knots > this.best) {
      record = this.best > 0 && this.clock - this.bestSince >= RECORD_STOOD_SECONDS;
      this.best = knots;
      this.bestSince = this.clock;
    }
    return { knots, trend, best: this.best, record };
  }
}

/** Bezel colours, picked in the Esc menu (Prefs.watchColour): the plastic and its darker edge. */
export const WATCH_COLOURS = {
  yellow: { name: 'Yellow', bezel: '#f6c813', edge: '#b88f00' },
  blue: { name: 'Blue', bezel: '#2a86e8', edge: '#14569e' },
  green: { name: 'Green', bezel: '#34b562', edge: '#1d7a3e' },
  orange: { name: 'Orange', bezel: '#ff7c1f', edge: '#b9500a' },
  pink: { name: 'Pink', bezel: '#ff62ad', edge: '#bb2f74' },
  white: { name: 'White', bezel: '#f1f0ea', edge: '#a9a79e' },
} as const;
export type WatchColour = keyof typeof WATCH_COLOURS;

const SVG_NS = 'http://www.w3.org/2000/svg';
const ON = '#1d251c'; // a lit LCD segment
const OFF = 'rgba(29,37,28,0.08)'; // an unlit one, faintly visible as on a real LCD

// The segments of a 7-segment digit, a to g, lit for each character.
const DIGIT_SEGMENTS: Record<string, string> = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd',
  '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abfgcd', ' ': '',
};

/** The 7 segment polygons (a..g) of a w x h digit with stroke thickness t, as SVG point lists. */
function segmentPoints(w: number, h: number, t: number): string[] {
  const gap = t * 0.18;
  const x0 = t / 2, x1 = w - t / 2, y0 = t / 2, y1 = h / 2, y2 = h - t / 2, s = t / 2;
  const horizontal = (xa: number, y: number, xb: number) =>
    [[xa, y], [xa + s, y - s], [xb - s, y - s], [xb, y], [xb - s, y + s], [xa + s, y + s]];
  const vertical = (x: number, ya: number, yb: number) =>
    [[x, ya], [x + s, ya + s], [x + s, yb - s], [x, yb], [x - s, yb - s], [x - s, ya + s]];
  return [
    horizontal(x0 + gap, y0, x1 - gap), // a
    vertical(x1, y0 + gap, y1 - gap), // b
    vertical(x1, y1 + gap, y2 - gap), // c
    horizontal(x0 + gap, y2, x1 - gap), // d
    vertical(x0, y1 + gap, y2 - gap), // e
    vertical(x0, y0 + gap, y1 - gap), // f
    horizontal(x0 + gap, y1, x1 - gap), // g
  ].map((p) => p.map(([x, y]) => `${x!.toFixed(2)},${y!.toFixed(2)}`).join(' '));
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  parent?.appendChild(el);
  return el;
}

/** One 7-segment digit at (x, y), slanted a little like a watch display; the result shows a character. */
function digit(parent: Element, x: number, y: number, w: number, h: number, t: number): (c: string) => void {
  const g = svg('g', { transform: `translate(${x} ${y}) skewX(-6)` }, parent);
  const segments = segmentPoints(w, h, t).map((points) => svg('polygon', { points, fill: OFF }, g));
  let shown = '';
  return (c) => {
    if (c === shown) return;
    shown = c;
    const lit = DIGIT_SEGMENTS[c] ?? '';
    segments.forEach((seg, i) => seg.setAttribute('fill', lit.includes('abcdefg'[i]!) ? ON : OFF));
  };
}

// The trend mark in the screen's top-right corner.
const TREND_PATHS: Record<Trend, string> = {
  up: 'M99 65 L103 59 L107 65 Z',
  down: 'M99 59 L103 65 L107 59 Z',
  steady: 'M99 61 H107 V63 H99 Z',
};

const STYLE = `
@keyframes gw-blink{0%,40%,80%{opacity:1}20%,60%{opacity:0.1}}
.gw{position:fixed;right:14px;bottom:6px;width:140px;height:168px;pointer-events:none;user-select:none;z-index:6;
  filter:drop-shadow(0 2px 4px rgba(0,0,0,0.45));}
.gw text{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-weight:700;}
.gw-blink{animation:gw-blink 1.2s steps(1,end);}
`;

export class GpsWatch {
  private readonly readout = new WatchReadout();
  private readonly root: SVGSVGElement;
  private readonly trend: SVGPathElement;
  private readonly best: SVGGElement;
  private readonly speedDigits: ((c: string) => void)[];
  private readonly bestDigits: ((c: string) => void)[];

  constructor(colour: WatchColour) {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);
    // Face centre (70, 84), bezel radius 64; the strap peeks out about 20 units above and below.
    const root = svg('svg', { class: 'gw', viewBox: '0 0 140 168', width: 140, height: 168 });
    this.root = root;
    const defs = svg('defs', {}, root);
    const weave = svg('pattern', { id: 'gw-weave', width: 4, height: 3, patternUnits: 'userSpaceOnUse' }, defs);
    svg('rect', { width: 4, height: 3, fill: '#1c1d1f' }, weave);
    svg('rect', { y: 2, width: 4, height: 1, fill: '#28292c' }, weave);
    const shine = svg('linearGradient', { id: 'gw-shine', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    svg('stop', { offset: 0, 'stop-color': '#fff', 'stop-opacity': 0.45 }, shine);
    svg('stop', { offset: 0.45, 'stop-color': '#fff', 'stop-opacity': 0 }, shine);
    svg('stop', { offset: 1, 'stop-color': '#000', 'stop-opacity': 0.18 }, shine);
    const lcd = svg('linearGradient', { id: 'gw-lcd', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    svg('stop', { offset: 0, 'stop-color': '#d3dcc4' }, lcd);
    svg('stop', { offset: 1, 'stop-color': '#bcc7ab' }, lcd);

    // Black fabric strap peeking out above and below, with stitched edges.
    for (const y of [0, 128]) {
      svg('rect', { x: 44, y, width: 52, height: 40, fill: 'url(#gw-weave)' }, root);
      for (const x of [47.5, 92.5]) {
        svg('line', { x1: x, y1: y, x2: x, y2: y + 40, stroke: '#4a4c50', 'stroke-width': 0.8, 'stroke-dasharray': '2 1.5' }, root);
      }
    }

    // Bezel (the player's colour), plastic shading over it, then the black inner ring.
    svg('circle', { cx: 70, cy: 84, r: 64, style: 'fill:var(--gw-bezel);stroke:var(--gw-edge)', 'stroke-width': 1.5 }, root);
    svg('circle', { cx: 70, cy: 84, r: 63, fill: 'url(#gw-shine)' }, root);
    svg('circle', { cx: 70, cy: 84, r: 54, fill: '#121314', stroke: '#000', 'stroke-width': 1 }, root);

    // Decorative buttons on the bezel: two at the top, one at the bottom, labels reading upright.
    for (const [angle, label] of [[-40, 'MODE'], [40, 'SET'], [180, 'RESET']] as const) {
      const a = (angle * Math.PI) / 180;
      const x = 70 + 59 * Math.sin(a), y = 84 - 59 * Math.cos(a);
      const g = svg('g', { transform: `translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${angle === 180 ? 0 : angle})` }, root);
      svg('ellipse', { rx: 10, ry: 3.8, fill: '#151515', stroke: '#000', 'stroke-width': 0.6 }, g);
      const text = svg('text', { 'font-size': 3.4, fill: '#fff', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'letter-spacing': 0.2 }, g);
      text.textContent = label;
    }

    // The LCD: pale grey-green screen with rounded corners and a thin blue outline.
    svg('rect', { x: 30, y: 54, width: 80, height: 60, rx: 9, fill: 'url(#gw-lcd)', stroke: '#4c7db6', 'stroke-width': 1.4 }, root);

    // Top row: MAX and the session's best in small digits; the trend mark in the corner.
    const best = svg('g', {}, root);
    this.best = best;
    const maxLabel = svg('text', { x: 35, y: 65, 'font-size': 5.4, fill: ON }, best);
    maxLabel.textContent = 'MAX';
    this.bestDigits = [digit(best, 64, 58, 5, 8, 1.3), digit(best, 71, 58, 5, 8, 1.3)];
    svg('rect', { x: 77.4, y: 64.7, width: 1.3, height: 1.3, fill: ON }, best);
    this.bestDigits.push(digit(best, 80, 58, 5, 8, 1.3));
    this.trend = svg('path', { d: TREND_PATHS.steady, fill: ON }, root);
    svg('line', { x1: 34, y1: 71, x2: 106, y2: 71, stroke: ON, 'stroke-opacity': 0.25, 'stroke-width': 0.6 }, root);

    // Main row: big whole knots, a point, a smaller tenth, "kn".
    this.speedDigits = [digit(root, 36, 77, 15, 28, 3.6), digit(root, 54, 77, 15, 28, 3.6)];
    svg('rect', { x: 70.5, y: 102, width: 2.8, height: 2.8, fill: ON }, root);
    this.speedDigits.push(digit(root, 76, 87, 10, 18, 2.6));
    const kn = svg('text', { x: 90, y: 105, 'font-size': 6.5, fill: ON }, root);
    kn.textContent = 'kn';

    this.setColour(colour);
    this.show(0, 0, 'steady');
    best.addEventListener('animationend', () => best.classList.remove('gw-blink'));
    document.body.appendChild(root);
  }

  setColour(colour: WatchColour): void {
    const c = WATCH_COLOURS[colour];
    this.root.style.setProperty('--gw-bezel', c.bezel);
    this.root.style.setProperty('--gw-edge', c.edge);
  }

  /** Once per frame: `speed` over ground, m/s, after `dt` real seconds. */
  update(speed: number, dt: number): void {
    const face = this.readout.step(speed, dt);
    if (!face) return;
    this.show(face.knots, face.best, face.trend);
    if (face.record) this.best.classList.add('gw-blink');
  }

  /** Two whole digits (a blank instead of a leading zero) and a tenth, capped at 99.9. */
  private show(knots: number, best: number, trend: Trend): void {
    const chars = (kn: number) => Math.min(kn, 99.9).toFixed(1).replace('.', '').padStart(3, ' ');
    [...chars(knots)].forEach((c, i) => this.speedDigits[i]!(c));
    [...chars(best)].forEach((c, i) => this.bestDigits[i]!(c));
    this.trend.setAttribute('d', TREND_PATHS[trend]);
  }
}
