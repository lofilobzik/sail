/** Navigation instruments and estimate. Pure math: no true-position input, DOM or Three.js. */
import parameters from '../data/navigation.json';
import buoyData from '../data/buoys.json';
import { DEG, bearingToWorld, wrap2Pi, type Vec2 } from '../sim/frames';

export const NAVIGATION = parameters;
export const NAV_BUOYS = buoyData.buoys;

export interface InstrumentReading {
  t: number;
  heading: number;
  /** Signed forward speed through mean water, m/s. Leeway is deliberately not observed. */
  speed: number;
}

export interface NavigationState extends Vec2 {
  t: number;
  loggedSpeed: number;
  /** Uncorrected log displacement: corrections must never change this running-fix reference. */
  trackX: number;
  trackZ: number;
  distance: number;
}

export interface Observation {
  id: number;
  t: number;
  bearing: number;
  trackX: number;
  trackZ: number;
  /** Chosen by the player on the chart, not inferred from a target's true position. */
  buoyId: string | null;
}

/** n dot position = offset; direction points FROM the observer TO the buoy. */
export interface PositionLine {
  normal: Vec2;
  direction: Vec2;
  buoy: Vec2;
  offset: number;
}

export type FixResult = { ok: true; position: Vec2 } | { ok: false; reason: string };

export function graduatedBearing(bearing: number): number {
  const step = NAVIGATION.bearingStepDeg * DEG;
  return wrap2Pi(Math.round(wrap2Pi(bearing) / step) * step);
}

export function bearingLabel(bearing: number): string {
  return `${(wrap2Pi(bearing) / DEG).toFixed(1).padStart(5, '0')}°`;
}

/** Advance a sighting's line by logged motion since it was taken (a running line of position). */
export function positionLine(observation: Observation, state: NavigationState): PositionLine | null {
  const buoy = NAV_BUOYS.find((b) => b.name === observation.buoyId);
  if (!buoy) return null;
  const direction = bearingToWorld(observation.bearing);
  const normal = { x: -direction.z, z: direction.x };
  const advancedBuoy = {
    x: buoy.x + state.trackX - observation.trackX,
    z: buoy.z + state.trackZ - observation.trackZ,
  };
  return {
    normal, direction, buoy: advancedBuoy,
    offset: normal.x * advancedBuoy.x + normal.z * advancedBuoy.z,
  };
}

function pointsTowardBuoy(line: PositionLine, point: Vec2): boolean {
  return (line.buoy.x - point.x) * line.direction.x + (line.buoy.z - point.z) * line.direction.z >= 0;
}

/** One bearing constrains a line; two well-separated bearings determine a fix. */
export function solveFix(observations: readonly Observation[], state: NavigationState): FixResult {
  if (observations.length < 1 || observations.length > 2) return { ok: false, reason: 'Select one or two notes.' };
  if (observations.some((o) => state.t < o.t || state.t - o.t > NAVIGATION.maxBearingAge)) {
    return { ok: false, reason: 'Note expired. Take a new bearing.' };
  }
  const lines = observations.map((o) => positionLine(o, state));
  const a = lines[0];
  if (!a || lines.some((l) => !l)) return { ok: false, reason: 'Identify each selected buoy.' };
  let position: Vec2;
  if (lines.length === 1) {
    const distance = a.offset - a.normal.x * state.x - a.normal.z * state.z;
    position = { x: state.x + a.normal.x * distance, z: state.z + a.normal.z * distance };
  } else {
    const b = lines[1]!;
    const det = a.normal.x * b.normal.z - a.normal.z * b.normal.x;
    if (Math.abs(det) < Math.sin(NAVIGATION.minFixAngleDeg * DEG)) {
      return { ok: false, reason: 'Lines too parallel. Sight another buoy.' };
    }
    position = {
      x: (a.offset * b.normal.z - a.normal.z * b.offset) / det,
      z: (a.normal.x * b.offset - a.offset * b.normal.x) / det,
    };
  }
  if (!Number.isFinite(position.x) || !Number.isFinite(position.z)) {
    return { ok: false, reason: 'Cannot resolve these bearings.' };
  }
  if (lines.some((l) => !pointsTowardBuoy(l!, position))) {
    return { ok: false, reason: 'Bearing points away from buoy. Check its ID.' };
  }
  return { ok: true, position };
}

