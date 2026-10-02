/** Paper artwork and hit areas. Pixel dimensions, colours and typography are VISUAL ESTIMATE. */
import { KNOT, type Vec2 } from '../sim/frames';
import { ChartProjection, contains, type PaperRect } from '../nav/chart';
import { NAVIGATION, NAV_BUOYS, bearingLabel, positionLine, type Navigation } from '../nav/navigation';

export const CHART_MAP: PaperRect = { x: 48, y: 148, width: 598, height: 540 };
export type ChartAction =
  | { kind: 'select' | 'identify'; id: number }
  | { kind: 'buoy'; buoyId: string }
  | { kind: 'fix' | 'center' | 'clear' };
export interface ChartButton { rect: PaperRect; action: ChartAction }

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

export function drawChartPage(
  ctx: CanvasRenderingContext2D, nav: Navigation, projection: ChartProjection,
  interactive: boolean, debugPosition: Vec2 | null,
): ChartButton[] {
  const buttons: ChartButton[] = [];
  ctx.fillStyle = '#e9e1c9';
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.strokeStyle = '#ad9c7d';
  ctx.lineWidth = 3;
  ctx.strokeRect(18, 18, ctx.canvas.width - 36, ctx.canvas.height - 36);
  ctx.fillStyle = '#293d42';
  ctx.font = 'bold 35px Georgia, serif';
  ctx.fillText('OPEN WATER · PILOTAGE', 48, 64);
  ctx.font = '23px ui-monospace, monospace';
  ctx.fillText(interactive ? 'PLOTTING · M / Esc: return to sailing' : 'Look down · M: plot · B: sight · click: note', 48, 101);
  ctx.font = '21px ui-monospace, monospace';
  ctx.fillText(`LOG ${(nav.state.loggedSpeed / KNOT).toFixed(1)} kn   RUN ${nav.state.distance.toFixed(0)} m`, 48, 132);

  const map = projection.rect;
  ctx.save();
  ctx.beginPath();
  ctx.rect(map.x, map.y, map.width, map.height);
  ctx.clip();
  ctx.fillStyle = '#dde4dc';
  ctx.fillRect(map.x, map.y, map.width, map.height);
  const topLeft = projection.toWorld({ x: map.x, y: map.y });
  const bottomRight = projection.toWorld({ x: map.x + map.width, y: map.y + map.height });
  const grid = 10 ** Math.floor(Math.log10(projection.span / 3));
  ctx.strokeStyle = '#b9c9bf';
  ctx.lineWidth = 1;
  ctx.font = '17px ui-monospace, monospace';
  ctx.fillStyle = '#60766f';
  for (let x = Math.ceil(topLeft.x / grid) * grid; x < bottomRight.x; x += grid) {
    const p = projection.toPaper({ x, z: 0 });
    ctx.beginPath(); ctx.moveTo(p.x, map.y); ctx.lineTo(p.x, map.y + map.height); ctx.stroke();
    ctx.fillText(`${x}`, p.x + 3, map.y + 19);
  }
  for (let z = Math.ceil(topLeft.z / grid) * grid; z < bottomRight.z; z += grid) {
    const p = projection.toPaper({ x: 0, z });
    ctx.beginPath(); ctx.moveTo(map.x, p.y); ctx.lineTo(map.x + map.width, p.y); ctx.stroke();
    ctx.fillText(`${-z} N`, map.x + 4, p.y - 3);
  }

  for (const note of nav.observations) {
    const line = positionLine(note, nav.state);
    if (!line) continue;
    const selected = nav.selected.has(note.id);
    ctx.strokeStyle = selected ? '#855240' : '#a2937c';
    ctx.lineWidth = selected ? 3 : 1.5;
    ctx.setLineDash([9, 6]);
    const a = projection.toPaper(line.buoy);
    const b = projection.toPaper({ x: line.buoy.x - line.direction.x * projection.span * 3, z: line.buoy.z - line.direction.z * projection.span * 3 });
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.setLineDash([]);

  for (const buoy of NAV_BUOYS) {
    const p = projection.toPaper(buoy);
    ctx.fillStyle = buoy.color;
    ctx.strokeStyle = '#253d40';
    ctx.lineWidth = 2;
    drawTopmark(ctx, buoy.topmark, p.x, p.y, 9);
    ctx.fillStyle = '#263b3d';
    ctx.font = 'bold 24px ui-monospace, monospace';
    ctx.fillText(buoy.name, p.x + 14, p.y - 7);
    if (contains(map, p)) buttons.push({ rect: { x: p.x - 18, y: p.y - 20, width: 65, height: 40 }, action: { kind: 'buoy', buoyId: buoy.name } });
  }

  const dr = projection.toPaper(nav.state);
  ctx.strokeStyle = '#754637';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(dr.x, dr.y, 11, 0, 2 * Math.PI); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(dr.x - 17, dr.y); ctx.lineTo(dr.x + 17, dr.y);
  ctx.moveTo(dr.x, dr.y - 17); ctx.lineTo(dr.x, dr.y + 17); ctx.stroke();
  ctx.fillStyle = '#754637'; ctx.font = 'bold 24px ui-monospace, monospace';
  ctx.fillText('DR', dr.x + 18, dr.y + 25);
  if (debugPosition) {
    const p = projection.toPaper(debugPosition);
    ctx.fillStyle = '#d619c1';
    ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, 2 * Math.PI); ctx.fill();
    ctx.fillText('TRUE (debug)', p.x + 12, p.y);
  }
  // North arrow and a scale bar remain inside the chart, independent of boat heading.
  ctx.strokeStyle = '#293d42'; ctx.fillStyle = '#293d42'; ctx.lineWidth = 3;
  const nx = map.x + map.width - 35;
  ctx.beginPath(); ctx.moveTo(nx, map.y + 72); ctx.lineTo(nx, map.y + 30);
  ctx.lineTo(nx - 7, map.y + 42); ctx.moveTo(nx, map.y + 30); ctx.lineTo(nx + 7, map.y + 42); ctx.stroke();
  ctx.font = 'bold 20px Georgia, serif'; ctx.fillText('N', nx - 7, map.y + 22);
  const bar = map.width / 4;
  ctx.beginPath(); ctx.moveTo(map.x + 20, map.y + map.height - 22); ctx.lineTo(map.x + 20 + bar, map.y + map.height - 22); ctx.stroke();
  ctx.font = '20px ui-monospace, monospace';
  ctx.fillText(`${(projection.span / 4).toFixed(0)} m`, map.x + 20, map.y + map.height - 35);
  ctx.restore();
  ctx.strokeStyle = '#75847c'; ctx.lineWidth = 2; ctx.strokeRect(map.x, map.y, map.width, map.height);

  ctx.fillStyle = '#293d42'; ctx.font = 'bold 24px Georgia, serif';
  ctx.fillText('BEARING NOTES', 678, 136);
  nav.observations.forEach((note, i) => {
    const y = 152 + i * 74;
    const selected = nav.selected.has(note.id);
    ctx.fillStyle = selected ? '#d2c4a2' : '#dfd6bd';
    ctx.fillRect(674, y, 302, 66);
    ctx.strokeStyle = '#596663'; ctx.lineWidth = 2; ctx.strokeRect(685, y + 12, 19, 19);
    if (selected) { ctx.fillStyle = '#855240'; ctx.fillRect(689, y + 16, 11, 11); }
    ctx.fillStyle = '#293d42'; ctx.font = '23px ui-monospace, monospace';
    const age = Math.max(0, nav.state.t - note.t);
    ctx.fillText(`${bearingLabel(note.bearing)}  ${age > NAVIGATION.maxBearingAge ? 'OLD' : `${age.toFixed(0)}s`}`, 718, y + 28);
    ctx.font = '19px ui-monospace, monospace';
    ctx.fillText(`Buoy: ${note.buoyId ?? '?'} · click to cycle`, 685, y + 54);
    buttons.push({ rect: { x: 674, y, width: 302, height: 34 }, action: { kind: 'select', id: note.id } });
    buttons.push({ rect: { x: 674, y: y + 34, width: 302, height: 32 }, action: { kind: 'identify', id: note.id } });
  });
  if (!nav.observations.length) {
    ctx.font = '23px Georgia, serif';
    wrapText(ctx, 'Hold B, aim at a buoy and click to note its bearing. Identify the buoy here.', 680, 187, 285);
  }

  const button = (label: string, y: number, kind: 'fix' | 'center' | 'clear') => {
    const rect = { x: 674, y, width: 302, height: 46 };
    ctx.fillStyle = interactive ? '#c4cfbe' : '#d2d2bc'; ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    ctx.strokeStyle = '#657562'; ctx.lineWidth = 2; ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    ctx.fillStyle = '#293d42'; ctx.font = 'bold 23px Georgia, serif'; ctx.fillText(label, rect.x + 14, rect.y + 30);
    buttons.push({ rect, action: { kind } });
  };
  button(nav.selected.size === 1 ? 'Correct to selected line' : 'Apply two-bearing fix', 535, 'fix');
  button('Centre chart on DR', 591, 'center');
  button('Clear bearing notes', 647, 'clear');
  ctx.fillStyle = '#293d42'; ctx.font = '21px ui-monospace, monospace';
  ctx.fillText('Drag map: pan · wheel: zoom', 48, 721);
  NAV_BUOYS.forEach((buoy, i) => {
    const x = 60 + i * 115;
    ctx.fillStyle = buoy.color; ctx.strokeStyle = '#293d42';
    drawTopmark(ctx, buoy.topmark, x, 754, 8);
    ctx.fillStyle = '#293d42'; ctx.font = 'bold 22px ui-monospace, monospace'; ctx.fillText(buoy.name, x + 19, 762);
  });
  ctx.fillStyle = '#754637'; ctx.font = '21px Georgia, serif';
  wrapText(ctx, nav.message, 48, 794, 923);
  return buttons;
}
