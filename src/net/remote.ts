/**
 * Other players' boats, drawn from the room snapshots. Each snapshot pose is buffered per boat id
 * and shown INTERP_DELAY in the past, interpolated between the two snapshots around that time, so
 * the motion stays smooth while snapshots arrive with jitter. Server time is estimated from the
 * arrival times (a smoothed offset between the local clock and `tick * dt`). When the buffer runs
 * dry the last pose is held: no extrapolation. Pure logic: no DOM or Three.js.
 */
import { wrapPi } from '../sim';
import type { RemoteBoat } from './protocol';

/** How far in the past remote boats are shown, s: two snapshots at 20 Hz. */
export const INTERP_DELAY = 0.1; // TUNING GUESS
/** Exponential smoothing of the server clock offset per snapshot. */
export const CLOCK_SMOOTHING = 0.05; // TUNING GUESS: averages arrival jitter over about 1 s at 20 Hz
/** An offset error larger than this (a stalled tab, a server restart) is adopted at once, s. */
export const CLOCK_SNAP = 1; // TUNING GUESS
/** Snapshots kept per boat: about 0.8 s at 20 Hz, well beyond INTERP_DELAY plus jitter. */
const MAX_SAMPLES = 16;

/** A remote boat's pose and controls, interpolated for one rendered frame. */
export type RemotePose = Omit<RemoteBoat, 'id'>;

const FIELDS = ['x', 'z', 'heading', 'u', 'heel', 'pitch', 'boom', 'crewY', 'tiller', 'sheet', 'apparentU', 'apparentV', 'luffAmount', 'stallAmount'] as const;

interface Sample {
  /** Server time of the snapshot, s. */
  time: number;
  boat: RemoteBoat;
}

interface Track {
  /** Oldest first, strictly increasing in time. */
  samples: Sample[];
  /** Output, reused every frame. */
  pose: RemotePose;
  /** The last `receive` call that listed this boat. */
  seen: number;
}

export class RemoteFleet {
  /** Estimated server time minus local time, s; NaN before the first snapshot. */
  offset = NaN;
  private readonly tracks = new Map<number, Track>();
  private readonly poses = new Map<number, RemotePose>();
  private received = 0;

  /** Boats currently in the room besides our own. */
  get size(): number {
    return this.tracks.size;
  }

  /**
   * One snapshot's `boats`, taken at server time `time` and arriving at local time `now` (both s).
   * A boat seen for the first time joins; a boat absent from `boats` has left.
   */
  receive(time: number, boats: readonly RemoteBoat[], now: number): void {
    const sample = time - now;
    if (Number.isNaN(this.offset) || Math.abs(sample - this.offset) > CLOCK_SNAP) this.offset = sample;
    else this.offset += (sample - this.offset) * CLOCK_SMOOTHING;

    const generation = ++this.received;
    for (const boat of boats) {
      let track = this.tracks.get(boat.id);
      if (!track) {
        track = { samples: [], pose: { ...boat }, seen: generation };
        this.tracks.set(boat.id, track);
        this.poses.set(boat.id, track.pose);
      }
      track.seen = generation;
      const samples = track.samples;
      const last = samples.at(-1);
      if (last && time <= last.time) continue; // a repeated or older tick adds nothing
      samples.push({ time, boat });
      if (samples.length > MAX_SAMPLES) samples.shift();
    }
    for (const [id, track] of this.tracks) {
      if (track.seen === generation) continue;
      this.tracks.delete(id);
      this.poses.delete(id);
    }
  }

  /** Every remote boat's pose at local time `now` (s), by id. The map and poses are reused. */
  sample(now: number): ReadonlyMap<number, RemotePose> {
    const time = now + this.offset - INTERP_DELAY;
    for (const track of this.tracks.values()) {
      const samples = track.samples;
      // Drop what is no longer needed: keep one sample at or before the render time.
      while (samples.length > 1 && samples[1]!.time <= time) samples.shift();
      const a = samples[0]!.boat;
      const b = samples[1];
      const pose = track.pose;
      if (!b || time <= samples[0]!.time) {
        // Starved (or not yet reached the first snapshot): hold the pose.
        for (const f of FIELDS) pose[f] = a[f];
        continue;
      }
      const f = (time - samples[0]!.time) / (b.time - samples[0]!.time);
      for (const k of FIELDS) pose[k] = a[k] + (b.boat[k] - a[k]) * f;
      pose.heading = a.heading + wrapPi(b.boat.heading - a.heading) * f;
    }
    return this.poses;
  }

  /** Forgets every boat and the clock (on a disconnect). */
  clear(): void {
    this.tracks.clear();
    this.poses.clear();
    this.offset = NaN;
  }
}
