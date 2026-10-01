/**
 * Debug overlay: DOM panel, off by default, toggled with ` (Backquote) or F3.
 * Text grouped by physics layer L1..L6 (+ Boat), each with its own show/hide checkbox.
 * The Physics section mutates the live SimConfig (layer and term toggles, wind) and can reset the boat.
 */
import { DEG, KNOT, WAVE_PARAMETERS, setWaveParameters, setWaveWind, setWaveLayers, waveAmplitude, wrap2Pi, type BoatState, type Diagnostics, type SimConfig } from '../sim';
import type { ArrowVisibility } from '../render/vectors';

const GROUPS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'Waves', 'Boat'] as const;
type GroupId = (typeof GROUPS)[number];
const GROUP_TITLES: Record<GroupId, string> = {
  L1: 'L1 Apparent wind',
  L2: 'L2 Sail',
  L3: 'L3 Foils',
  L4: 'L4 Hull',
  L5: 'L5 Heel',
  L6: 'L6 Yaw',
  Waves: 'L7 Waves',
  Boat: 'Boat',
};
const WIND_MIN_KN = WAVE_PARAMETERS.wind.minSpeedKn;
const WIND_MAX_KN = WAVE_PARAMETERS.wind.maxSpeedKn;

const OFF = 'off';
const kn = (ms: number): string => `${(ms / KNOT).toFixed(2)} kn`;
const deg = (rad: number): string => `${(rad / DEG).toFixed(1)}°`;
const n = (v: number): string => `${v.toFixed(1)} N`;
const nm = (v: number): string => `${v.toFixed(1)} N m`;
const f3 = (v: number): string => v.toFixed(3);

export class DebugOverlay {
  visible = false;
  readonly show: Record<GroupId, boolean> = { L1: true, L2: true, L3: true, L4: true, L5: true, L6: true, Waves: true, Boat: true };
  private readonly root = document.createElement('div');
  private readonly text = {} as Record<GroupId, HTMLPreElement>;

