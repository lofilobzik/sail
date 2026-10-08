/**
 * Headless render of the in-game paper chart page (src/render/chartPage.ts) with nothing plotted yet:
 * the page the sailor sees on their lap at the start. It draws with a software canvas (no browser) and
 * shares the palette, contour maths and framing with the game (src/nav/chartPrint.ts, ChartProjection).
 * Text uses a plain capitals bitmap font instead of Georgia / monospace; symbols are the game's shapes.
 *
 * Usage:
 *   npm run chart -- [--out polar-out/chart.png] [--zoom 2] [--map-only]
 * --zoom multiplies the 1024x820 page texture; --map-only writes just the map panel.
 * Keep the colours, layout numbers and drawing order in step with chartPage.ts when that changes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import buoyData from '../data/buoys.json';
import { ChartProjection } from '../src/nav/chart';
import { chartColour, contourSegments } from '../src/nav/chartPrint';
import { NAVIGATION, Navigation, bearingLabel } from '../src/nav/navigation';
import { worldToBearing } from '../src/sim/frames';
import { BAY, LANDMARKS, terrainGrid } from '../src/sim/terrain';
import { createRaster, textWidth, type RGB } from './lib/raster';

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: 'polar-out/chart.png' },
    zoom: { type: 'string', default: '2' },
    'map-only': { type: 'boolean', default: false },
  },
});
const zoom = Number(args.zoom);

// chartPage.ts layout (page texture pixels) and inks.
const PAGE = { width: NAVIGATION.visual.chartTextureWidth, height: NAVIGATION.visual.chartTextureHeight };
const MAP = { x: 48, y: 148, width: 598, height: 540 };
const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const PAPER = hex('#e9e1c9'), FRAME = hex('#ad9c7d'), TEXT = hex('#293d42'), PENCIL = hex('#754637'), INK = hex('#263b3d');
const COAST_INK = hex('#6b5636'), DEPTH_INK = hex('#6f9bb3'), NAME_INK = hex('#5d5340'), MAP_PAPER = hex('#dde4dc');
const BORDER = hex('#75847c');
// rgba(140, 112, 70, 0.35) over the land tint, the only place height contours are drawn.
const HEIGHT_INK = chartColour(1).map((c, i) => Math.round(c * 0.65 + [140, 112, 70][i]! * 0.35)) as RGB;

const outW = Math.round((args['map-only'] ? MAP.width : PAGE.width) * zoom);
const outH = Math.round((args['map-only'] ? MAP.height : PAGE.height) * zoom);
const { setPixel, setClip, disc, line, fillRect, polygon, text, save } = createRaster(outW, outH);
// Page coordinates to output pixels (map-only shifts the map panel to the origin).
const ox = args['map-only'] ? MAP.x : 0, oy = args['map-only'] ? MAP.y : 0;
const X = (x: number): number => (x - ox) * zoom;
const Y = (y: number): number => (y - oy) * zoom;
/** Bitmap font size whose capital height matches a CSS font of `px` pixels (cap height about 0.7 em). */
/** Monospace text is narrower than the bitmap font's cell, so it takes a size less. */
const mono = (px: number): number => Math.max(1, fs(px) - 1);
const fs = (px: number): number => Math.max(1, Math.round((px * zoom * 0.7) / 5));
/** Draw text with its baseline at page (x, y), like canvas fillText. */
function label(s: string, x: number, y: number, px: number, c: RGB, anchor: 'left' | 'center' | 'right' = 'left', monospace = false): void {
  const size = monospace ? mono(px) : fs(px);
  text(s, X(x), Y(y) - 5 * size, c, size, anchor);
}
const strokeRect = (x: number, y: number, w: number, h: number, c: RGB, width: number): void => {
  line(X(x), Y(y), X(x + w), Y(y), c, 1, width * zoom); line(X(x + w), Y(y), X(x + w), Y(y + h), c, 1, width * zoom);
  line(X(x + w), Y(y + h), X(x), Y(y + h), c, 1, width * zoom); line(X(x), Y(y + h), X(x), Y(y), c, 1, width * zoom);
};

