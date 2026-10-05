/**
 * WebSocket protocol shared with the Go server (server/netsim/protocol.go). JSON text frames on /ws.
 * The server owns the seed, the config and the boat; the client predicts with the TS sim.
 */
import type { BoatState, Controls, SimConfig } from '../sim';

/** Sent once on connect. `config` is the SimConfig as the server runs it (Go JSON, same field names). */
export interface WelcomeMessage {
  type: 'welcome';
  seed: number;
  config: SimConfig;
  dt: number;
  tick: number;
  state: BoatState;
  snapshotHz: number;
}

/** Authoritative state after `tick` steps; `ackSeq` is the input applied on that tick (0 before any). */
export interface SnapshotMessage {
  type: 'snapshot';
  tick: number;
  ackSeq: number;
  state: BoatState;
  /** The clamped controls the server applied. */
  controls: Controls;
}

/** A client message the server rejected; the connection stays open. */
export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type ServerMessage = WelcomeMessage | SnapshotMessage | ErrorMessage;

/** One per client fixed step, `seq` increasing from 1. */
export interface InputMessage {
  type: 'input';
  seq: number;
  controls: Controls;
}

/** Boat back to the start (heading 90°, 1 m/s). */
export interface ResetMessage {
  type: 'reset';
}

export type ClientMessage = InputMessage | ResetMessage;
