/**
 * WebSocket client for the Go server: sends inputs, keeps the newest snapshot, buffers the other
 * boats, measures round trips, and reconnects with the resume token after a drop.
 */
import { browserConfig, setWaveLayers, setWaveParameters, setWaveWind, type Controls, type SimConfig } from '../sim';
import { mergeChallenges } from './challenges';
import type { ChallengeStatus, ClientMessage, ServerMessage, SnapshotMessage, WelcomeMessage } from './protocol';
import { RemoteFleet } from './remote';

export type NetStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

const RTT_SMOOTHING = 0.1; // exponential smoothing of the round-trip readout
// TUNING GUESS: long enough for a slow phone connection, short enough that an unreachable server
// only delays the offline fallback (or the next reconnect attempt) a little.
const CONNECT_TIMEOUT_MS = 5000;
// TUNING GUESS: 60 snapshots missed. A connection that went quiet without closing (a network change,
// a sleeping laptop) is given up after this and the client reconnects instead of waiting for TCP.
const SILENCE_TIMEOUT_MS = 3000;
/** Wait before each reconnect attempt, ms; the last repeats. */
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 10000];
/** Close code the server uses when another connection resumed this boat: do not take it back. */
const CLOSE_REPLACED = 4000;

export class NetClient {
  status: NetStatus = 'connecting';
  /** Why the last socket closed. */
  closeReason = '';
  /** Round trip from sending an input to the first snapshot acking it, ms: last and smoothed. */
  rttMs = NaN;
  meanRttMs = NaN;
  /** Newest snapshot received (kept for display after it has been taken). */
  latest: SnapshotMessage | null = null;
  /** Our boat's id in the room; NaN before the first welcome. */
  id = NaN;
  /** Reconnect attempts: since the last welcome, and in total. */
  attempt = 0;
  totalAttempts = 0;
  /** The other boats in the room, from every snapshot; cleared on a disconnect. */
  readonly remote = new RemoteFleet();
  /** Fires on every status change and reconnect attempt. */
  onStatus: (status: NetStatus) => void = () => {};
  /** Challenge progress, merged from every welcome and challenges frame; null until the server sends any. */
  challenges: ChallengeStatus[] | null = null;
  /** Fires when `challenges` changes (also on the first arrival). */
  onChallenges: (challenges: ChallengeStatus[]) => void = () => {};
  /** The first welcome; rejected if the first connection closes before it. */
  readonly welcome: Promise<WelcomeMessage>;

  private ws!: WebSocket;
  private welcomed = false;
  private resume = '';
  private dt = NaN;
  private rewelcome: WelcomeMessage | null = null;
  private untaken: SnapshotMessage | null = null;
  private seq = 0;
  private acked = 0;
  /** Send time of every unacked input, by seq (insertion order is seq order). */
  private readonly sentAt = new Map<number, number>();
  private resolveWelcome!: (w: WelcomeMessage) => void;
  private rejectWelcome!: (err: Error) => void;
  /** The page is going away (or into the back/forward cache): do not reconnect until it comes back. */
  private leaving = false;

  constructor(
    readonly url: string,
    /** Sailor code sent as ?player= on every connect. */
    private readonly player: string,
  ) {
    const { promise, resolve, reject } = Promise.withResolvers<WelcomeMessage>();
    this.welcome = promise;
    this.resolveWelcome = resolve;
    this.rejectWelcome = reject;
    // Leave the room at once when the page goes; otherwise a page kept in the back/forward cache
    // can hold its socket open, and the boat stays visible to others until the server notices.
    window.addEventListener('pagehide', () => {
      this.leaving = true;
      this.ws.close(1000, 'page closed');
    });
    window.addEventListener('pageshow', (e) => {
      if (!e.persisted || !this.leaving) return;
      this.leaving = false;
      this.open();
    });
    this.open();
  }

  /** Seq the next input will carry. Seqs keep increasing across reconnects. */
  get nextSeq(): number {
    return this.seq + 1;
  }

  /** Sends one fixed step's controls; returns its seq. Inputs while disconnected are numbered but dropped. */
  sendInput(controls: Controls): number {
    const seq = ++this.seq;
    if (this.send({ type: 'input', seq, controls })) this.sentAt.set(seq, performance.now());
    return seq;
  }

  sendReset(): void {
    this.send({ type: 'reset' });
  }

  /** The newest snapshot not yet taken, or null. Older untaken snapshots are superseded. */
  takeSnapshot(): SnapshotMessage | null {
    const s = this.untaken;
    this.untaken = null;
    return s;
  }

  /** The welcome of a reconnect not yet taken, or null. */
  takeRewelcome(): WelcomeMessage | null {
    const w = this.rewelcome;
    this.rewelcome = null;
    return w;
  }

