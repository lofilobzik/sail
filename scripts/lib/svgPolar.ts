/** Minimal SVG polar plot: boat speed (radius) vs true wind angle, one curve per wind speed. */
export interface PolarCurve {
  label: string;
  points: { twaDeg: number; speedKn: number }[];
}

const COLORS = ['#1f77b4', '#d62728', '#2ca02c', '#9467bd', '#ff7f0e'];

export function polarSvg(curves: PolarCurve[], title: string): string {
  const size = 520;
  const cx = 60;
  const cy = size / 2;
  const radius = size / 2 - 40;
  const maxSpeed = Math.max(1, ...curves.flatMap((c) => c.points.map((p) => p.speedKn)));
  const ringStep = maxSpeed > 4 ? 1 : 0.5;
  const rMax = Math.ceil(maxSpeed / ringStep) * ringStep;
  const toXY = (twaDeg: number, speed: number): [number, number] => {
    const a = (twaDeg * Math.PI) / 180;
    const r = (speed / rMax) * radius;
    return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  };
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" font-family="sans-serif" font-size="11">`);
  parts.push(`<rect width="100%" height="100%" fill="white"/>`);
  parts.push(`<text x="10" y="16" font-size="13">${title}</text>`);
  for (let s = ringStep; s <= rMax + 1e-9; s += ringStep) {
    const r = (s / rMax) * radius;
    parts.push(`<path d="M ${cx} ${cy - r} A ${r} ${r} 0 0 1 ${cx} ${cy + r}" fill="none" stroke="#ddd"/>`);
    parts.push(`<text x="${cx + 3}" y="${cy - r + 12}" fill="#888">${s} kn</text>`);
  }
  for (let a = 0; a <= 180; a += 30) {
    const [x, y] = toXY(a, rMax);
    parts.push(`<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#eee"/>`);
    const [tx, ty] = toXY(a, rMax * 1.06);
    parts.push(`<text x="${tx - 8}" y="${ty + 4}" fill="#888">${a}</text>`);
  }
  curves.forEach((c, i) => {
    const color = COLORS[i % COLORS.length]!;
    const d = c.points.map((p, j) => `${j === 0 ? 'M' : 'L'} ${toXY(p.twaDeg, p.speedKn).join(' ')}`).join(' ');
    parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="2"/>`);
    for (const p of c.points) {
      const [x, y] = toXY(p.twaDeg, p.speedKn);
      parts.push(`<circle cx="${x}" cy="${y}" r="2.5" fill="${color}"/>`);
    }
    parts.push(`<text x="${size - 110}" y="${30 + i * 16}" fill="${color}">${c.label}</text>`);
  });
  parts.push('</svg>');
  return parts.join('\n');
}
