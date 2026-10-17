/**
 * The sailor's navigation. Pure math: no true-position input, DOM or Three.js.
 *
 * There is no live position. The sailor takes timed readings with a hand-bearing compass (course and
 * bearings), remembers them, and later spends time plotting them on the chart; speed over ground
 * comes from a GPS watch. The only position ever shown is the last one drawn in pencil.
 */
import parameters from '../../data/navigation.json';
import buoyData from '../../data/buoys.json';
import { DEG, bearingToWorld, wrap2Pi, wrapPi, type Vec2 } from '../sim/frames';
import { LANDMARKS } from '../sim/terrain';

export const NAVIGATION = parameters;

/** Something fixed a bearing can be taken on: a buoy or a landmark ashore, at known chart positions. */
export interface Mark extends Vec2 {
  name: string;
  /** Height above mean sea level the eye sights on, m. */
  sightHeight: number;
}

export const NAV_MARKS: readonly Mark[] = [
  ...buoyData.buoys.map((b) => ({ name: b.name, x: b.x, z: b.z, sightHeight: buoyData.height / 2 })),
  ...LANDMARKS.map((l) => ({ name: l.name, x: l.x, z: l.z, sightHeight: l.base + l.height * NAVIGATION.visual.landmarkSightFraction })),
];

export interface InstrumentReading {
  t: number;
  /** Speed over ground, m/s: the GPS watch, always in view. */
  speed: number;
}

/** A value kept in the sailor's memory, with the simulated time it was read. */
export interface Remembered { value: number; t: number }

/** The last position drawn on the chart and the radius of the sailor's doubt about it, metres. */
export interface PlottedFix extends Vec2 { t: number; radius: number }

/**
 * Where and when dead reckoning starts: a known point, not a reading. Offline the berth the boat
 * starts at (or `?start`); on a server the spawn point it announces.
 */
export interface Departure extends Vec2 { t: number }

export interface Observation {
  id: number;
  t: number;
  bearing: number;
  /** Chosen by the player on the chart, not inferred from a target's true position. */
  markId: string | null;
}

/** n dot position = offset; direction points FROM the observer TO the mark. */
export interface PositionLine {
  normal: Vec2;
  direction: Vec2;
  mark: Vec2;
  offset: number;
}

/** How a sighting is carried forward to now: the remembered course at the watch's speed, if a course is known. */
export interface Carry { t: number; velocity: Vec2 | null }
export interface FixContext extends Carry { position: Vec2 }

export type FixResult = { ok: true; position: Vec2 } | { ok: false; reason: string };
export type PlotKind = 'leg' | 'fix';
export interface Task { kind: 'bearing' | PlotKind; elapsed: number; duration: number }

/**
 * A steady-aim hold: offsets from the first aim, so a slow track on a mark averages out, and what the
 * eyes saw during it (bow or marks), so a boat rocking the crosshair off the mark for a moment is forgiven.
 */
interface Hold {
  ref: number;
  lastT: number;
  samples: { t: number; d: number }[];
  steps: number;
  bowSteps: number;
  marks: Map<string, number>;
}

function newHold(ref: number, t: number): Hold {
  return { ref, lastT: t, samples: [{ t, d: 0 }], steps: 0, bowSteps: 0, marks: new Map() };
}

export function graduatedBearing(bearing: number): number {
  const step = NAVIGATION.bearingStepDeg * DEG;
  return wrap2Pi(Math.round(wrap2Pi(bearing) / step) * step);
}

export function bearingLabel(bearing: number): string {
  return `${(wrap2Pi(bearing) / DEG).toFixed(1).padStart(5, '0')}°`;
}

/** Advance a sighting's line by the remembered motion since it was taken (a running line of position). */
export function positionLine(observation: Observation, carry: Carry): PositionLine | null {
  const mark = NAV_MARKS.find((m) => m.name === observation.markId);
  if (!mark) return null;
  const direction = bearingToWorld(observation.bearing);
  const normal = { x: -direction.z, z: direction.x };
  const age = carry.t - observation.t;
  const advancedMark = {
    x: mark.x + (carry.velocity?.x ?? 0) * age,
    z: mark.z + (carry.velocity?.z ?? 0) * age,
  };
  return {
    normal, direction, mark: advancedMark,
    offset: normal.x * advancedMark.x + normal.z * advancedMark.z,
  };
}