  constructor(
    private readonly cfg: SimConfig,
    onReset: () => void,
  ) {
    const r = this.root;
    r.style.cssText =
      'position:fixed;top:8px;left:8px;max-height:calc(100vh - 16px);overflow:auto;padding:8px;' +
      'background:rgba(0,0,0,0.7);color:#e8e8e8;font:12px/1.35 ui-monospace,monospace;display:none;z-index:10;';
    document.body.appendChild(r);

    for (const g of GROUPS) {
      const box = this.checkbox(r, GROUP_TITLES[g], this.show[g], (v) => {
        this.show[g] = v;
        pre.style.display = v ? '' : 'none';
      });
      box.style.fontWeight = 'bold';
      const pre = document.createElement('pre');
      pre.style.margin = '0 0 6px 16px';
      r.appendChild(pre);
      this.text[g] = pre;
    }

    this.buildPhysics(onReset);

    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Backquote' && e.code !== 'F3') return;
      e.preventDefault();
      this.visible = !this.visible;
      r.style.display = this.visible ? '' : 'none';
    });
  }

  /** Which arrow groups to draw (all hidden when the overlay is off). */
  get arrows(): ArrowVisibility {
    const v = this.visible;
    return { L1: v && this.show.L1, L2: v && this.show.L2, L3: v && this.show.L3, L4: v && this.show.L4 };
  }

  update(d: Diagnostics, s: BoatState): void {
    if (!this.visible) return;
    const L = this.cfg.layers;
    const t = this.text;
    const tws = Math.hypot(d.trueWind.x, d.trueWind.z);

    t.L1.textContent =
      `${L.apparentWind ? '' : '(layer off: sail sees true wind)\n'}` +
      `true wind  ${kn(tws)} from ${this.cfg.wind.fromDeg.toFixed(0)}°\n` +
      `AWS ${kn(d.apparent.speed)}  AWA ${deg(d.apparent.angle)}  AWA heeled ${d.sail ? deg(d.sail.awaHeeled) : OFF}`;

    const sl = d.sail;
    t.L2.textContent = sl
      ? `CL ${f3(sl.cl)}  CD ${f3(sl.cd)}  CDv ${f3(sl.cdv)}  CDi ${f3(sl.cdi)}  alpha ${deg(sl.alpha)}\n` +
        `lift ${n(sl.lift)}  drag ${n(sl.drag)}  drive fx ${n(sl.fx)}  side fy ${n(sl.fy)}\n` +
        `heel M ${nm(sl.heelMoment)}  yaw M ${nm(sl.yawMoment)}\n` +
        `trim err ${deg(sl.trimError)}  luff ${f3(sl.luffAmount)}  stall ${f3(sl.stallAmount)}  windage drag ${n(sl.windage.drag)}`
      : OFF;

    const fo = d.foils;
    t.L3.textContent = fo
      ? (['board', 'rudder'] as const)
          .map((k) => {
            const x = fo[k];
            return `${k.padEnd(6)} alpha ${deg(x.alpha)}  CL ${f3(x.cl)}  lift ${n(x.lift)}  drag ${n(x.drag)}${x.stalled ? '  STALLED' : ''}`;
          })
          .join('\n') + `\nrudder ${deg(fo.rudderAngle)}  lambda0 ${deg(fo.lambda0)}  downwash ${deg(fo.downwash)}`
      : OFF;

    const h = d.hull;
    t.L4.textContent = h
      ? `upright ${n(h.upright)} (${this.cfg.models.uprightResistance}` +
        (this.cfg.models.uprightResistance === 'delft' ? `: friction ${n(h.friction)}  residuary ${n(h.residuary)})` : ')') +
        `\nheel res ${n(h.heelResistance)}  crossflow ${n(h.crossflow)}`
      : OFF;

    const he = d.heel;
    t.L5.textContent = L.heel
      ? `heel ${deg(s.heel)}  aero M ${nm(he.aeroMoment)}  hydro M ${nm(he.hydroMoment)}\n` +
        `righting M ${nm(he.rightingMoment)}  crew Y ${he.crewY.toFixed(2)} m`
      : OFF;

    const y = d.yaw;
    t.L6.textContent = L.yaw
      ? `sail ${nm(y.sail)}  foils ${nm(y.foils)}  hull ${nm(y.hull)}\nmunk ${nm(y.munk)}  damping ${nm(y.damping)}  total ${nm(y.total)}`
      : OFF;

    const w = d.waves;
    const sea = this.cfg.waves;
    const primary = sea.components[0]!;
    t.Waves.textContent = w
      ? `big waves ${sea.bigScale.toFixed(2)}×  ripples ${sea.rippleScale.toFixed(2)}×  effective amplitude ${waveAmplitude(sea).toFixed(2)}×\n` +
        `broad period ${(2 * Math.PI / primary.omega).toFixed(2)} s at ${sea.windSpeedKn.toFixed(1)} kn\n` +
        `surface ${w.height.toFixed(3)} m  roll target ${deg(w.rollTarget)}  pitch target ${deg(w.pitchTarget)}\n` +
        `pitch ${deg(s.pitch)}  wave roll M ${nm(w.rollMoment)}\n` +
        `board flow ${w.boardU.toFixed(3)} / ${w.boardV.toFixed(3)} m/s (forward / starboard)\n` +
        `rudder flow ${w.rudderU.toFixed(3)} / ${w.rudderV.toFixed(3)} m/s`
      : `${OFF} (flat water)`;

    const c = d.controls;
    t.Boat.textContent =
      `speed ${kn(d.speed)}  leeway ${deg(d.leeway)}  VMG ${kn(d.vmg)}  heading ${deg(wrap2Pi(s.heading))}\n` +
      `tiller ${c.tiller.toFixed(2)}  sheet ${c.sheet.toFixed(2)}  hike ${c.hike.toFixed(2)}`;
  }

  private buildPhysics(onReset: () => void): void {
    const cfg = this.cfg;
    const sec = document.createElement('div');
    sec.style.cssText = 'border-top:1px solid #666;margin-top:4px;padding-top:4px;';
    sec.innerHTML = '<b>Physics</b>';
    this.root.appendChild(sec);

    for (const key of Object.keys(cfg.layers) as (keyof SimConfig['layers'])[]) {
      this.checkbox(sec, `layer ${key}`, cfg.layers[key], (v) => (cfg.layers[key] = v));
    }
    for (const key of Object.keys(cfg.terms) as (keyof SimConfig['terms'])[]) {
      this.checkbox(sec, `term ${key}`, cfg.terms[key], (v) => (cfg.terms[key] = v));
    }
    const m = cfg.models;
    this.select(sec, 'lift slope', ['standard', 'printed'], m.liftSlope, (v) => (m.liftSlope = v as typeof m.liftSlope));
    this.select(sec, 'lambda0 unit', ['deg', 'rad'], m.lambda0Unit, (v) => (m.lambda0Unit = v as typeof m.lambda0Unit));
    this.select(sec, 'lambda0 sign', ['1', '-1'], String(m.lambda0Sign), (v) => (m.lambda0Sign = v === '1' ? 1 : -1));
    this.select(sec, 'upright hull', ['delft', 'tank'], m.uprightResistance, (v) => (m.uprightResistance = v as typeof m.uprightResistance));

    this.numberInput(sec, `wind kn (${WIND_MIN_KN}-${WIND_MAX_KN})`, cfg.wind.speedKn, (v, el) => {
      cfg.wind.speedKn = Math.min(WIND_MAX_KN, Math.max(WIND_MIN_KN, v));
      setWaveWind(cfg.waves, cfg.wind.speedKn);
      el.value = String(cfg.wind.speedKn);
    });
    this.numberInput(sec, 'wind from °', cfg.wind.fromDeg, (v, el) => {
      cfg.wind.fromDeg = ((v % 360) + 360) % 360;
      el.value = String(cfg.wind.fromDeg);
    });

    this.checkbox(sec, 'waves', cfg.waves.enabled, (v) => (cfg.waves.enabled = v));
    this.rangeInput(sec, 'wave amplitude', cfg.waves.amplitudeScale, WAVE_PARAMETERS.maxAmplitudeScale, (v) => {
      cfg.waves.amplitudeScale = v;
    });
    this.rangeInput(sec, 'big waves', cfg.waves.bigScale, WAVE_PARAMETERS.maxLayerScale, (v) => {
      setWaveLayers(cfg.waves, v, cfg.waves.rippleScale);
    });
    this.rangeInput(sec, 'ripples', cfg.waves.rippleScale, WAVE_PARAMETERS.maxLayerScale, (v) => {
      setWaveLayers(cfg.waves, cfg.waves.bigScale, v);
    });
    this.numberInput(sec, 'broad period at 7 kn s (2–8)', cfg.waves.periodSeconds, (v, el) => {
      setWaveParameters(cfg.waves, v, cfg.waves.directionDeg);
      el.value = cfg.waves.periodSeconds.toFixed(2);
    });
    this.numberInput(sec, 'wave direction TO °', cfg.waves.directionDeg, (v, el) => {
      setWaveParameters(cfg.waves, cfg.waves.periodSeconds, v);
      el.value = String(cfg.waves.directionDeg);
    });

    const btn = document.createElement('button');
    btn.textContent = 'Reset boat';
    btn.addEventListener('click', () => {
      onReset();
      btn.blur();
    });
    sec.appendChild(btn);
  }

  private checkbox(parent: HTMLElement, label: string, initial: boolean, onChange: (v: boolean) => void): HTMLLabelElement {
    const el = document.createElement('label');
    el.style.display = 'block';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = initial;
    input.addEventListener('change', () => {
      onChange(input.checked);
      input.blur(); // hand the keyboard back to the boat
    });
    el.append(input, ` ${label}`);
    parent.appendChild(el);
    return el;
  }

  private rangeInput(
    parent: HTMLElement, label: string, initial: number, max: number, onChange: (v: number) => void,
  ): void {
    const el = document.createElement('label');
    el.style.display = 'block';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = String(max);
    slider.step = '0.05'; // TUNING GUESS: sea control increment
    slider.value = String(initial);
    const value = document.createElement('span');
    value.textContent = ` ${initial.toFixed(2)}×`;
    slider.addEventListener('input', () => {
      const v = Number(slider.value);
      onChange(v);
      value.textContent = ` ${v.toFixed(2)}×`;
    });
    el.append(`${label} `, slider, value);
    parent.appendChild(el);
  }

  private numberInput(parent: HTMLElement, label: string, initial: number, onChange: (v: number, el: HTMLInputElement) => void): void {
    const el = document.createElement('label');
    el.style.display = 'block';
    const input = document.createElement('input');
    input.type = 'number';
    input.step = 'any';
    input.value = String(initial);
    input.style.width = '5em';
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (Number.isFinite(v)) onChange(v, input);
    });
    el.append(`${label} `, input);
    parent.appendChild(el);
  }

  private select(parent: HTMLElement, label: string, options: string[], initial: string, onChange: (v: string) => void): void {
    const el = document.createElement('label');
    el.style.display = 'block';
    const input = document.createElement('select');
    for (const o of options) input.add(new Option(o, o, o === initial, o === initial));
    input.addEventListener('change', () => {
      onChange(input.value);
      input.blur(); // hand the keyboard back to the boat
    });
    el.append(`${label} `, input);
    parent.appendChild(el);
  }
}
