import type { Physics } from '../physics/bridge';
import type { BoatState, Controls } from '../physics/types';
import { DEG, wrapPi } from '../sim/frames';
import type { SnapshotMessage } from './protocol';

/** Render corrections larger than these thresholds snap instead of easing. */
export const SNAP_DISTANCE = 2; // TUNING GUESS: about a boat length.
export const SNAP_HEADING = 20 * DEG; // TUNING GUESS
/** Exponential decay time constant for render-only corrections, s. */
export const OFFSET_TAU = 0.2; // TUNING GUESS
export type RenderOffset = { dx: number; dz: number; dHeading: number };
export const ZERO_OFFSET: Readonly<RenderOffset> = Object.freeze({ dx: 0, dz: 0, dHeading: 0 });

export type Timeline = { prev: BoatState; curr: BoatState };
export type ReconcileKind = 'replay' | 'resync';

/** About four seconds of inputs at 60 Hz; an incomplete replay window requires a resync. */
const HISTORY_STEPS = 256;
const MATCH_EPSILON = 1e-9;
const FIELDS = ['t', 'x', 'z', 'heading', 'u', 'v', 'r', 'heel', 'p', 'pitch', 'pitchRate', 'boom', 'crewY'] as const;
const N = FIELDS.length;

/** Keeps applied inputs and independent predictions for authoritative rewind/replay. */
export class Reconciler {
  private readonly seqs = new Int32Array(HISTORY_STEPS).fill(-1);
  private readonly controls = new Float64Array(HISTORY_STEPS * 3);
  private readonly castOff = new Uint8Array(HISTORY_STEPS);
  private readonly states = new Float64Array(HISTORY_STEPS * N);
  private readonly boomSides = new Int8Array(HISTORY_STEPS);
  private readonly mooreds = new Uint8Array(HISTORY_STEPS);
  private minAck = 0;
  private lastAck = 0;
  private lastKind: ReconcileKind = 'replay';

  constructor(private readonly physics: Physics) {}

  /** The kind of the most recent non-null reconciliation. */
  get kind(): ReconcileKind {
    return this.lastKind;
  }

  /** Controls were already clamped before the local step; copy exactly what was applied. */
  record(seq: number, controls: Controls, castOff: boolean, state: BoatState): void {
    const slot = seq % HISTORY_STEPS;
    this.seqs[slot] = seq;
    this.controls[slot * 3] = controls.tiller;
    this.controls[slot * 3 + 1] = controls.sheet;
    this.controls[slot * 3 + 2] = controls.hike;
    this.castOff[slot] = castOff ? 1 : 0;
    this.recordPrediction(slot, state);
  }

  reconcile(snapshot: SnapshotMessage, latestSeq: number): Timeline | null {
    const ack = snapshot.ackSeq;
    if (ack < this.minAck || ack <= this.lastAck) return null;

    const slot = ack % HISTORY_STEPS;
    const matches = this.seqs[slot] === ack && this.matches(slot, snapshot.state);
    this.lastAck = ack;
    this.prune(ack);

    // Check completeness even for a matching ack: matching cannot repair a missing later input.
    let complete = latestSeq - ack <= HISTORY_STEPS;
    for (let seq = ack + 1; complete && seq <= latestSeq; seq++) {
      complete = this.seqs[seq % HISTORY_STEPS] === seq;
    }
    if (!complete) {
      this.minAck = latestSeq + 1;
      // Inputs recorded beyond this caller's timeline are still usable on a later snapshot.
      this.prune(latestSeq);
      this.lastKind = 'resync';
      return { prev: snapshot.state, curr: snapshot.state };
    }
    if (matches) return null;

    let curr = snapshot.state;
    let prev = curr;
    for (let seq = ack + 1; seq <= latestSeq; seq++) {
      const replaySlot = seq % HISTORY_STEPS;
      prev = curr;
      if (this.castOff[replaySlot]) curr = this.physics.castOff(curr);
      curr = this.physics.step(curr, {
        tiller: this.controls[replaySlot * 3]!,
        sheet: this.controls[replaySlot * 3 + 1]!,
        hike: this.controls[replaySlot * 3 + 2]!,
      });
      this.recordPrediction(replaySlot, curr);
    }
    this.lastKind = 'replay';
    return { prev, curr };
  }

  /** Discards the old connection/reset timeline; earlier acks cannot restore it. */
  reset(nextSeq: number): void {
    this.seqs.fill(-1);
    this.minAck = nextSeq;
    this.lastAck = 0;
  }

  private recordPrediction(slot: number, state: BoatState): void {
    for (let i = 0; i < N; i++) this.states[slot * N + i] = state[FIELDS[i]!];
    this.boomSides[slot] = state.boomSide;
    this.mooreds[slot] = state.moored ? 1 : 0;
  }

  private matches(slot: number, state: BoatState): boolean {
    if (state.boomSide !== this.boomSides[slot] || Number(state.moored) !== this.mooreds[slot]) return false;
    for (let i = 0; i < N; i++) {
      const field = FIELDS[i]!;
      const predicted = this.states[slot * N + i]!;
      const actual = state[field];
      if (!Number.isFinite(predicted) || !Number.isFinite(actual)) return false;
      let difference = actual - predicted;
      // Avoid adding/subtracting π at the inclusive 1e-9 boundary when already in range.
      if (field === 'heading' && Math.abs(difference) > Math.PI) difference = wrapPi(difference);
      if (!Number.isFinite(difference) || Math.abs(difference) > MATCH_EPSILON) return false;
    }
    return true;
  }

  private prune(throughSeq: number): void {
    for (let slot = 0; slot < HISTORY_STEPS; slot++) {
      if (this.seqs[slot]! <= throughSeq) this.seqs[slot] = -1;
    }
  }
}
