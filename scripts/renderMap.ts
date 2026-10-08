/**
 * Headless top-down map of the bay: samples the shared elevation function (src/sim/terrain.ts) and
 * writes a PNG, with no browser, GPU or image library (the PNG is encoded with node:zlib).
 * North is up (world -z), east is right (+x), the same orientation as the chart.
 *
 * Usage:
 *   npm run map -- [--out polar-out/map.png] [--scale 4] [--bounds=-2800,-2800,2600,2500]
 *                  [--no-labels] [--grid 500]
 * --scale is metres per pixel; --bounds (use "=", values start with "-") is minX,minZ,maxX,maxZ in world metres.
 * Layers: depth-tinted water with 2/5/10 m contours, hill-shaded land, roads, harbour rectangles,
 * shoals, town rings, buoys, landmarks, the departure arrow and names.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import bay from '../data/bay.json';
import buoyData from '../data/buoys.json';
import { LANDMARKS, terrainHeight } from '../src/sim/terrain';
import { createRaster, textWidth, type RGB } from './lib/raster';

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: 'polar-out/map.png' },
    scale: { type: 'string', default: '4' },
    bounds: { type: 'string', default: '-2800,-2800,2600,2500' },
    grid: { type: 'string', default: '500' },
    'no-labels': { type: 'boolean', default: false },
  },
});

const scale = Number(args.scale);
const [minX, minZ, maxX, maxZ] = (args.bounds as string).split(',').map(Number) as [number, number, number, number];
const gridStep = Number(args.grid);
const width = Math.ceil((maxX - minX) / scale);
const height = Math.ceil((maxZ - minZ) / scale);

// --- Canvas -------------------------------------------------------------------------------------

const { setPixel, disc, ring, line, text, save } = createRaster(width, height);

const toPx = (x: number): number => (x - minX) / scale;
const toPy = (z: number): number => (z - minZ) / scale;

function rectOutline(x0: number, z0: number, x1: number, z1: number, c: RGB): void {
  const a = toPx(x0), b = toPy(z0), d = toPx(x1), e = toPy(z1);
  line(a, b, d, b, c); line(d, b, d, e, c); line(d, e, a, e, c); line(a, e, a, b, c);
}

function label(name: string, x: number, z: number, c: RGB, dy = 8): void {
  if (args['no-labels']) return;
  const px = toPx(x), py = toPy(z) + dy;
  const w = textWidth(name, 2);
  for (let yy = -2; yy < 12; yy++) for (let xx = -3; xx < w + 3; xx++) setPixel(Math.round(px - w / 2) + xx, Math.round(py) + yy, [255, 255, 255], 0.55);
  text(name, px, py, c, 2, 'center');
}

// --- Terrain ------------------------------------------------------------------------------------

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));

// Heights are sampled one pixel beyond the image so the hill-shading and contours have neighbours.
const stride = width + 2;
const heights = new Float32Array(stride * (height + 2));
for (let py = -1; py <= height; py++) {
  for (let px = -1; px <= width; px++) {
    heights[(py + 1) * stride + px + 1] = terrainHeight(minX + (px + 0.5) * scale, minZ + (py + 0.5) * scale);
  }
}
const H = (px: number, py: number): number => heights[(py + 1) * stride + px + 1]!;

const DEEP: RGB = [24, 74, 124], MID: RGB = [58, 130, 170], SHALLOW: RGB = [150, 215, 205];
const SAND: RGB = [226, 210, 160], GRASS: RGB = [118, 156, 84], WOOD: RGB = [74, 116, 66];
const ROCK: RGB = [138, 130, 120], PEAK: RGB = [200, 196, 188];
const SUN = (() => { const v = [-0.5, -0.7, 0.5]; const n = Math.hypot(...(v as [number, number, number])); return v.map((q) => q / n) as [number, number, number]; })();

for (let py = 0; py < height; py++) {
  for (let px = 0; px < width; px++) {
    const h = H(px, py);
    let c: RGB;
    if (h <= 0) {
      const d = -h;
      c = d < 5 ? mix(SHALLOW, MID, d / 5) : mix(MID, DEEP, clamp01((d - 5) / 20));
      for (const level of [2, 5, 10]) {
        const crossed = [H(px + 1, py), H(px, py + 1)].some((n) => (n + level > 0) !== (h + level > 0));
        if (crossed) c = mix(c, [255, 255, 255], level === 2 ? 0.7 : 0.35);
      }
    } else {
      c = h < 3 ? SAND : h < 40 ? mix(GRASS, WOOD, clamp01((h - 3) / 37)) : mix(WOOD, ROCK, clamp01((h - 40) / 60));
      if (h > 110) c = mix(c, PEAK, clamp01((h - 110) / 60));
      // Hill-shade from the height gradient (z-exaggerated so low hills still read).
      const gx = (H(px + 1, py) - H(px - 1, py)) / (2 * scale), gz = (H(px, py + 1) - H(px, py - 1)) / (2 * scale);
      const k = 3;
      const nl = Math.hypot(k * gx, k * gz, 1);
      const lit = (-k * gx * SUN[0] - k * gz * SUN[1] + SUN[2]) / nl;
      const shade = 0.72 + 0.5 * lit;
      c = [c[0] * shade, c[1] * shade, c[2] * shade];
      if (h > 0 && Math.min(H(px - 1, py), H(px + 1, py), H(px, py - 1), H(px, py + 1)) <= 0) c = mix(c, [60, 50, 30], 0.5);
    }
    setPixel(px, py, c.map((q) => Math.min(255, Math.max(0, q))) as RGB);
  }
}

// --- Overlays -----------------------------------------------------------------------------------

if (gridStep > 0) {
  for (let x = Math.ceil(minX / gridStep) * gridStep; x <= maxX; x += gridStep) {
    for (let py = 0; py < height; py += 3) setPixel(Math.round(toPx(x)), py, [0, 0, 0], 0.25);
    if (!args['no-labels']) text(String(x), toPx(x) + 3, 3, [40, 40, 40], 2);
  }
  for (let z = Math.ceil(minZ / gridStep) * gridStep; z <= maxZ; z += gridStep) {
    for (let px = 0; px < width; px += 3) setPixel(px, Math.round(toPy(z)), [0, 0, 0], 0.25);
    if (!args['no-labels']) text(String(z), 3, toPy(z) + 3, [40, 40, 40], 2);
  }
}

for (const road of bay.roads) {
  for (let i = 1; i < road.points.length; i++) {
    const a = road.points[i - 1] as [number, number], b = road.points[i] as [number, number];
    line(toPx(a[0]), toPy(a[1]), toPx(b[0]), toPy(b[1]), [120, 100, 80]);
  }
}
for (const r of bay.harbour.reclaimed) rectOutline(r.x0, r.z0, r.x1, r.z1, [200, 60, 40]);
for (const r of bay.harbour.dredged) rectOutline(r.x0, r.z0, r.x1, r.z1, [30, 60, 120]);
for (const p of bay.harbour.pontoons) rectOutline(p.x0, p.z0, p.x1, p.z1, [90, 60, 30]);

for (const s of bay.shoals) {
  ring(toPx(s.x), toPy(s.z), s.radius / scale, [255, 240, 120]);
  label(s.name, s.x, s.z - s.radius - 40, [120, 90, 0]);
}
for (const t of bay.towns) {
  ring(toPx(t.x), toPy(t.z), t.radius / scale, [120, 40, 40], 0.7);
  label(t.name, t.x, t.z + t.radius + 10, [110, 20, 20]);
}
for (const i of bay.islands) label(i.name, i.x, i.z - i.rz - 70, [20, 60, 20]);

for (const l of LANDMARKS) {
  const cx = toPx(l.x), cy = toPy(l.z);
  disc(cx, cy, 3, [255, 255, 255]);
  disc(cx, cy, 2, [200, 40, 40]);
  label(l.name, l.x, l.z, [90, 10, 10], -16);
}
for (const b of buoyData.buoys) {
  const cx = toPx(b.x), cy = toPy(b.z);
  disc(cx, cy, 4, [255, 255, 255]);
  disc(cx, cy, 3, [255, 140, 0]);
  label(b.name, b.x, b.z, [120, 60, 0], 8);
}

// Departure arrow (heading is a compass bearing: 0 north, 90 east).
{
  const d = bay.harbour.departure, a = (d.headingDeg * Math.PI) / 180;
  const x0 = toPx(d.x), y0 = toPy(d.z), x1 = x0 + Math.sin(a) * 22, y1 = y0 - Math.cos(a) * 22;
  line(x0, y0, x1, y1, [255, 255, 0]);
  disc(x0, y0, 3, [255, 255, 0]);
  label('START', d.x - 120, d.z, [60, 60, 0], 14);
}

const out = args.out as string;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, save());
console.log(`wrote ${out} (${width}x${height}, ${scale} m/px, x ${minX}..${maxX}, z ${minZ}..${maxZ})`);
