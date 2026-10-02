/** Paper artwork. Pixel dimensions, colours and typography are VISUAL ESTIMATE. */
import { KNOT, bearingToWorld, worldToBearing, type Vec2 } from '../sim/frames';
import type { ChartProjection, PaperRect } from '../nav/chart';
import { NAVIGATION, NAV_BUOYS, bearingLabel, lineIntersection, positionLine, type Navigation, type PositionLine } from '../nav/navigation';

export const CHART_MAP: PaperRect = { x: 48, y: 148, width: 598, height: 540 };
const PENCIL = '#754637';

export function drawTopmark(ctx: CanvasRenderingContext2D, mark: string, x: number, y: number, size: number): void {
  ctx.beginPath();
  if (mark === 'sphere') ctx.arc(x, y, size * 0.7, 0, 2 * Math.PI);
  else if (mark === 'cylinder') ctx.rect(x - size * 0.6, y - size * 0.7, size * 1.2, size * 1.4);
  else if (mark === 'cross') {
    ctx.rect(x - size * 0.2, y - size, size * 0.4, size * 2);
    ctx.rect(x - size, y - size * 0.2, size * 2, size * 0.4);
  } else {
    ctx.moveTo(x, y - size);
    ctx.lineTo(x + size, y + size * 0.7);
    ctx.lineTo(x - size, y + size * 0.7);
    ctx.closePath();
    if (mark === 'doubleCone') {
      ctx.moveTo(x, y + size * 2.2);
      ctx.lineTo(x - size, y + size * 0.7);
      ctx.lineTo(x + size, y + size * 0.7);
      ctx.closePath();
    }
  }
  ctx.fill();
  ctx.stroke();
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, width: number): void {
  let line = '';
  for (const word of text.split(' ')) {
    if (line && ctx.measureText(`${line} ${word}`).width > width) {
      ctx.fillText(line, x, y);
      y += 28;
      line = word;
    } else line += `${line ? ' ' : ''}${word}`;
  }
  ctx.fillText(line, x, y);
}

/** 1-2-5 ladder: the largest round number not above `value`. */
function roundDown(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const ratio = value / magnitude;
  return (ratio >= 5 ? 5 : ratio >= 2 ? 2 : 1) * magnitude;
}

