/**
 * WebSocket protocol shared with the Go server (server/netsim/protocol.go). JSON text frames on /ws.
 * One public room per server: it owns the seed, the config, the room time and every boat; each
 * client predicts its own boat with the TS sim and draws the others from the snapshots.
 * The connect URL may carry `?resume=<token>` (the `resume` of an earlier welcome) to get the same
 * boat back after a drop, and `?player=<sailor code>` (src/net/sailorCode.ts) for challenge progress.
 */
import type { BoatState, Controls, SimConfig } from '../sim';

/** Sent once on connect. `config` is the SimConfig as the server runs it (Go JSON, same field names). */
export interface WelcomeMessage {
  type: 'welcome';
  /** This boat's id in the room (the id other players see in their `boats`). */
  id: number;
  /** Token for `?resume=` on a reconnect. */
  resume: string;
  /** True when `?resume` re-attached the old boat; false for a new boat (also for an unknown or expired token). */
  resumed: boolean;
  seed: number;
  config: SimConfig;
  dt: number;
  tick: number;
  /** The boat at room time `tick * dt`: for a new boat, a spawn slot or the sailor code's last position; at rest after a resume. */
  state: BoatState;
  snapshotHz: number;
  /** The player's stored challenge progress; absent when challenges are unavailable (no ?player, or a server without -db). */
  challenges?: ChallengeStatus[];
}

/** One challenge's stored progress, as the server verified it. */
export interface ChallengeStatus {
  id: string;
  /** Steps reached (buoy names for the buoy tour), in the order recorded. */
  steps: string[];
  total: number;
  /** Unix ms; absent until complete. */
  completedAt?: number;
}

/** Progress after the server stored a newly reached step. */
export interface ChallengesMessage {
  type: 'challenges';
  challenges: ChallengeStatus[];
}

/** Another player's boat at the snapshot's tick: pose, applied controls and sail diagnostics. */
export interface RemoteBoat {
  id: number;
  x: number;
  z: number;
  heading: number;
  u: number;
  heel: number;
  pitch: number;
  boom: number;
  crewY: number;
  /** The clamped controls the server applied. */
  tiller: number;
  sheet: number;
  /** From the boat's last Diagnostics: apparent wind in the body frame, m/s, and sail state. */
  apparentU: number;
  apparentV: number;
  luffAmount: number;
  stallAmount: number;
}

/** Authoritative state after `tick` steps; `ackSeq` is the input applied on that tick (0 before any). */
export interface SnapshotMessage {
  type: 'snapshot';
  tick: number;
  ackSeq: number;
  state: BoatState;
  /** The clamped controls the server applied. */
  controls: Controls;
  /** Every other boat in the room on the same tick (never the receiver's own). An id that disappears has left. */
  boats: RemoteBoat[];
}

/** A client message the server rejected (the connection stays open), or "room full" before a close. */
export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type ServerMessage = WelcomeMessage | SnapshotMessage | ChallengesMessage | ErrorMessage;

/** One per client fixed step, `seq` increasing from 1. */
export interface InputMessage {
  type: 'input';
  seq: number;
  controls: Controls;
}

/** Boat back to a free spawn slot (heading 90°, 1 m/s). */
export interface ResetMessage {
  type: 'reset';
}

export type ClientMessage = InputMessage | ResetMessage;
