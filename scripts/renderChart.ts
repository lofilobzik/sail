/// <reference types="node" />
/**
 * Export the actual in-game paper chart with a native Canvas2D backend, without a browser.
 * Usage: npm run chart -- [--out polar-out/chart.png] [--zoom 2] [--map-only]
 * The default is the game's native chart texture size. Fonts come from the host system.
 */
import { createCanvas, Path2D } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { ChartProjection } from '../src/nav/chart';
import { NAVIGATION, Navigation } from '../src/nav/navigation';
import { CHART_MAP, drawChartPage } from '../src/render/chartPage';

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: 'polar-out/chart.png' },
    zoom: { type: 'string', default: '1' },
    'map-only': { type: 'boolean', default: false },
  },
});
const zoom = Number(args.zoom);
if (!Number.isFinite(zoom) || zoom <= 0) throw new Error('--zoom must be a positive finite number');

// chartLand uses just these browser canvas primitives; all drawing stays in the game renderer.
Object.assign(globalThis, {
  Path2D,
  document: {
    createElement(tag: string) {
      if (tag !== 'canvas') throw new Error(`Unsupported chart element: ${tag}`);
      return createCanvas(1, 1);
    },
  },
});

const page = createCanvas(NAVIGATION.visual.chartTextureWidth, NAVIGATION.visual.chartTextureHeight);
const nav = new Navigation();
const projection = new ChartProjection(CHART_MAP);
drawChartPage(page.getContext('2d') as unknown as CanvasRenderingContext2D, nav, projection, null);

// Crop/resize only after painting, so ctx.canvas dimensions and every layout/font match the game.
const rect = args['map-only'] ? CHART_MAP : { x: 0, y: 0, width: page.width, height: page.height };
const width = Math.round(rect.width * zoom);
const height = Math.round(rect.height * zoom);
if (width < 1 || height < 1) throw new Error('--zoom produces an empty image');
const output = !args['map-only'] && zoom === 1 ? page : createCanvas(width, height);
if (output !== page) output.getContext('2d').drawImage(page, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height);

mkdirSync(dirname(args.out), { recursive: true });
writeFileSync(args.out, output.toBuffer('image/png'));
console.log(`wrote ${args.out} (${width}x${height}, span ${projection.span.toFixed(0)} m across the paper, centre ${projection.center.x.toFixed(0)},${projection.center.z.toFixed(0)})`);
