import construction from '../../data/sail-construction.json';
import type { Point } from './sailDesign';

export interface ConstructionRow {
  luff: Point;
  leech: Point;
}

export interface SailConstruction {
  outline: Point[];
  sleeve: Point[];
  seams: [Point, Point][];
  pockets: { start: Point; end: Point }[];
  corners: { point: Point; radius: number }[];
  window: Point[];
}

/** Actual cloth boundary UVs, not a rectangular or triangular approximation. Built once per boat. */
export function layoutSailConstruction(uv: Float32Array, cols: number, rows: number, aspect: number): SailConstruction {
  if (cols < 2 || rows < 2 || uv.length !== cols * rows * 2 || !Number.isFinite(aspect) || aspect <= 0) {
    throw new Error('sail construction needs a UV grid with at least two columns and rows and a positive physical aspect');
  }
  const boundary: ConstructionRow[] = [];
  for (let k = 0; k < rows; k++) {
    const l = k * cols * 2;
    const r = l + (cols - 1) * 2;
    boundary.push({ luff: [uv[l]!, uv[l + 1]!], leech: [uv[r]!, uv[r + 1]!] });
  }
  const at = (c: number, height: number): Point => {
    const row = height * (rows - 1);
    const lo = Math.min(Math.floor(row), rows - 2);
    const t = row - lo;
    const a = boundary[lo]!;
    const b = boundary[lo + 1]!;
    return [
      (a.luff[0] + c * (a.leech[0] - a.luff[0])) * (1 - t) + (b.luff[0] + c * (b.leech[0] - b.luff[0])) * t,
      (a.luff[1] + c * (a.leech[1] - a.luff[1])) * (1 - t) + (b.luff[1] + c * (b.leech[1] - b.luff[1])) * t,
    ];
  };
  const outline = [...boundary.map((r) => r.luff), ...boundary.map((r) => r.leech).reverse()];
  const sleeve = [...boundary.map((r) => r.luff), ...boundary.map((r): Point => {
    const c = Math.min(1, construction.sleeveWidth / Math.max(r.leech[0] - r.luff[0], Number.EPSILON));
    return [r.luff[0] + c * (r.leech[0] - r.luff[0]), r.luff[1] + c * (r.leech[1] - r.luff[1])];
  }).reverse()];
  const head = at(0.3, 1);
  const tack = at(0, 0);
  const clew = at(1, 0);
  const join = construction.panels.joinHeight;
  const seams: [Point, Point][] = [[at(0, join), at(1, join)]];
  for (const c of construction.panels.headFanChords) seams.push([head, at(c, join)]);
  for (const c of construction.panels.clewFanChords) seams.push([clew, at(c, join)]);
  for (const h of construction.panels.clewFanLuffHeights) seams.push([clew, at(0, h)]);
  const pockets = construction.pockets.map((p) => {
    const end = at(1, p.height);
    const luff = at(0, p.height);
    // Physical length in sail-width units, shortened only if the local chord is narrower.
    const chordLength = Math.hypot(end[0] - luff[0], (end[1] - luff[1]) / aspect);
    const c = Math.max(0, 1 - p.length / Math.max(chordLength, Number.EPSILON));
    return { start: at(c, p.height), end };
  });
  return {
    outline, sleeve, seams, pockets,
    window: construction.window.clothCorners.map(([c, h]) => at(c!, h!)),
    corners: [
      { point: head, radius: construction.patchRadii.head },
      { point: tack, radius: construction.patchRadii.tack },
      { point: clew, radius: construction.patchRadii.clew },
    ],
  };
}

/** All distances are in width-scaled pixels, preserving the sail's physical UV aspect. */
export function drawSailConstruction(ctx: CanvasRenderingContext2D, layout: SailConstruction, w: number, h: number): void {
  const x = (p: Point): number => p[0] * w;
  const y = (p: Point): number => (1 - p[1]) * h;
  const polygon = (points: readonly Point[]): void => {
    ctx.beginPath();
    points.forEach((p, i) => i === 0 ? ctx.moveTo(x(p), y(p)) : ctx.lineTo(x(p), y(p)));
    ctx.closePath();
  };
  const line = (a: Point, b: Point): void => {
    ctx.beginPath();
    ctx.moveTo(x(a), y(a));
    ctx.lineTo(x(b), y(b));
    ctx.stroke();
  };
  ctx.save();
  polygon(layout.outline);
  ctx.clip();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1, construction.panels.seamWidth * w);
  // Layered Dacron sectors are centred on real cloth corners and clipped by both adjoining edges.
  for (const corner of layout.corners) {
    for (const scale of [1, 0.72, 0.45]) {
      ctx.beginPath();
      ctx.arc(x(corner.point), y(corner.point), corner.radius * w * scale, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,248,${construction.patchAlpha})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(72,79,77,${construction.panels.seamAlpha})`;
      ctx.stroke();
    }
  }
  ctx.strokeStyle = `rgba(72,79,77,${construction.panels.seamAlpha})`;
  for (const [a, b] of layout.seams) line(a, b);
  ctx.save();
  ctx.translate(ctx.lineWidth, ctx.lineWidth);
  ctx.strokeStyle = `rgba(255,255,248,${construction.panels.seamAlpha * 1.5})`;
  for (const [a, b] of layout.seams) line(a, b);
  ctx.restore();
  polygon(layout.sleeve);
  ctx.fillStyle = `rgba(217,217,205,${construction.sleeveAlpha})`;
  ctx.fill();
  ctx.strokeStyle = `rgba(72,79,77,${construction.panels.seamAlpha * 1.5})`;
  ctx.stroke();
  for (const pocket of layout.pockets) {
    // A rounded pocket body, subtle bright core and bound closure right at the actual leech.
    ctx.lineWidth = construction.pocketWidth * w;
    ctx.strokeStyle = `rgba(78,86,83,${construction.pocketAlpha})`;
    line(pocket.start, pocket.end);
    ctx.lineWidth *= 0.64;
    ctx.strokeStyle = `rgba(255,255,245,${construction.pocketAlpha * 2})`;
    line(pocket.start, pocket.end);
    ctx.beginPath();
    ctx.arc(x(pocket.start), y(pocket.start), construction.pocketWidth * w * 0.28, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(78,86,83,${construction.pocketAlpha})`;
    ctx.fill();
  }
  // Clear only this clipped opening, then replace its printed cloth with genuinely translucent film.
  ctx.save();
  polygon(layout.window);
  ctx.clip();
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = `rgba(201,211,212,${construction.window.opacity})`;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
  polygon(layout.window);
  ctx.lineWidth = construction.window.bindingWidth * w;
  ctx.strokeStyle = 'rgba(236,237,222,0.8)';
  ctx.stroke();
  ctx.lineWidth = Math.max(1, construction.panels.seamWidth * w);
  ctx.strokeStyle = `rgba(72,79,77,${construction.panels.seamAlpha})`;
  ctx.stroke();
  ctx.restore();
}