/** Where two position lines cross, or null when they are too close to parallel to be trusted. */
export function lineIntersection(a: PositionLine, b: PositionLine): Vec2 | null {
  const det = a.normal.x * b.normal.z - a.normal.z * b.normal.x;
  if (Math.abs(det) < Math.sin(NAVIGATION.minFixAngleDeg * DEG)) return null;
  return {
    x: (a.offset * b.normal.z - a.normal.z * b.offset) / det,
    z: (a.normal.x * b.offset - a.offset * b.normal.x) / det,
  };
}

function pointsTowardMark(line: PositionLine, point: Vec2): boolean {
  return (line.mark.x - point.x) * line.direction.x + (line.mark.z - point.z) * line.direction.z >= 0;
}

/** One bearing constrains a line; two well-separated bearings determine a fix. */
export function solveFix(observations: readonly Observation[], context: FixContext): FixResult {
  if (observations.length < 1 || observations.length > 2) return { ok: false, reason: 'Select one or two notes.' };
  if (observations.some((o) => context.t < o.t || context.t - o.t > NAVIGATION.maxBearingAge)) {
    return { ok: false, reason: 'Note expired. Take a new bearing.' };
  }
  if (!context.velocity && observations.some((o) => context.t - o.t > NAVIGATION.noteCarryGrace)) {
    return { ok: false, reason: 'Read your course (F, compass along the bow) to carry the bearing forward.' };
  }
  const lines = observations.map((o) => positionLine(o, context));
  const a = lines[0];
  if (!a || lines.some((l) => !l)) return { ok: false, reason: 'Identify each selected mark.' };
  let position: Vec2 | null;
  if (lines.length === 1) {
    const distance = a.offset - a.normal.x * context.position.x - a.normal.z * context.position.z;
    position = { x: context.position.x + a.normal.x * distance, z: context.position.z + a.normal.z * distance };
  } else {
    position = lineIntersection(a, lines[1]!);
    if (!position) return { ok: false, reason: 'Lines too parallel. Sight another mark.' };
  }
  if (!Number.isFinite(position.x) || !Number.isFinite(position.z)) {
    return { ok: false, reason: 'Cannot resolve these bearings.' };
  }
  if (lines.some((l) => !pointsTowardMark(l!, position))) {
    return { ok: false, reason: 'Bearing points away from its mark. Check what you sighted.' };
  }
  return { ok: true, position };
}

export class Navigation {
  /** Simulated time of the latest instrument step. */
  t = 0;
  plotted: PlottedFix = { ...NAVIGATION.start, t: 0, radius: NAVIGATION.accuracy.departure };
  /** Every position pencilled on the chart, oldest first, ending with `plotted`. */
  readonly track: PlottedFix[] = [{ ...this.plotted }];
  course: Remembered | null = null;
  /** Speed over ground from the GPS watch, m/s, as of the latest instrument step. */
  speed = 0;
  readonly observations: Observation[] = [];
  task: Task | null = null;
  message = 'Hold F on a buoy, a landmark or the bow for a bearing.';
  private nextId = 1;
  private aimT = 0;
  private aim: number | null = null;
  private hold: Hold | null = null;
  private looking = true;
  /** The mark the compass is pointing at, as recognised by the sailor's eyes; null if none. */
  aimedMark: string | null = null;
  /** The compass is pointing at the boat's own bow: a bow bearing is the boat's course. */
  aimedBow = false;

  reset(departure: Departure = { ...NAVIGATION.start, t: 0 }): void {
    this.t = departure.t;
    this.plotted = { x: departure.x, z: departure.z, t: departure.t, radius: NAVIGATION.accuracy.departure };
    this.course = null;
    this.speed = 0;
    this.observations.length = 0;
    this.track.length = 0;
    this.track.push({ ...this.plotted });
    this.task = null;
    this.aim = null;
    this.hold = null;
    this.nextId = 1;
    this.message = 'Known departure. Dead reckoning restarted.';
  }

  /** Remembered course at the watch's speed, assumed to hold; null until a course has been read. */
  get velocity(): Vec2 | null {
    if (!this.course) return null;
    const direction = bearingToWorld(this.course.value);
    return { x: direction.x * this.speed, z: direction.z * this.speed };
  }

  /** Where the remembered motion says the boat is now. Used for corrections; never drawn. */
  get estimate(): Vec2 {
    const v = this.velocity;
    const dt = this.t - this.plotted.t;
    return { x: this.plotted.x + (v?.x ?? 0) * dt, z: this.plotted.z + (v?.z ?? 0) * dt };
  }

  get carry(): Carry {
    return { t: this.t, velocity: this.velocity };
  }

  /** A bearing is being read. */
  get reading(): boolean {
    return this.task?.kind === 'bearing';
  }

