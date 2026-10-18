import type { BoatState, Controls, Diagnostics, SimConfig } from './types';

const STATE_FIELDS = [
  't', 'x', 'z', 'heading', 'u', 'v', 'r', 'heel', 'p', 'pitch', 'pitchRate',
  'boom', 'boomSide', 'crewY', 'moored',
] as const satisfies readonly (keyof BoatState)[];
const CONTROL_FIELDS = ['tiller', 'sheet', 'hike'] as const satisfies readonly (keyof Controls)[];
const CONTROL_OFFSET = STATE_FIELDS.length * 8;

/** Synchronous exports installed by server/cmd/simwasm. */
export interface GoPhysics {
  layout(): string;
  browserConfig(seed: number): string;
  setConfig(json: string): string;
  step(io: Uint8Array): void;
  stepMany(io: Uint8Array, count: number): void;
  evaluate(io: Uint8Array): void;
  castOff(io: Uint8Array): void;
  mooredAt(berth: number, t: number, io: Uint8Array): void;
  diagnostics(): string;
  clampControls(io: Uint8Array): void;
}

export class Physics {
  private io = new Uint8Array((STATE_FIELDS.length + CONTROL_FIELDS.length) * 8);
  private view = new DataView(this.io.buffer);

  constructor(private readonly api: GoPhysics) {
    const goNames = api.layout();
    const tsLayout = { state: STATE_FIELDS, controls: CONTROL_FIELDS };
    const layout = JSON.parse(goNames) as { state: unknown; controls: unknown };
    if (JSON.stringify(layout.state) !== JSON.stringify(STATE_FIELDS)
      || JSON.stringify(layout.controls) !== JSON.stringify(CONTROL_FIELDS)) {
      throw new Error(`physics layout mismatch: ${goNames} vs ${JSON.stringify(tsLayout)}`);
    }
  }

  step(state: BoatState, controls: Controls): BoatState {
    this.writeState(state);
    this.writeControls(controls);
    this.api.step(this.io);
    return this.readState();
  }

  /** Consecutive inputs without intervening cast-offs; the final step owns diagnostics. */
  stepMany(state: BoatState, controls: readonly Controls[]): BoatState {
    const size = CONTROL_OFFSET + controls.length * CONTROL_FIELDS.length * 8;
    if (size > this.io.byteLength) {
      this.io = new Uint8Array(size);
      this.view = new DataView(this.io.buffer);
    }
    this.writeState(state);
    for (let i = 0; i < controls.length; i++) {
      this.writeControls(controls[i]!, CONTROL_OFFSET + i * CONTROL_FIELDS.length * 8);
    }
    this.api.stepMany(this.io, controls.length);
    return this.readState();
  }

  evaluate(state: BoatState, controls: Controls): Diagnostics {
    this.writeState(state);
    this.writeControls(controls);
    this.api.evaluate(this.io);
    return this.diagnostics();
  }

  diagnostics(): Diagnostics {
    return JSON.parse(this.api.diagnostics()) as Diagnostics;
  }

  castOff(state: BoatState): BoatState {
    this.writeState(state);
    this.api.castOff(this.io);
    return this.readState();
  }

  mooredAt(berthIndex: number, t: number): BoatState {
    this.api.mooredAt(berthIndex, t, this.io);
    if (Number.isNaN(this.view.getFloat64(0, true))) {
      throw new RangeError(`invalid physics berth index: ${berthIndex}`);
    }
    return this.readState();
  }

  clampControls(controls: Controls): Controls {
    this.writeControls(controls);
    this.api.clampControls(this.io);
    return {
      tiller: this.view.getFloat64(CONTROL_OFFSET, true),
      sheet: this.view.getFloat64(CONTROL_OFFSET + 8, true),
      hike: this.view.getFloat64(CONTROL_OFFSET + 16, true),
    };
  }

  browserConfig(seed: number): SimConfig {
    return JSON.parse(this.api.browserConfig(seed)) as SimConfig;
  }

  setConfig(cfg: SimConfig): SimConfig {
    const json = JSON.stringify({
      ...cfg,
      wind: { ...cfg.wind, gusts: cfg.wind.gusts ?? { enabled: false } },
    });
    const normalized = this.api.setConfig(json);
    if (normalized.startsWith('error:')) throw new Error(normalized);
    return JSON.parse(normalized) as SimConfig;
  }

  private writeState(state: BoatState): void {
    for (let i = 0; i < STATE_FIELDS.length; i++) {
      this.view.setFloat64(i * 8, Number(state[STATE_FIELDS[i]!]), true);
    }
  }

  private writeControls(controls: Controls, offset = CONTROL_OFFSET): void {
    for (let i = 0; i < CONTROL_FIELDS.length; i++) {
      this.view.setFloat64(offset + i * 8, controls[CONTROL_FIELDS[i]!], true);
    }
  }

  private readState(): BoatState {
    return {
      t: this.view.getFloat64(0, true),
      x: this.view.getFloat64(8, true),
      z: this.view.getFloat64(16, true),
      heading: this.view.getFloat64(24, true),
      u: this.view.getFloat64(32, true),
      v: this.view.getFloat64(40, true),
      r: this.view.getFloat64(48, true),
      heel: this.view.getFloat64(56, true),
      p: this.view.getFloat64(64, true),
      pitch: this.view.getFloat64(72, true),
      pitchRate: this.view.getFloat64(80, true),
      boom: this.view.getFloat64(88, true),
      boomSide: this.view.getFloat64(96, true) as 1 | -1,
      crewY: this.view.getFloat64(104, true),
      moored: this.view.getFloat64(112, true) !== 0,
    };
  }
}

/** Adopt normalized Go settings without invalidating render/overlay references. */
export function adoptPhysicsConfig(target: SimConfig, source: SimConfig): void {
  Object.assign(target.layers, source.layers);
  Object.assign(target.terms, source.terms);
  Object.assign(target.models, source.models);
  Object.assign(target.env, source.env);
  const gusts = target.wind.gusts;
  Object.assign(target.wind, source.wind);
  if (gusts && source.wind.gusts) target.wind.gusts = Object.assign(gusts, source.wind.gusts);
  else if (!source.wind.gusts) delete target.wind.gusts;
  Object.assign(target.waves, source.waves);
  target.dt = source.dt;
  target.substeps = source.substeps;
  target.land = source.land;
}
