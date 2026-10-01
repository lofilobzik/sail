/**
 * Test instrument HUD (milestone 3): a DOM overlay separate from the debug overlay,
 * toggled with H. Large readouts for use while sailing. Reads sim state only.
 * Side letters: S = starboard, P = port (angles from the bow; heel: rail down; leeway:
 * sliding toward; tiller: tiller toward).
 */
import { DEG, KNOT, wrap2Pi, worldToBody, type BoatModel, type BoatState, type Diagnostics } from '../sim';
import { isTypingTarget } from '../input/controls';

const UPDATE_INTERVAL_MS = 100; // readouts refresh at 10 Hz so digits stay readable

const TILE_LABELS = {
  hdg: 'HEADING',
  spd: 'BOAT SPEED',
  vmg: 'VMG UPWIND',
  awa: 'APP WIND',
  twa: 'TRUE WIND',
  heel: 'HEEL',
  lee: 'LEEWAY',
  tiller: 'TILLER',
  sheet: 'SHEET',
  luff: 'LUFF / STALL',
} as const;
type TileKey = keyof typeof TILE_LABELS;

interface Tile {
  value: HTMLElement;
  sub: HTMLElement;
}

export interface FrameStats {
  /** Smoothed time between frames, ms (vsync-limited). */
  frameMs: number;
  /** Smoothed main-thread time spent in the frame callback (sim + render submit), ms. */
  cpuMs: number;
  triangles: number;
  calls: number;
}

const deg = (rad: number, digits = 0) => `${Math.abs(rad / DEG).toFixed(digits)}°`;
const side = (x: number) => (Math.abs(x) < 1e-9 ? '' : x > 0 ? ' S' : ' P');

export class TestHud {
  visible = true;
  private readonly root = document.createElement('div');
  private readonly tiles: Record<TileKey, Tile>;
  private readonly luffBar = document.createElement('div');
  private readonly stallBar = document.createElement('div');
  private readonly perf = document.createElement('div');
  private lastUpdate = -Infinity;

  constructor(private readonly model: BoatModel) {
    this.root.style.cssText =
      'position:fixed;left:50%;bottom:12px;transform:translateX(-50%);display:grid;' +
      'grid-template-columns:repeat(5, 150px);gap:6px;font-family:ui-monospace,Menlo,Consolas,monospace;' +
      'color:#fff;pointer-events:none;user-select:none;z-index:5;';
    const tiles = {} as Record<TileKey, Tile>;
    for (const key of Object.keys(TILE_LABELS) as TileKey[]) tiles[key] = this.tile(TILE_LABELS[key], key === 'luff');
    this.tiles = tiles;
    this.perf.style.cssText =
      'position:fixed;right:10px;top:8px;font:13px ui-monospace,Menlo,monospace;color:#fff;' +
      'background:rgba(0,0,0,0.4);padding:2px 6px;border-radius:4px;pointer-events:none;z-index:5;';
    document.body.append(this.root, this.perf);

    window.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyH' || isTypingTarget(e.target)) return;
      this.visible = !this.visible;
      this.root.style.display = this.visible ? 'grid' : 'none';
      this.perf.style.display = this.visible ? 'block' : 'none';
    });
  }

  private tile(label: string, withBar: boolean): Tile {
    const el = document.createElement('div');
    el.style.cssText = 'background:rgba(8,20,32,0.62);border-radius:8px;padding:6px 10px;';
    const l = document.createElement('div');
    l.textContent = label;
    l.style.cssText = 'font-size:12px;letter-spacing:0.08em;opacity:0.75;';
    const value = document.createElement('div');
    value.style.cssText = 'font-size:30px;font-weight:700;line-height:1.15;white-space:nowrap;';
    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:14px;opacity:0.85;white-space:nowrap;min-height:17px;';
    el.append(l, value);
    if (withBar) {
      for (const [bar, color] of [
        [this.luffBar, '#ffcc33'],
        [this.stallBar, '#ff5a3c'],
      ] as const) {
        const track = document.createElement('div');
        track.style.cssText = 'height:8px;background:rgba(255,255,255,0.2);border-radius:4px;margin:3px 0 1px;';
        bar.style.cssText = `height:100%;width:0;border-radius:4px;background:${color};`;
        track.appendChild(bar);
        el.appendChild(track);
      }
    }
    el.appendChild(sub);
    this.root.appendChild(el);
    return { value, sub };
  }

  private set(key: TileKey, value: string, sub = ''): void {
    const t = this.tiles[key];
    t.value.textContent = value;
    t.sub.textContent = sub;
  }

  update(d: Diagnostics, s: BoatState, perf: FrameStats, now: number): void {
    if (!this.visible || now - this.lastUpdate < UPDATE_INTERVAL_MS) return;
    this.lastUpdate = now;

    const tw = worldToBody(s.heading, d.trueWind.x, d.trueWind.z);
    const twa = Math.atan2(-tw.v, -tw.u);
    const tws = Math.hypot(d.trueWind.x, d.trueWind.z);
    const rudder = d.controls.tiller * this.model.cfg.rudder.maxAngleDeg * DEG;
    const luff = d.sail?.luffAmount ?? 0;
    const stall = d.sail?.stallAmount ?? 0;

    this.set('hdg', `${(wrap2Pi(s.heading) / DEG).toFixed(0).padStart(3, '0')}°`, 'true');
    this.set('spd', `${(d.speed / KNOT).toFixed(2)}`, 'kn');
    this.set('vmg', `${(d.vmg / KNOT).toFixed(2)}`, 'kn toward wind');
    this.set('awa', `${deg(d.apparent.angle)}${side(d.apparent.angle)}`, `${(d.apparent.speed / KNOT).toFixed(1)} kn`);
    this.set('twa', `${deg(twa)}${side(twa)}`, `${(tws / KNOT).toFixed(1)} kn`);
    this.set('heel', `${deg(s.heel, 1)}${side(s.heel)}`, s.heel * s.boomSide < 0 ? 'to windward' : 'to leeward');
    this.set('lee', `${deg(d.leeway, 1)}${side(d.leeway)}`, 'sliding toward');
    this.set('tiller', `${deg(rudder)}${side(rudder)}`, `${(d.controls.tiller * 100).toFixed(0)}%`);
    this.set('sheet', `${(d.controls.sheet * 100).toFixed(0)}%`, `eased · boom ${deg(s.boom)}`);
    const state = luff > 0.5 ? 'luffing' : stall > 0.5 ? 'stalled' : luff > 0.05 || stall > 0.05 ? 'soft' : 'attached';
    this.set('luff', `${luff.toFixed(2)} / ${stall.toFixed(2)}`, state);
    this.luffBar.style.width = `${(luff * 100).toFixed(0)}%`;
    this.stallBar.style.width = `${(stall * 100).toFixed(0)}%`;
    this.perf.textContent =
      `frame ${perf.frameMs.toFixed(1)} ms · cpu ${perf.cpuMs.toFixed(2)} ms · ` +
      `${(perf.triangles / 1000).toFixed(1)}k tris · ${perf.calls} calls`;
  }
}