  get plotting(): PlotKind | null {
    const kind = this.task?.kind;
    return kind === 'leg' || kind === 'fix' ? kind : null;
  }

  /** Fraction of the current task done, 0..1. */
  get progress(): number {
    return this.task ? Math.min(1, this.task.elapsed / this.task.duration) : 0;
  }

  /** Called on simulation steps only; dt follows simulated time, not wall-clock/chart-open time. */
  advance(reading: InstrumentReading, dt: number): void {
    if (!(dt > 0) || ![dt, reading.t, reading.speed].every(Number.isFinite)) return;
    this.t = reading.t;
    this.speed = reading.speed;
    const task = this.task;
    if (!task) return;
    if (task.kind === 'bearing' && !this.steady(task)) return;
    // Pencil work only progresses while the sailor is looking at the paper.
    if (this.plotting && !this.looking) return;
    task.elapsed += dt;
    if (task.elapsed >= task.duration) this.complete(task);
  }

  /**
   * The compass must be held on a mark: pointing at nothing, or an aim more than `aimToleranceDeg`
   * from its own recent mean, restarts the reading. The boat's rocking in waves swings the aim a few
   * degrees either way and is averaged out; a slow track moves the mean with it.
   */
  private steady(task: Task): boolean {
    if (this.aim === null) {
      task.elapsed = 0;
      this.hold = null;
      return false;
    }
    const now = this.aimT;
    const hold = this.hold;
    if (!hold) {
      this.hold = newHold(this.aim, now);
    } else if (now !== hold.lastT) {
      const d = wrapPi(this.aim - hold.ref);
      const mean = hold.samples.reduce((sum, s) => sum + s.d, 0) / hold.samples.length;
      if (Math.abs(d - mean) > NAVIGATION.aimToleranceDeg * DEG) {
        task.elapsed = 0;
        this.hold = newHold(this.aim, now);
      } else {
        hold.samples.push({ t: now, d });
        while (hold.samples[0]!.t < now - NAVIGATION.aimAverageSeconds) hold.samples.shift();
        hold.lastT = now;
      }
    }
    const current = this.hold!;
    current.steps += 1;
    if (this.aimedBow) current.bowSteps += 1;
    else if (this.aimedMark) current.marks.set(this.aimedMark, (current.marks.get(this.aimedMark) ?? 0) + 1);
    return true;
  }

  /** Where the hand-bearing compass points right now, or null when it points at nothing usable. */
  setAim(bearing: number | null): void {
    this.aim = bearing !== null && Number.isFinite(bearing) ? bearing : null;
    this.aimT = this.t;
  }

  /** Whether the chart is in the sailor's view; plotting pauses while it is not. */
  setLooking(looking: boolean): void {
    this.looking = looking;
  }

  /** The mark under the crosshair, named by the eye (a buoy's painted ID, a landmark's shape). Bearings still come from the compass. */
  setAimedMark(name: string | null): void {
    this.aimedMark = name;
  }

  setAimedBow(aimed: boolean): void {
    this.aimedBow = aimed;
  }

  beginReading(): void {
    if (this.task) return;
    this.task = { kind: 'bearing', elapsed: 0, duration: NAVIGATION.timing.bearingRead };
    this.hold = null;
    this.message = 'Hold steady on a buoy or landmark: the eye names it. Line the compass up with the bow, tilted down, for your course.';
  }

  cancelReading(): void {
    if (!this.reading) return;
    this.task = null;
    this.hold = null;
    this.message = 'Reading lost. Hold it steady next time.';
  }

  /** What the compass was on for most of the hold: the bow (the course), or the mark under the crosshair. */
  private holdTarget(hold: Hold | null): string | null {
    if (!hold || !hold.steps) return null;
    if (hold.bowSteps * 2 > hold.steps) return 'course';
    let best: string | null = null;
    let votes = 0;
    for (const [name, count] of hold.marks) {
      if (count > votes) {
        best = name;
        votes = count;
      }
    }
    return best && votes >= NAVIGATION.markHoldFraction * hold.steps ? best : null;
  }

  /**
   * The notes a fix would use: bearings taken since the last plot, named, still fresh, and at most
   * one newest per mark (two marks give a fix, one gives a line). Oldest first.
   */
  candidateNotes(): Observation[] {
    const chosen: Observation[] = [];
    for (const note of [...this.observations].reverse()) {
      if (!note.markId || note.t <= this.plotted.t || this.t - note.t > NAVIGATION.maxBearingAge) continue;
      if (chosen.some((c) => c.markId === note.markId)) continue;
      chosen.push(note);
      if (chosen.length === 2) break;
    }
    return chosen.reverse();
  }