export class Navigation {
  state: NavigationState;
  readonly observations: Observation[] = [];
  readonly selected = new Set<number>();
  message = 'Look down for chart. B: sight; click: note.';
  private nextId = 1;
  private readonly bias: number;
  private readonly phase: number;

  constructor(seed = 1) {
    // Integer hash for repeatable instrument calibration, not per-frame randomness.
    let hash = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
    hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
    const unit = ((hash ^ (hash >>> 16)) >>> 0) / 0x100000000;
    this.bias = NAVIGATION.log.bias + (2 * unit - 1) * NAVIGATION.log.biasSpread;
    this.phase = unit * 2 * Math.PI;
    this.state = this.departure();
  }

  private departure(): NavigationState {
    return { ...NAVIGATION.start, t: 0, loggedSpeed: 0, trackX: 0, trackZ: 0, distance: 0 };
  }

  reset(): void {
    this.state = this.departure();
    this.observations.length = 0;
    this.selected.clear();
    this.nextId = 1;
    this.message = 'Known departure. Dead reckoning restarted.';
  }

  /** Called on simulation steps only; dt follows simulated time, not wall-clock/chart-open time. */
  advance(reading: InstrumentReading, dt: number): void {
    if (!(dt > 0) || ![dt, reading.t, reading.heading, reading.speed].every(Number.isFinite)) return;
    const log = NAVIGATION.log;
    const noise = log.noiseFraction * (
      Math.sin(reading.t * 2 * Math.PI / log.noisePeriods[0]! + this.phase)
      + Math.sin(reading.t * 2 * Math.PI / log.noisePeriods[1]! - this.phase)
    ) / 2;
    const loggedSpeed = reading.speed * (1 + this.bias + noise);
    const forward = bearingToWorld(reading.heading);
    const dx = forward.x * loggedSpeed * dt;
    const dz = forward.z * loggedSpeed * dt;
    const s = this.state;
    this.state = {
      x: s.x + dx, z: s.z + dz, t: reading.t, loggedSpeed,
      trackX: s.trackX + dx, trackZ: s.trackZ + dz,
      distance: s.distance + Math.abs(loggedSpeed) * dt,
    };
  }

  record(bearing: number): void {
    if (!Number.isFinite(bearing)) return;
    const s = this.state;
    const observation: Observation = {
      id: this.nextId++, t: s.t, bearing: graduatedBearing(bearing),
      trackX: s.trackX, trackZ: s.trackZ, buoyId: null,
    };
    if (this.observations.length === NAVIGATION.maxObservations) {
      this.selected.delete(this.observations.shift()!.id);
    }
    this.observations.push(observation);
    // Keep the previous latest note for a two-bearing fix, plus the new note to identify.
    if (this.selected.size >= 2) this.selected.delete(this.selected.values().next().value!);
    this.selected.add(observation.id);
    this.message = `Noted ${bearingLabel(observation.bearing)}. Choose its buoy on chart.`;
  }

  identify(id: number, buoyId: string): void {
    const observation = this.observations.find((o) => o.id === id);
    if (!observation || !NAV_BUOYS.some((b) => b.name === buoyId)) return;
    observation.buoyId = buoyId;
    this.message = `Note ${id}: ${buoyId}. Select notes, then apply fix.`;
  }

  select(id: number): void {
    if (!this.observations.some((o) => o.id === id)) return;
    if (this.selected.has(id)) this.selected.delete(id);
    else {
      if (this.selected.size === 2) this.selected.delete(this.selected.values().next().value!);
      this.selected.add(id);
    }
  }

  applyFix(): FixResult {
    const notes = this.observations.filter((o) => this.selected.has(o.id));
    const result = solveFix(notes, this.state);
    if (result.ok) {
      this.state = { ...this.state, ...result.position };
      this.message = notes.length === 1 ? 'DR moved to line. Along-line error remains.' : 'Running two-bearing fix applied.';
    } else this.message = result.reason;
    return result;
  }

  clearNotes(): void {
    this.observations.length = 0;
    this.selected.clear();
    this.message = 'Notes cleared. Dead reckoning continues.';
  }
}