// --- Page ---------------------------------------------------------------------------------------

const nav = new Navigation();
const plotted = nav.plotted;

// Framing: buoys, both islands and the departure, exactly as drawChartPage frames them.
const projection = new ChartProjection({ x: 0, y: 0, width: MAP.width * zoom, height: MAP.height * zoom });
const framed: { x: number; z: number }[] = [...buoyData.buoys, ...nav.track, plotted];
for (const i of BAY.islands) {
  const r = Math.max(i.rx, i.rz);
  framed.push({ x: i.x - r, z: i.z - r }, { x: i.x + r, z: i.z + r });
}
projection.fit(framed);
const metresToPx = (MAP.width * zoom) / projection.span;
/** World to output pixels. The projection's rect is the map panel at the origin, so shift it onto the page. */
const toOut = (p: { x: number; z: number }): [number, number] => {
  const q = projection.toPaper(p);
  return [q.x + (args['map-only'] ? 0 : MAP.x * zoom), q.y + (args['map-only'] ? 0 : MAP.y * zoom)];
};

if (!args['map-only']) {
  fillRect(0, 0, outW, outH, PAPER);
  strokeRect(18, 18, PAGE.width - 36, PAGE.height - 36, FRAME, 3);
  label('HOLM BAY · PILOTAGE', 48, 64, 35, TEXT);
  label('Look down · R: reckon · F: read', 48, 101, 23, TEXT, 'left', true);
  label(`PLOTTED 0s AGO   DOUBT ±${plotted.radius.toFixed(0)} m`, 48, 132, 21, TEXT, 'left', true);
}

// Map panel: paper, then the printed tint, contours, coastline and grid.
const mx0 = Math.round(args['map-only'] ? 0 : MAP.x * zoom), my0 = Math.round(args['map-only'] ? 0 : MAP.y * zoom);
const mw = Math.round(MAP.width * zoom), mh = Math.round(MAP.height * zoom);
fillRect(mx0, my0, mw, mh, MAP_PAPER);
setClip(mx0, my0, mw, mh);

const grid = terrainGrid();
const bilinear = (wx: number, wz: number): RGB | null => {
  const gx = (wx - grid.minX) / grid.cell, gz = (wz - grid.minZ) / grid.cell;
  if (gx < -0.5 || gz < -0.5 || gx > grid.columns - 0.5 || gz > grid.rows - 0.5) return null;
  const cx = Math.min(Math.max(gx, 0), grid.columns - 1), cz = Math.min(Math.max(gz, 0), grid.rows - 1);
  const c0 = Math.min(Math.floor(cx), grid.columns - 2), r0 = Math.min(Math.floor(cz), grid.rows - 2);
  const fx = cx - c0, fz = cz - r0;
  const at = (c: number, r: number) => chartColour(grid.heights[r * grid.columns + c]!);
  const out: RGB = [0, 0, 0];
  const s = [[at(c0, r0), (1 - fx) * (1 - fz)], [at(c0 + 1, r0), fx * (1 - fz)], [at(c0, r0 + 1), (1 - fx) * fz], [at(c0 + 1, r0 + 1), fx * fz]] as const;
  for (let k = 0; k < 3; k++) out[k] = Math.round(s.reduce((sum, [c, w]) => sum + c[k]! * w, 0));
  return out;
};
for (let py = 0; py < mh; py++) {
  for (let px = 0; px < mw; px++) {
    const w = projection.toWorld({ x: px + 0.5, y: py + 0.5 });
    const c = bilinear(w.x, w.z);
    if (c) setPixel(mx0 + px, my0 + py, c);
  }
}