function age(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return s < 90 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

export function drawChartPage(
  ctx: CanvasRenderingContext2D, nav: Navigation, projection: ChartProjection, debugPosition: Vec2 | null,
): void {
  const map = projection.rect;
  const plotted = nav.plotted;
  const course = nav.course ? bearingToWorld(nav.course.value) : null;
  const speed = nav.speed?.value ?? 0;
  const ticks = NAVIGATION.visual.courseTickMinutes;
  // The course line runs to the last tick when the speed is known, otherwise a fixed fraction of the paper.
  const tipTicks = course && speed > 0 ? ticks : [];
  const reach = (minutes: number) => speed * 60 * minutes;

  const framed: Vec2[] = [...NAV_BUOYS, ...nav.track, plotted];
  if (course && tipTicks.length) {
    const near = reach(ticks[1] ?? ticks[0]!);
    framed.push({ x: plotted.x + course.x * near, z: plotted.z + course.z * near });
  }
  projection.fit(framed);

  ctx.fillStyle = '#e9e1c9';
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.strokeStyle = '#ad9c7d';
  ctx.lineWidth = 3;
  ctx.strokeRect(18, 18, ctx.canvas.width - 36, ctx.canvas.height - 36);
  ctx.fillStyle = '#293d42';
  ctx.font = 'bold 35px Georgia, serif';
  ctx.fillText('OPEN WATER · PILOTAGE', 48, 64);
  ctx.font = '23px ui-monospace, monospace';
  ctx.fillText('Look down · R: reckon · F: read', 48, 101);
  ctx.font = '21px ui-monospace, monospace';
  const plottedAge = Math.max(0, nav.t - plotted.t);
  ctx.fillText(`PLOTTED ${age(plottedAge)} AGO   DOUBT ±${plotted.radius.toFixed(0)} m`, 48, 132);

  ctx.save();
  ctx.beginPath();
  ctx.rect(map.x, map.y, map.width, map.height);
  ctx.clip();
  ctx.fillStyle = '#dde4dc';
  ctx.fillRect(map.x, map.y, map.width, map.height);
  const topLeft = projection.toWorld({ x: map.x, y: map.y });
  const bottomRight = projection.toWorld({ x: map.x + map.width, y: map.y + map.height });
  const grid = roundDown(projection.span / 4);
  ctx.strokeStyle = '#b9c9bf';
  ctx.lineWidth = 1;
  ctx.font = '17px ui-monospace, monospace';
  ctx.fillStyle = '#60766f';
  for (let x = Math.ceil(topLeft.x / grid) * grid; x < bottomRight.x; x += grid) {
    const p = projection.toPaper({ x, z: 0 });
    ctx.beginPath(); ctx.moveTo(p.x, map.y); ctx.lineTo(p.x, map.y + map.height); ctx.stroke();
  }
  for (let z = Math.ceil(topLeft.z / grid) * grid; z < bottomRight.z; z += grid) {
    const p = projection.toPaper({ x: 0, z });
    ctx.beginPath(); ctx.moveTo(map.x, p.y); ctx.lineTo(map.x + map.width, p.y); ctx.stroke();
  }

  // Pencil lines of position from each named bearing; the ones the next plot will use are darker.
  const candidates = nav.candidateNotes();
  const carry = nav.carry;
  const used: PositionLine[] = [];
  for (const note of nav.observations) {
    const line = positionLine(note, carry);
    if (!line) continue;
    if (!candidates.includes(note)) continue; // lines already plotted or too old are rubbed out
    used.push(line);
    ctx.strokeStyle = '#855240';
    ctx.lineWidth = 3;
    ctx.setLineDash([9, 6]);
    const a = projection.toPaper(line.buoy);
    const b = projection.toPaper({ x: line.buoy.x - line.direction.x * projection.span * 3, z: line.buoy.z - line.direction.z * projection.span * 3 });
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.setLineDash([]);
    // The bearing is written along the ruled line, a little way out from its buoy.
    const label = projection.toPaper({ x: line.buoy.x - line.direction.x * projection.span * 0.2, z: line.buoy.z - line.direction.z * projection.span * 0.2 });
    ctx.fillStyle = '#855240';
    ctx.font = '19px ui-monospace, monospace';
    ctx.fillText(bearingLabel(note.bearing), label.x + 6, label.y - 6);
  }
  const crossing = used.length === 2 ? lineIntersection(used[0]!, used[1]!) : null;
  if (crossing) {
    const x = projection.toPaper(crossing);
    ctx.strokeStyle = '#855240'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x.x - 9, x.y - 9); ctx.lineTo(x.x + 9, x.y + 9); ctx.moveTo(x.x + 9, x.y - 9); ctx.lineTo(x.x - 9, x.y + 9); ctx.stroke();
  }

  // The track: every position pencilled so far, joined, with the time each was plotted.
  ctx.strokeStyle = PENCIL; ctx.fillStyle = PENCIL; ctx.lineWidth = 2.5;
  ctx.beginPath();
  nav.track.forEach((fix, i) => {
    const p = projection.toPaper(fix);
    if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
  });
  ctx.stroke();
  for (const fix of nav.track) {
    const p = projection.toPaper(fix);
    ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, 2 * Math.PI); ctx.fill();
  }

  const dr = projection.toPaper(plotted);
  if (course) {
    // Course ahead of the marker: a pencil line with ticks at the minutes the sailor would reach them.
    const stale = nav.speedStale;
    const dx = course.x, dy = course.z; // world +z is down the paper
    const length = tipTicks.length ? reach(Math.max(...ticks)) * map.width / projection.span : map.width * 0.2;
    ctx.strokeStyle = PENCIL; ctx.fillStyle = PENCIL; ctx.lineWidth = 2;
    ctx.globalAlpha = stale ? 0.45 : 1;
    ctx.setLineDash([10, 7]);
    ctx.beginPath(); ctx.moveTo(dr.x, dr.y); ctx.lineTo(dr.x + dx * length, dr.y + dy * length); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '17px ui-monospace, monospace';
    for (const minutes of tipTicks) {
      const d = reach(minutes) * map.width / projection.span;
      const tx = dr.x + dx * d, ty = dr.y + dy * d;
      ctx.beginPath(); ctx.moveTo(tx - dy * 7, ty + dx * 7); ctx.lineTo(tx + dy * 7, ty - dx * 7); ctx.stroke();
      ctx.fillText(`${minutes}′`, tx + 8, ty + 18);
    }
    ctx.globalAlpha = 1;
    // The little triangle: where the bow is taking us, from the last bow reading.
    const tipX = dr.x + dx * 40, tipY = dr.y + dy * 40;
    ctx.fillStyle = PENCIL;
    ctx.beginPath();
    ctx.moveTo(tipX + dx * 4, tipY + dy * 4);
    ctx.lineTo(tipX - dx * 14 - dy * 9, tipY - dy * 14 + dx * 9);
    ctx.lineTo(tipX - dx * 14 + dy * 9, tipY - dy * 14 - dx * 9);
    ctx.closePath();
    ctx.fill();
  }

  for (const buoy of NAV_BUOYS) {
    const p = projection.toPaper(buoy);
    ctx.fillStyle = buoy.color;
    ctx.strokeStyle = '#253d40';
    ctx.lineWidth = 2;
    drawTopmark(ctx, buoy.topmark, p.x, p.y, 9);
    // What to steer for, from the last plotted position (it goes stale as the boat sails on).
    const dxw = buoy.x - plotted.x, dzw = buoy.z - plotted.z;
    const distance = Math.hypot(dxw, dzw);
    const detail = `${bearingLabel(worldToBearing(dxw, dzw))} ${distance.toFixed(0)} m`;
    ctx.font = '17px ui-monospace, monospace';
    const nearRight = p.x + 24 + ctx.measureText(detail).width > map.x + map.width;
    const x = nearRight ? p.x - 14 : p.x + 14;
    ctx.textAlign = nearRight ? 'right' : 'left';
    ctx.fillStyle = '#263b3d';
    ctx.font = 'bold 24px ui-monospace, monospace';
    ctx.fillText(buoy.name, x, p.y - 7);
    ctx.font = '17px ui-monospace, monospace';
    ctx.fillText(detail, x, p.y + 13);
    ctx.textAlign = 'left';
  }

  // The dead-reckoning position is a simple pencil dot.
  ctx.fillStyle = PENCIL;
  ctx.beginPath(); ctx.arc(dr.x, dr.y, 6, 0, 2 * Math.PI); ctx.fill();
  if (debugPosition) {
    const p = projection.toPaper(debugPosition);
    ctx.fillStyle = '#d619c1';
    ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, 2 * Math.PI); ctx.fill();
    ctx.fillText('TRUE (debug)', p.x + 12, p.y);
  }
  // North arrow and a round-number scale bar stay inside the chart, independent of boat heading.
  ctx.strokeStyle = '#293d42'; ctx.fillStyle = '#293d42'; ctx.lineWidth = 3;
  const nx = map.x + map.width - 35;
  ctx.beginPath(); ctx.moveTo(nx, map.y + 72); ctx.lineTo(nx, map.y + 42);
  ctx.lineTo(nx - 7, map.y + 54); ctx.moveTo(nx, map.y + 42); ctx.lineTo(nx + 7, map.y + 54); ctx.stroke();
  ctx.font = 'bold 20px Georgia, serif'; ctx.fillText('N', nx - 7, map.y + 36);
  const bar = roundDown(projection.span / 5);
  const barPixels = bar * map.width / projection.span;
  ctx.beginPath(); ctx.moveTo(map.x + 20, map.y + map.height - 22); ctx.lineTo(map.x + 20 + barPixels, map.y + map.height - 22); ctx.stroke();
  ctx.font = '20px ui-monospace, monospace';
  ctx.fillText(`${bar} m`, map.x + 20, map.y + map.height - 35);
  ctx.restore();
  ctx.strokeStyle = '#75847c'; ctx.lineWidth = 2; ctx.strokeRect(map.x, map.y, map.width, map.height);

  // Right column: bearing notes (read-only), remembered course and speed, and the keys.
  ctx.fillStyle = '#293d42'; ctx.font = 'bold 24px Georgia, serif';
  ctx.fillText('BEARING NOTES', 678, 136);
  nav.observations.forEach((note, i) => {
    const y = 152 + i * 58;
    const next = candidates.includes(note);
    ctx.fillStyle = next ? '#d2c4a2' : '#dfd6bd';
    ctx.fillRect(674, y, 302, 52);
    const noteAge = Math.max(0, nav.t - note.t);
    ctx.fillStyle = '#293d42'; ctx.font = '22px ui-monospace, monospace';
    ctx.fillText(`${note.buoyId ?? '?'}  ${bearingLabel(note.bearing)}  ${age(noteAge)}`, 686, y + 24);
    ctx.font = '17px ui-monospace, monospace';
    const state = next ? 'next reckoning (R)'
      : note.t <= plotted.t ? 'already plotted'
        : noteAge > NAVIGATION.maxBearingAge ? 'too old'
          : !note.buoyId ? 'no buoy in view' : '';
    ctx.fillText(state, 686, y + 44);
  });
  if (!nav.observations.length) {
    ctx.font = '21px Georgia, serif';
    wrapText(ctx, 'Hold F steady on a buoy: its painted ID names it.', 680, 180, 285);
  }

  ctx.fillStyle = '#293d42'; ctx.font = 'bold 24px Georgia, serif';
  ctx.fillText('REMEMBERED', 678, 470);
  ctx.font = '20px ui-monospace, monospace';
  ctx.fillText(nav.course ? `Course ${bearingLabel(nav.course.value)} ${age(nav.t - nav.course.t)}` : 'Course  --  (compass on bow)', 678, 500);
  ctx.fillText(nav.speed ? `Speed ${(nav.speed.value / KNOT).toFixed(1)} kn ${age(nav.t - nav.speed.t)}${nav.speedStale ? ' OLD' : ''}` : 'Speed   --  (F, look astern)', 678, 528);
  if (nav.speedStale) {
    ctx.fillStyle = PENCIL; ctx.font = '19px Georgia, serif';
    ctx.fillText('Speed is old: read the wake again.', 678, 556);
  }

  if (nav.plotting) {
    const cx = 944, cy = 80, r = 24;
    ctx.strokeStyle = '#c0b79a'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.stroke();
    ctx.strokeStyle = PENCIL;
    ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * nav.progress); ctx.stroke();
    ctx.fillStyle = PENCIL; ctx.font = '17px ui-monospace, monospace'; ctx.textAlign = 'center';
    ctx.fillText(nav.plotting === 'leg' ? 'DR LEG' : 'FIX', cx, cy + 46);
    ctx.textAlign = 'left';
  }

  NAV_BUOYS.forEach((buoy, i) => {
    const x = 60 + i * 115;
    ctx.fillStyle = buoy.color; ctx.strokeStyle = '#293d42';
    drawTopmark(ctx, buoy.topmark, x, 724, 8);
    ctx.fillStyle = '#293d42'; ctx.font = 'bold 22px ui-monospace, monospace'; ctx.fillText(buoy.name, x + 19, 732);
  });
  ctx.fillStyle = PENCIL; ctx.font = '21px Georgia, serif';
  wrapText(ctx, nav.message, 48, 780, 923);
}
