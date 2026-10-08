/** Tiny software canvas for the headless renderers: pixels, shapes, a bitmap font and a PNG encoder (node:zlib only). */
import { deflateSync } from 'node:zlib';

export type RGB = [number, number, number];

// 3x5 pixel font, rows top to bottom, 3 bits each (MSB = left column).
const FONT: Record<string, number[]> = {
  A: [2, 5, 7, 5, 5], B: [6, 5, 6, 5, 6], C: [3, 4, 4, 4, 3], D: [6, 5, 5, 5, 6], E: [7, 4, 6, 4, 7],
  F: [7, 4, 6, 4, 4], G: [3, 4, 5, 5, 3], H: [5, 5, 7, 5, 5], I: [7, 2, 2, 2, 7], J: [1, 1, 1, 5, 2],
  K: [5, 5, 6, 5, 5], L: [4, 4, 4, 4, 7], M: [5, 7, 7, 5, 5], N: [6, 5, 5, 5, 5], O: [2, 5, 5, 5, 2],
  P: [6, 5, 6, 4, 4], Q: [2, 5, 5, 3, 1], R: [6, 5, 6, 5, 5], S: [3, 4, 2, 1, 6], T: [7, 2, 2, 2, 2],
  U: [5, 5, 5, 5, 7], V: [5, 5, 5, 5, 2], W: [5, 5, 7, 7, 5], X: [5, 5, 2, 5, 5], Y: [5, 5, 2, 2, 2],
  Z: [7, 1, 2, 4, 7], '0': [7, 5, 5, 5, 7], '1': [2, 6, 2, 2, 7], '2': [6, 1, 2, 4, 7], '3': [6, 1, 2, 1, 6],
  '4': [5, 5, 7, 1, 1], '5': [7, 4, 6, 1, 6], '6': [3, 4, 7, 5, 7], '7': [7, 1, 2, 2, 2], '8': [7, 5, 7, 5, 7],
  '9': [7, 5, 7, 1, 6], ':': [0, 2, 0, 2, 0], ',': [0, 0, 0, 2, 4], '(': [1, 2, 2, 2, 1], ')': [4, 2, 2, 2, 4], '?': [6, 1, 2, 0, 2],
  '\u00b7': [0, 0, 2, 0, 0], '\u00b1': [2, 7, 2, 0, 7], '\u00b0': [7, 5, 7, 0, 0], '\u2032': [2, 2, 0, 0, 0], '-': [0, 0, 7, 0, 0], ' ': [0, 0, 0, 0, 0], '.': [0, 0, 0, 0, 2], '/': [1, 1, 2, 4, 4],
};

// Glyphs that need more than three columns (M, N, V, W would otherwise read as each other or as U).
const WIDE: Record<string, string[]> = {
  M: ['10001', '11011', '10101', '10001', '10001'],
  N: ['1001', '1101', '1011', '1001', '1001'],
  V: ['10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10101', '11011', '10001'],
};

function glyph(ch: string): string[] {
  return WIDE[ch] ?? (FONT[ch] ?? FONT[' ']!).map((bits) => bits.toString(2).padStart(3, '0'));
}

export function textWidth(label: string, size: number): number {
  let w = 0;
  for (const ch of label.toUpperCase()) w += (glyph(ch)[0]!.length + 1) * size;
  return w - size;
}

export function createRaster(width: number, height: number) {
  const pixels = new Uint8Array(width * height * 3);
  let clip = { x0: 0, y0: 0, x1: width, y1: height };

  /** Restrict drawing to a rectangle (pixels), or lift the restriction with no argument. */
  function setClip(x?: number, y?: number, w?: number, h?: number): void {
    clip = x === undefined ? { x0: 0, y0: 0, x1: width, y1: height } : { x0: x, y0: y!, x1: x + w!, y1: y! + h! };
  }

  function setPixel(px: number, py: number, c: RGB, alpha = 1): void {
    if (px < clip.x0 || py < clip.y0 || px >= clip.x1 || py >= clip.y1) return;
    const i = (py * width + px) * 3;
    for (let k = 0; k < 3; k++) pixels[i + k] = Math.round(pixels[i + k]! * (1 - alpha) + c[k]! * alpha);
  }

  function disc(cx: number, cy: number, r: number, c: RGB, alpha = 1): void {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) setPixel(x, y, c, alpha);
      }
    }
  }

  function ring(cx: number, cy: number, r: number, c: RGB, alpha = 1): void {
    const steps = Math.max(24, Math.ceil(r * 6));
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      setPixel(Math.round(cx + r * Math.cos(a)), Math.round(cy + r * Math.sin(a)), c, alpha);
    }
  }

  /** A line `thickness` pixels wide; `dash` (on, off in pixels) makes it dashed. */
  function line(x0: number, y0: number, x1: number, y1: number, c: RGB, alpha = 1, thickness = 1, dash?: [number, number]): void {
    const length = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(length));
    for (let i = 0; i <= n; i++) {
      if (dash && (i * length / n) % (dash[0] + dash[1]) >= dash[0]) continue;
      const x = x0 + ((x1 - x0) * i) / n, y = y0 + ((y1 - y0) * i) / n;
      if (thickness <= 1) setPixel(Math.round(x), Math.round(y), c, alpha);
      else disc(x, y, thickness / 2, c, alpha);
    }
  }

  function fillRect(x: number, y: number, w: number, h: number, c: RGB, alpha = 1): void {
    for (let yy = Math.round(y); yy < Math.round(y + h); yy++) for (let xx = Math.round(x); xx < Math.round(x + w); xx++) setPixel(xx, yy, c, alpha);
  }

  /** Even-odd filled polygon. */
  function polygon(points: readonly [number, number][], c: RGB, alpha = 1): void {
    const ys = points.map((p) => p[1]);
    for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
      const xs: number[] = [];
      points.forEach((a, i) => {
        const b = points[(i + 1) % points.length]!;
        if ((a[1] <= y + 0.5) !== (b[1] <= y + 0.5)) xs.push(a[0] + ((y + 0.5 - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      });
      xs.sort((m, n) => m - n);
      for (let i = 0; i + 1 < xs.length; i += 2) for (let x = Math.round(xs[i]!); x < Math.round(xs[i + 1]!); x++) setPixel(x, y, c, alpha);
    }
  }

  function text(label: string, px: number, py: number, c: RGB, size = 2, anchor: 'left' | 'center' | 'right' = 'left'): void {
    const w = textWidth(label, size);
    let x = Math.round(anchor === 'center' ? px - w / 2 : anchor === 'right' ? px - w : px);
    const y = Math.round(py);
    for (const ch of label.toUpperCase()) {
      const rows = glyph(ch);
      rows.forEach((bits, r) => {
        for (let col = 0; col < bits.length; col++) {
          if (bits[col] !== '1') continue;
          for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) setPixel(x + col * size + dx, y + r * size + dy, c);
        }
      });
      x += (rows[0]!.length + 1) * size;
    }
  }

  function save(): Buffer {
    return encodePng(width, height, pixels);
  }

  return { setPixel, setClip, disc, ring, line, fillRect, polygon, text, save };
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePng(w: number, h: number, rgb: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit truecolour
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter: none
    raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0)),
  ]);
}