  /** One key to plot: a fix from the new bearings if there are any, otherwise the dead-reckoning leg. */
  beginAutoPlot(): boolean {
    return this.beginPlot(this.candidateNotes().length ? 'fix' : 'leg');
  }

  /** Start the timed pencil work of putting remembered values on the chart. */
  beginPlot(kind: PlotKind): boolean {
    if (this.task) {
      this.message = 'Still working.';
      return false;
    }
    const timing = NAVIGATION.timing;
    let duration: number;
    if (kind === 'leg') {
      if (!this.velocity) {
        this.message = 'Read a course first (F, compass along the bow).';
        return false;
      }
      duration = timing.plotLeg;
    } else {
      const notes = this.candidateNotes();
      const result = solveFix(notes, { ...this.carry, position: this.estimate });
      if (!result.ok) {
        this.message = result.reason;
        return false;
      }
      duration = timing.plotLine * notes.length;
    }
    this.task = { kind, elapsed: 0, duration };
    this.message = kind === 'leg' ? 'Plotting the dead-reckoning leg.' : 'Plotting the bearing lines.';
    return true;
  }

  cancelPlot(): void {
    if (!this.plotting) return;
    this.task = null;
    this.message = 'Plotting abandoned.';
  }

  /** Pencil a new position onto the chart and into the track. */
  private moveTo(fix: PlottedFix): void {
    this.plotted = fix;
    this.track.push(fix);
    if (this.track.length > NAVIGATION.maxTrack) this.track.shift();
  }

  private complete(task: Task): void {
    this.task = null;
    if (task.kind === 'bearing') {
      const hold = this.hold;
      this.hold = null;
      if (this.aim === null) return;
      // Average the last moments of the hold: a slow track on a mark reads its mean direction.
      const mean = hold ? hold.samples.reduce((sum, s) => sum + s.d, 0) / hold.samples.length : 0;
      this.record(hold ? hold.ref + mean : this.aim);
      const target = this.holdTarget(hold);
      const note = this.observations.at(-1);
      if (target === 'course' && note) this.assignCourse(note.id);
      else if (target && note) this.identify(note.id, target);
    } else if (task.kind === 'leg') {
      this.plotLeg();
    } else {
      this.plotFix();
    }
  }

  private plotLeg(): void {
    const v = this.velocity;
    if (!v) return;
    const dt = this.t - this.plotted.t;
    const a = NAVIGATION.accuracy;
    const fraction = Math.hypot(a.speedFraction, Math.tan(a.courseSigmaDeg * DEG));
    this.moveTo({
      x: this.plotted.x + v.x * dt,
      z: this.plotted.z + v.z * dt,
      t: this.t,
      radius: this.plotted.radius + fraction * Math.hypot(v.x, v.z) * dt,
    });
    this.message = 'Leg plotted. Doubt grows with every metre sailed on memory.';
  }

  private plotFix(): void {
    const notes = this.candidateNotes();
    const result = solveFix(notes, { ...this.carry, position: this.estimate });
    if (!result.ok) {
      this.message = result.reason;
      return;
    }
    const a = NAVIGATION.accuracy;
    this.moveTo({
      ...result.position, t: this.t,
      radius: notes.length === 1 ? a.oneLineFix : a.twoLineFix,
    });
    this.message = notes.length === 1 ? 'Plotted on the line. Along-line error remains.' : 'Two-bearing fix plotted.';
  }

  record(bearing: number): void {
    if (!Number.isFinite(bearing)) return;
    const observation: Observation = { id: this.nextId++, t: this.t, bearing: graduatedBearing(bearing), markId: null };
    if (this.observations.length === NAVIGATION.maxObservations) this.observations.shift();
    this.observations.push(observation);
    this.message = `Noted ${bearingLabel(observation.bearing)}. No mark was under the crosshair.`;
  }

  identify(id: number, markId: string): void {
    const observation = this.observations.find((o) => o.id === id);
    if (!observation || !NAV_MARKS.some((m) => m.name === markId)) return;
    observation.markId = markId;
    this.message = `Note ${id}: ${markId}. Press R to reckon.`;
  }

  /** The note was taken along the bow: remember it as the course instead of a mark bearing. */
  assignCourse(id: number): void {
    const observation = this.observations.find((o) => o.id === id);
    if (!observation) return;
    this.course = { value: observation.bearing, t: observation.t };
    this.observations.splice(this.observations.indexOf(observation), 1);
    this.message = `Course ${bearingLabel(observation.bearing)} remembered.`;
  }
}