// Clip the map layers to the panel by drawing into the panel only: segments outside are skipped.
const inPanel = (x: number, y: number): boolean => x >= mx0 - 20 && y >= my0 - 20 && x <= mx0 + mw + 20 && y <= my0 + mh + 20;
function contour(level: number, c: RGB, width: number, dash?: [number, number]): void {
  contourSegments(grid, level, (x0, z0, x1, z1) => {
    const a = toOut({ x: x0, z: z0 }), b = toOut({ x: x1, z: z1 });
    if (inPanel(a[0], a[1]) || inPanel(b[0], b[1])) line(a[0], a[1], b[0], b[1], c, 1, width * zoom, dash && [dash[0] * zoom, dash[1] * zoom]);
  });
}
for (const level of NAVIGATION.visual.chartHeightContours) contour(level, HEIGHT_INK, 1);
NAVIGATION.visual.chartDepthContours.forEach((depth, i) => contour(-depth, DEPTH_INK, i === 0 ? 1.6 : 1, i === 0 ? undefined : [6, 4]));
contour(0, COAST_INK, 2);

const roundDown = (value: number): number => {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const ratio = value / magnitude;
  return (ratio >= 5 ? 5 : ratio >= 2 ? 2 : 1) * magnitude;
};
const gridStep = roundDown(projection.span / 4);
const topLeft = projection.toWorld({ x: 0, y: 0 }), bottomRight = projection.toWorld({ x: mw, y: mh });
for (let x = Math.ceil(topLeft.x / gridStep) * gridStep; x < bottomRight.x; x += gridStep) {
  const px = Math.round(toOut({ x, z: 0 })[0]);
  for (let k = 0; k < zoom; k++) for (let y = my0; y < my0 + mh; y++) setPixel(px + k, y, [120, 150, 140], 0.45);
}
for (let z = Math.ceil(topLeft.z / gridStep) * gridStep; z < bottomRight.z; z += gridStep) {
  const py = Math.round(toOut({ x: 0, z })[1]);
  for (let k = 0; k < zoom; k++) for (let x = mx0; x < mx0 + mw; x++) setPixel(x, py + k, [120, 150, 140], 0.45);
}

// Place names: towns, islands, shoals, `down` page pixels below their anchor.
const names: [string, { x: number; z: number }, number, number][] = [
  ...BAY.towns.map((t): [string, { x: number; z: number }, number, number] => [t.name, t, 20, 6]),
  ...BAY.islands.map((i): [string, { x: number; z: number }, number, number] => [i.name, i, 19, 34]),
  ...BAY.shoals.map((s): [string, { x: number; z: number }, number, number] => [s.name, s, 15, 22]),
];
for (const [name, at, px, down] of names) {
  const [x, y] = toOut(at);
  const size = fs(px);
  if (inPanel(x, y)) text(name, x, y + down * zoom - 5 * size, NAME_INK, size, 'center');
}

