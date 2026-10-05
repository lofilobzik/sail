/** WebSocket client for the Go server: sends inputs, keeps the newest snapshot, measures round trips. */
import { browserConfig, setWaveLayers, setWaveParameters, setWaveWind, type Controls, type SimConfig } from '../sim';
import type { ClientMessage, ServerMessage, SnapshotMessage, WelcomeMessage } from './protocol';

export type NetStatus = 'connecting' | 'connected' | 'disconnected';

const RTT_SMOOTHING = 0.1; // exponential smoothing of the round-trip readout

export class NetClient {
  status: NetStatus = 'connecting';
  /** Why the socket closed, once disconnected. */
  closeReason = '';
  /** Round trip from sending an input to the first snapshot acking it, ms: last and smoothed. */
  rttMs = NaN;
  meanRttMs = NaN;
  /** Newest snapshot received (kept for display after it has been taken). */
  latest: SnapshotMessage | null = null;
  /** Fires on every status change. */
  onStatus: (status: NetStatus) => void = () => {};
  readonly welcome: Promise<WelcomeMessage>;

  private readonly ws: WebSocket;
  private untaken: SnapshotMessage | null = null;
  private seq = 0;
  private acked = 0;
  /** Send time of every unacked input, by seq (insertion order is seq order). */
  private readonly sentAt = new Map<number, number>();

  constructor(readonly url: string) {
    this.ws = new WebSocket(url);
    this.welcome = new Promise((resolve, reject) => {
      this.ws.addEventListener('message', (e) => {
        const msg = JSON.parse(String(e.data)) as ServerMessage;
        switch (msg.type) {
          case 'welcome':
            this.setStatus('connected');
            resolve(msg);
            break;
          case 'snapshot':
            this.receive(msg);
            break;
          case 'error':
            console.warn(`server rejected a message: ${msg.message}`);
            break;
        }
      });
      this.ws.addEventListener('close', (e) => {
        // A reason given to close() wins: a socket closed while connecting reports only code 1006.
        if (!this.closeReason) this.closeReason = e.reason || `code ${e.code}`;
        this.setStatus('disconnected');
        reject(new Error(`could not join ${url} (${this.closeReason})`));
      });
    });
  }

  /** Gives up on the server, e.g. when it never answers; `reason` is reported as the close reason. */
  close(reason: string): void {
    if (!this.closeReason) this.closeReason = reason;
    this.ws.close();
  }

  /** Seq the next input will carry. */
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

  private send(msg: ClientMessage): boolean {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private receive(s: SnapshotMessage): void {
    this.latest = this.untaken = s;
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
  return cfg;
}