  /** Opens a socket: the first join, or a reconnect carrying the resume token. */
  private open(): void {
    const u = new URL(this.url);
    u.searchParams.set('player', this.player);
    if (this.resume) u.searchParams.set('resume', this.resume);
    const ws = new WebSocket(u.toString());
    this.ws = ws;
    let ended = false;
    let watchdog = 0;
    // Ends this socket once (closed by the server, the network, or the watchdog) and decides what next.
    const end = (reason: string, code: number): void => {
      if (ended) return;
      ended = true;
      clearTimeout(watchdog);
      ws.close();
      this.closeReason = reason;
      this.untaken = null;
      this.sentAt.clear();
      this.remote.clear();
      if (!this.welcomed) {
        this.setStatus('disconnected');
        this.rejectWelcome(new Error(`could not join ${this.url} (${reason})`));
      } else if (code === CLOSE_REPLACED || this.leaving) {
        this.setStatus('disconnected');
      } else {
        const delay = RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)]!;
        this.attempt++;
        this.totalAttempts++;
        this.setStatus('reconnecting');
        setTimeout(() => this.open(), delay);
      }
    };
    const arm = (ms: number, reason: string): void => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => end(reason, 0), ms);
    };
    arm(CONNECT_TIMEOUT_MS, `no answer within ${CONNECT_TIMEOUT_MS / 1000} s`);
    ws.addEventListener('message', (e) => {
      if (ended) return;
      arm(SILENCE_TIMEOUT_MS, `no data for ${SILENCE_TIMEOUT_MS / 1000} s`);
      const msg = JSON.parse(String(e.data)) as ServerMessage;
      switch (msg.type) {
        case 'welcome':
          this.id = msg.id;
          this.resume = msg.resume;
          this.dt = msg.dt;
          this.attempt = 0;
          if (this.welcomed) this.rewelcome = msg;
          this.welcomed = true;
          this.setStatus('connected');
          this.resolveWelcome(msg);
          if (msg.challenges) this.takeChallenges(msg.challenges);
          break;
        case 'challenges':
          this.takeChallenges(msg.challenges);
          break;
        case 'snapshot':
          this.receive(msg);
          break;
        case 'error':
          console.warn(`server: ${msg.message}`);
          break;
      }
    });
    // A socket closed while connecting reports only code 1006.
    ws.addEventListener('close', (e) => end(e.reason || `code ${e.code}`, e.code));
  }

  private takeChallenges(incoming: ChallengeStatus[]): void {
    const merged = this.challenges ? mergeChallenges(this.challenges, incoming) : incoming;
    if (this.challenges && JSON.stringify(merged) === JSON.stringify(this.challenges)) return;
    this.challenges = merged;
    this.onChallenges(merged);
  }

  private send(msg: ClientMessage): boolean {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private receive(s: SnapshotMessage): void {
    this.latest = this.untaken = s;
    this.remote.receive(s.tick * this.dt, s.boats, performance.now() / 1000);
    if (s.ackSeq <= this.acked) return;
    this.acked = s.ackSeq;
    const sent = this.sentAt.get(s.ackSeq);
    if (sent !== undefined) {
      this.rttMs = performance.now() - sent;
      this.meanRttMs = Number.isNaN(this.meanRttMs) ? this.rttMs : this.meanRttMs + (this.rttMs - this.meanRttMs) * RTT_SMOOTHING;
    }
    for (const seq of this.sentAt.keys()) {
      if (seq > s.ackSeq) break;
      this.sentAt.delete(seq);
    }
  }

  private setStatus(status: NetStatus): void {
    this.status = status;
    this.onStatus(status);
  }
}

/**
 * The client's sim config: browserConfig(seed) with the server's settings copied over, so the
 * prediction runs the same world. Wave components are recompiled locally from the copied settings.
 */
export function configFromWelcome(w: WelcomeMessage): SimConfig {
  const cfg = browserConfig(w.seed);
  adoptServerConfig(cfg, w);
  return cfg;
}

/**
 * Copies the server's settings into `cfg` in place (every seeded part included), so a reconnect to
 * a restarted server, with a new seed, changes the world the page already draws.
 */
export function adoptServerConfig(cfg: SimConfig, w: WelcomeMessage): void {
  const s = w.config;
  Object.assign(cfg.layers, s.layers);
  Object.assign(cfg.terms, s.terms);
  Object.assign(cfg.models, s.models);
  Object.assign(cfg.env, s.env);
  cfg.wind.speedKn = s.wind.speedKn;
  cfg.wind.fromDeg = s.wind.fromDeg;
  if (s.wind.gusts) cfg.wind.gusts = { ...s.wind.gusts };
  else delete cfg.wind.gusts;
  cfg.land = s.land;
  cfg.dt = w.dt;
  cfg.substeps = s.substeps;
  const waves = cfg.waves;
  waves.enabled = s.waves.enabled;
  waves.amplitudeScale = s.waves.amplitudeScale;
  waves.seed = s.waves.seed;
  setWaveWind(waves, s.waves.windSpeedKn);
  setWaveLayers(waves, s.waves.bigScale, s.waves.rippleScale);
  setWaveParameters(waves, s.waves.periodSeconds, s.waves.directionDeg);
}