// Marks: coloured topmarks for buoys, conventional symbols for landmarks, with bearing and distance.
function topmark(kind: string, x: number, y: number, size: number, fill: RGB): void {
  const lw = 2 * zoom;
  const poly = (pts: [number, number][]): void => {
    polygon(pts, fill);
    pts.forEach((a, i) => { const b = pts[(i + 1) % pts.length]!; line(a[0], a[1], b[0], b[1], INK, 1, lw); });
  };
  if (kind === 'sphere') { disc(x, y, size * 0.7 + lw / 2, INK); disc(x, y, size * 0.7 - lw / 2, fill); }
  else if (kind === 'cylinder') poly([[x - size * 0.6, y - size * 0.7], [x + size * 0.6, y - size * 0.7], [x + size * 0.6, y + size * 0.7], [x - size * 0.6, y + size * 0.7]]);
  else if (kind === 'cross') {
    poly([[x - size * 0.2, y - size], [x + size * 0.2, y - size], [x + size * 0.2, y - size * 0.2], [x + size, y - size * 0.2], [x + size, y + size * 0.2], [x + size * 0.2, y + size * 0.2],
      [x + size * 0.2, y + size], [x - size * 0.2, y + size], [x - size * 0.2, y + size * 0.2], [x - size, y + size * 0.2], [x - size, y - size * 0.2], [x - size * 0.2, y - size * 0.2]]);
  } else {
    poly([[x, y - size], [x + size, y + size * 0.7], [x - size, y + size * 0.7]]);
    if (kind === 'doubleCone') poly([[x, y + size * 2.2], [x - size, y + size * 0.7], [x + size, y + size * 0.7]]);
  }
}
function landmark(kind: string, x: number, y: number, size: number): void {
  const lw = 2 * zoom;
  if (kind === 'lighthouse') {
    disc(x, y, size * 0.35, INK);
    polygon([[x, y], [x + size * 1.6, y - size * 0.9], [x + size * 1.2, y - size * 1.5]], hex('#b33fa0'));
    return;
  }
  if (kind === 'spire') {
    for (let k = 0; k < 40; k++) setPixel(Math.round(x + size * 0.45 * Math.cos(k / 6.4)), Math.round(y + size * 0.45 * Math.sin(k / 6.4)), INK);
    line(x, y - size, x, y - size * 2.2, INK, 1, lw); line(x - size * 0.5, y - size * 1.7, x + size * 0.5, y - size * 1.7, INK, 1, lw);
  } else if (kind === 'tower') {
    const a = x - size * 0.6, b = y - size * 0.6, c = x + size * 0.6, d = y + size * 0.6;
    line(a, b, c, b, INK, 1, lw); line(c, b, c, d, INK, 1, lw); line(c, d, a, d, INK, 1, lw); line(a, d, a, b, INK, 1, lw);
    disc(x, y, size * 0.15 + lw / 2, INK);
  } else {
    disc(x, y, size * 0.3, INK);
    line(x, y, x, y - size * 2.2, INK, 1, lw);
    line(x - size * 0.7, y, x, y - size * 2.2, INK, 1, lw); line(x, y - size * 2.2, x + size * 0.7, y, INK, 1, lw);
  }
}
const marks = [
  ...buoyData.buoys.map((b) => ({ mark: b, draw: (x: number, y: number) => topmark(b.topmark, x, y, 9 * zoom, hex(b.color)) })),
  ...LANDMARKS.map((l) => ({ mark: l, draw: (x: number, y: number) => landmark(l.kind, x, y, 9 * zoom) })),
];
const centre = { x: mx0 + mw / 2, y: my0 + mh / 2 };
for (const { mark, draw } of marks) {
  let [x, y] = toOut(mark);
  const onPaper = x >= mx0 && x <= mx0 + mw && y >= my0 && y <= my0 + mh;
  if (onPaper) draw(x, y);
  else {
    // A landmark beyond the paper is pointed at from the edge, along the line from the paper centre.
    const inset = 30 * zoom;
    const dx = x - centre.x, dy = y - centre.y;
    const t = Math.min((mw / 2 - inset) / Math.abs(dx || 1e-9), (mh / 2 - inset) / Math.abs(dy || 1e-9));
    x = centre.x + dx * t; y = centre.y + dy * t;
    const len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
    line(x - ux * 10 * zoom, y - uy * 10 * zoom, x + ux * 14 * zoom, y + uy * 14 * zoom, INK, 1, 2 * zoom);
    polygon([[x + ux * 20 * zoom, y + uy * 20 * zoom], [x + ux * 10 * zoom - uy * 6 * zoom, y + uy * 10 * zoom + ux * 6 * zoom], [x + ux * 10 * zoom + uy * 6 * zoom, y + uy * 10 * zoom - ux * 6 * zoom]], INK);
  }
  const detail = `${bearingLabel(worldToBearing(mark.x - plotted.x, mark.z - plotted.z))} ${Math.hypot(mark.x - plotted.x, mark.z - plotted.z).toFixed(0)} m`;
  const nearRight = x + 24 * zoom + textWidth(detail, mono(17)) > mx0 + mw;
  const lx = nearRight ? x - 14 * zoom : x + 14 * zoom;
  const lift = y + 20 * zoom > my0 + mh ? -26 * zoom : 0;
  const anchor = nearRight ? 'right' : 'left';
  text(mark.name, lx, y - 7 * zoom + lift - 5 * mono(22), INK, mono(22), anchor);
  text(detail, lx, y + 13 * zoom + lift - 5 * mono(17), INK, mono(17), anchor);
}

