/**
 * Corrects the locally predicted boat toward the server's. No rewind/replay: each snapshot is
 * compared with the local prediction after the same input (`ackSeq`), and the difference that has
 * not been corrected since is blended out over BLEND_SECONDS, or applied at once when it is large.
 */
import { DEG, wrapPi, type BoatState } from '../sim';
import type { SnapshotMessage } from './protocol';

/** Position error above which the correction is applied at once instead of blended, m. */
export const SNAP_DISTANCE = 2; // TUNING GUESS: a boat length is visibly wrong, smaller jumps blend
/** Heading error above which the correction is applied at once, rad. */
export const SNAP_HEADING = 20 * DEG; // TUNING GUESS
/** Time over which a small error is blended out, s. */
export const BLEND_SECONDS = 0.2; // TUNING GUESS
/** Predicted steps kept for comparison: about 4 s at 60 Hz. An older ack re-syncs to the server. */
const HISTORY_STEPS = 256;
const MEAN_SMOOTHING = 0.1; // exponential smoothing of the correction-size readout

/** Continuous state fields; boomSide is discrete and compared separately. */
const FIELDS = ['t', 'x', 'z', 'heading', 'u', 'v', 'r', 'heel', 'p', 'pitch', 'pitchRate', 'boom', 'crewY'] as const;
const N = FIELDS.length;
const X = FIELDS.indexOf('x');
const Z = FIELDS.indexOf('z');
const HEADING = FIELDS.indexOf('heading');

/** blend: spread over BLEND_SECONDS; snap: applied at once; resync: server state adopted outright. */
export type CorrectionKind = 'blend' | 'snap' | 'resync';

export interface CorrectionReport {
  kind: CorrectionKind;
  /** Position error, m. */
  position: number;
  /** Heading error, rad (absolute). */
  heading: number;
}

export class Corrector {
  last: CorrectionReport | null = null;
  /** Smoothed position error of blended corrections, m. */
  meanPosition = 0;
  readonly counts: Record<CorrectionKind, number> = { blend: 0, snap: 0, resync: 0 };

  private readonly seqs = new Float64Array(HISTORY_STEPS).fill(-1);
  private readonly states = new Float64Array(HISTORY_STEPS * N);
  private readonly boomSides = new Int8Array(HISTORY_STEPS);
  /** `total` when each history entry was recorded. */
  private readonly totals = new Float64Array(HISTORY_STEPS * N);
  /** Sum of all corrections applied so far. */
  private readonly total = new Float64Array(N);
  private readonly pending = new Float64Array(N);
  private readonly error = new Float64Array(N);
  private blendLeft = 0;
  /** Acks below this predate the last reset/resync and are ignored. */
  private minAck = 1;

  /** Applies this step's share of the blend to `s` (the state after input `seq`) and records it. */
  afterStep(s: BoatState, seq: number, dt: number): void {
    if (this.blendLeft > 0) {
      const f = Math.min(1, dt / this.blendLeft);
      this.blendLeft = Math.max(0, this.blendLeft - dt);
      for (let i = 0; i < N; i++) {
        const d = this.pending[i]! * f;
        this.pending[i]! -= d;
        this.total[i]! += d;
        s[FIELDS[i]!] += d;
      }
    }
    const slot = seq % HISTORY_STEPS;
    this.seqs[slot] = seq;
    this.boomSides[slot] = s.boomSide;
    for (let i = 0; i < N; i++) {
      this.states[slot * N + i] = s[FIELDS[i]!];
      this.totals[slot * N + i] = this.total[i]!;
    }
  }

  /**
   * Folds a snapshot into the predicted state `s` (mutated). `nextSeq` is the next input seq to be
   * sent. Returns true when `s` jumped, so the caller should not interpolate from the previous state.
   */
  apply(snap: SnapshotMessage, s: BoatState, nextSeq: number): boolean {
    if (snap.ackSeq < this.minAck) return false;
    const server = snap.state;
    const slot = snap.ackSeq % HISTORY_STEPS;
    if (this.seqs[slot] !== snap.ackSeq) {
      // No prediction for that input (too old): adopt the server state as it is.
      this.resync(server, s, nextSeq);
      return true;
    }
    const e = this.error;
    for (let i = 0; i < N; i++) {
      const f = FIELDS[i]!;
      const diff = server[f] - this.states[slot * N + i]!;
      // Error at that input, minus the corrections applied since it was predicted.
      e[i] = (i === HEADING ? wrapPi(diff) : diff) - (this.total[i]! - this.totals[slot * N + i]!);
    }
    const position = Math.hypot(e[X]!, e[Z]!);
    const heading = Math.abs(e[HEADING]!);
    if (position > SNAP_DISTANCE || heading > SNAP_HEADING || server.boomSide !== this.boomSides[slot]) {
      this.report('snap', position, heading);
      for (let i = 0; i < N; i++) {
        s[FIELDS[i]!] += e[i]!;
        this.total[i]! += e[i]!;
      }
      s.boomSide = server.boomSide;
      this.pending.fill(0);
      this.blendLeft = 0;
      return true;
    }
    this.report('blend', position, heading);
    this.meanPosition += (position - this.meanPosition) * MEAN_SMOOTHING;
    this.pending.set(e);
    this.blendLeft = BLEND_SECONDS;
    return false;
  }

  /** Adopts the server state `server` into `s` outright and forgets all predictions. */
  resync(server: BoatState, s: BoatState, nextSeq: number): void {
    this.report('resync', Math.hypot(server.x - s.x, server.z - s.z), Math.abs(wrapPi(server.heading - s.heading)));
    Object.assign(s, server);
    this.reset(nextSeq);
  }

  /** Forgets all predictions; acks below `nextSeq` are ignored from now on. */
  reset(nextSeq: number): void {
    this.seqs.fill(-1);
    this.total.fill(0);
    this.pending.fill(0);
    this.blendLeft = 0;
    this.minAck = nextSeq;
  }

  private report(kind: CorrectionKind, position: number, heading: number): void {
    this.last = { kind, position, heading };
    this.counts[kind]++;
  }
}