// The dead-reckoning position (a pencil dot), north arrow and scale bar.
{
  const [x, y] = toOut(plotted);
  disc(x, y, 6 * zoom, PENCIL);
  const nx = mx0 + mw - 35 * zoom, top = my0 + 42 * zoom;
  line(nx, my0 + 72 * zoom, nx, top, TEXT, 1, 3 * zoom);
  line(nx, top, nx - 7 * zoom, my0 + 54 * zoom, TEXT, 1, 3 * zoom); line(nx, top, nx + 7 * zoom, my0 + 54 * zoom, TEXT, 1, 3 * zoom);
  text('N', nx - 7 * zoom, my0 + 36 * zoom - 5 * fs(20), TEXT, fs(20));
  const bar = roundDown(projection.span / 5);
  const by = my0 + mh - 22 * zoom;
  line(mx0 + 20 * zoom, by, mx0 + 20 * zoom + bar * metresToPx, by, TEXT, 1, 3 * zoom);
  text(`${bar} m`, mx0 + 20 * zoom, my0 + mh - 35 * zoom - 5 * mono(20), TEXT, mono(20));
}
{
  setClip();
  const w = 2 * zoom;
  line(mx0, my0, mx0 + mw, my0, BORDER, 1, w); line(mx0 + mw, my0, mx0 + mw, my0 + mh, BORDER, 1, w);
  line(mx0 + mw, my0 + mh, mx0, my0 + mh, BORDER, 1, w); line(mx0, my0 + mh, mx0, my0, BORDER, 1, w);
}

if (!args['map-only']) {
  // Right column and key with nothing noted yet.
  label('BEARING NOTES', 678, 136, 24, TEXT);
  const hint = 'Hold F steady on a buoy or a landmark ashore: the eye names it.'.split(' ');
  let row = '', y = 180;
  for (const word of hint) {
    if (row && textWidth(`${row} ${word}`, fs(21)) > 285 * zoom) { label(row, 680, y, 21, TEXT); y += 28; row = word; }
    else row += `${row ? ' ' : ''}${word}`;
  }
  label(row, 680, y, 21, TEXT);
  label('REMEMBERED', 678, 470, 24, TEXT);
  label('Course  --  (compass on bow)', 678, 500, 20, TEXT, 'left', true);
  label('Speed   --  (F, look astern)', 678, 528, 20, TEXT, 'left', true);
  let keyX = 56;
  for (const { mark, draw } of marks) {
    draw(X(keyX), Y(724));
    label(mark.name, keyX + 16, 731, 20, INK, 'left', true);
    keyX += 16 + textWidth(mark.name, mono(20)) / zoom + 30;
  }
  const message = nav.message.split(' ');
  row = ''; y = 780;
  for (const word of message) {
    if (row && textWidth(`${row} ${word}`, fs(21)) > 923 * zoom) { label(row, 48, y, 21, PENCIL); y += 28; row = word; }
    else row += `${row ? ' ' : ''}${word}`;
  }
  label(row, 48, y, 21, PENCIL);
}

const out = args.out as string;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, save());
console.log(`wrote ${out} (${outW}x${outH}, span ${projection.span.toFixed(0)} m across the paper, centre ${projection.center.x.toFixed(0)},${projection.center.z.toFixed(0)})`);
