/**
 * Server mode: joins the Go server's room, which owns the seed, the config and the authoritative
 * boats. The page keeps predicting its own boat with the Go wasm sim; each snapshot corrects the
 * prediction, and the other boats come with it (NetClient.remote). After a drop the client
 * reconnects with its resume token. Which server (or none) is decided by `serverChoice`: the built
 * site joins its own host, dev stays offline unless ?server.
 */
import { DEG, wrapPi } from '../sim/frames';
import type { BoatState, Controls, SimConfig } from '../physics/types';
import type { Physics } from '../physics/bridge';
import { NetClient, adoptServerConfig, configFromWelcome, type NetStatus } from './client';
import { Reconciler, OFFSET_TAU, SNAP_DISTANCE, SNAP_HEADING, ZERO_OFFSET } from './correction';
import type { ReconcileKind, RenderOffset } from './correction';
import type { WelcomeMessage } from './protocol';

/** The pose drawn last frame, including its remaining render-only correction. */
export type ShownPose = { x: number; z: number; heading: number };

/** What the server's news did to the predicted timeline this frame. */
export type SyncResult =
  | { kind: 'steady' }
  | { kind: 'respawned' }
  | { kind: 'moved'; prev: BoatState; curr: BoatState };

export class ServerLink {
  readonly reconciler: Reconciler;
  offset: RenderOffset = { ...ZERO_OFFSET };
  last: { kind: ReconcileKind; snap: boolean; position: number; heading: number } | null = null;
  readonly counts = { replay: 0, resync: 0, snap: 0 };
  /** The boat's known departure: the spawn of the newest new-boat welcome or reset. */
  spawn: BoatState;
  /** After a reset: the first snapshot acking this seq or later shows the new spawn. 0 when none is pending. */
  private respawnSeq = 0;

  constructor(
    readonly client: NetClient,
    /** The newest welcome. */
    public welcome: WelcomeMessage,
    readonly cfg: SimConfig,
    private readonly physics: Physics,
  ) {
    this.spawn = { ...welcome.state };
    this.reconciler = new Reconciler(physics);
  }

  /** Folds in a reconnect's welcome, then the newest snapshot, without mutating the old timeline. */
  sync(prev: BoatState, curr: BoatState, shown: ShownPose | null, alpha: number): SyncResult {
    const c = this.client;
    let moved = false;
    const w = c.takeRewelcome();
    if (w) {
      this.welcome = w;
      this.respawnSeq = 0;
      // The new connection cannot apply inputs queued on the old one.
      this.reconciler.reset(c.nextSeq);
      if (!w.resumed) {
        adoptServerConfig(this.cfg, w, this.physics);
        this.spawn = { ...w.state };
        this.offset = { ...ZERO_OFFSET };
        return { kind: 'respawned' };
      }
      prev = curr = w.state;
      this.correctVisuals(prev, curr, shown, alpha, 'resync');
      moved = true;
    }
    const snap = c.takeSnapshot();
    if (snap && this.respawnSeq && snap.ackSeq >= this.respawnSeq) {
      this.respawnSeq = 0;
      this.reconciler.reset(c.nextSeq);
      this.spawn = { ...snap.state };
      this.offset = { ...ZERO_OFFSET };
      return { kind: 'respawned' };
    }
    const timeline = snap ? this.reconciler.reconcile(snap, c.nextSeq - 1) : null;
    if (timeline) {
      prev = timeline.prev;
      curr = timeline.curr;
      this.correctVisuals(prev, curr, shown, alpha, this.reconciler.kind);
      moved = true;
    }
    return moved ? { kind: 'moved', prev, curr } : { kind: 'steady' };
  }

  /** Replace, rather than accumulate, the remaining correction against the last displayed pose. */
  private correctVisuals(prev: BoatState, curr: BoatState, shown: ShownPose | null, alpha: number, kind: ReconcileKind): void {
    const offset: RenderOffset = shown
      ? {
          dx: shown.x - (prev.x + (curr.x - prev.x) * alpha),
          dz: shown.z - (prev.z + (curr.z - prev.z) * alpha),
          dHeading: wrapPi(shown.heading - (prev.heading + wrapPi(curr.heading - prev.heading) * alpha)),
        }
      : { ...ZERO_OFFSET };
    const position = Math.hypot(offset.dx, offset.dz);
    const heading = Math.abs(offset.dHeading);
    const snap = position > SNAP_DISTANCE || heading > SNAP_HEADING;
    this.offset = snap ? { ...ZERO_OFFSET } : offset;
    this.last = { kind, snap, position, heading };
    this.counts[kind]++;
    if (snap) this.counts.snap++;
  }

  /** Exponential render-only easing, independent of the physics timestep. */
  decay(dt: number): void {
    const factor = Math.exp(-dt / OFFSET_TAU);
    this.offset.dx *= factor;
    this.offset.dz *= factor;
    this.offset.dHeading *= factor;
    if (Math.hypot(this.offset.dx, this.offset.dz) < 0.001 && Math.abs(this.offset.dHeading) < 0.001) {
      this.offset = { ...ZERO_OFFSET };
    }
  }

  /** Sends one fixed step's controls (and cast-off, if this step releases the boat) and records `s`, the predicted state after them. */
  afterStep(s: BoatState, applied: Controls, castOff: boolean): void {
    const seq = this.client.sendInput(applied, castOff);
    this.reconciler.record(seq, applied, castOff, s);
  }

  /**
   * Respawns the server's boat at a free berth (else a spawn slot). The local boat sails on until the first snapshot
   * after the reset, which `sync` reports as 'respawned'.
   */
  reset(): void {
    this.client.sendReset();
    this.respawnSeq = this.client.nextSeq;
    this.reconciler.reset(this.respawnSeq);
  }

  /** Debug overlay text. */
  describe(): string {
    const c = this.client;
    const snap = c.latest;
    const last = this.last;
    const ms = (v: number): string => (Number.isNaN(v) ? '–' : `${v.toFixed(1)} ms`);
    return (
      `${c.url}  ${c.status}${c.status === 'connected' ? '' : ` (${c.closeReason})`}  seed ${this.welcome.seed}\n` +
      `own id ${c.id}  room boats ${c.status === 'connected' ? c.remote.size + 1 : '–'}  reconnect attempts ${c.totalAttempts}\n` +
      `RTT ${ms(c.rttMs)} (mean ${ms(c.meanRttMs)})\n` +
      (snap
        ? `server tick ${snap.tick}  ack ${snap.ackSeq}  sent ${c.nextSeq - 1}\n` +
          `server controls tiller ${snap.controls.tiller.toFixed(2)}  sheet ${snap.controls.sheet.toFixed(2)}  hike ${snap.controls.hike.toFixed(2)}\n`
        : 'no snapshot yet\n') +
      (last
        ? `last correction ${last.kind}${last.snap ? ' snap' : ''} ${(last.position * 100).toFixed(1)} cm  ${(last.heading / DEG).toFixed(2)}°\n`
        : 'no correction yet\n') +
      `replays ${this.counts.replay}  resyncs ${this.counts.resync}  snaps ${this.counts.snap}`
    );
  }
}

const BANNER_TEXT: Record<NetStatus, string | null> = {
  connecting: 'connecting…',
  connected: null,
  reconnecting: 'reconnecting…',
  disconnected: 'disconnected from server: sailing on local prediction',
};
const FALLBACK_BANNER_MS = 6000; // how long the "sailing offline" note stays up

/**
 * Which server this page load joins, or null to sail offline. `?offline` always sails locally;
 * `?server=<ws url>` joins that server and a bare `?server` this site's own /ws. Otherwise the
 * built site (dinghysail.ing) joins its own host, and the dev server stays offline.
 */
export function serverChoice(params: URLSearchParams, built: boolean): string | null {
  if (params.has('offline')) return null;
  const param = params.get('server');
  if (param !== null) return serverSocketUrl(param);
  return built ? serverSocketUrl('') : null;
}

/** The socket for `?server=<value>`: an explicit URL, or empty for the same host the page came from (wss on https). */
function serverSocketUrl(param: string): string {
  if (param !== '') return param;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

/**
 * Joins the server, showing a small status banner while connecting, reconnecting and after a
 * disconnect. If the first join fails (refused, closed or no welcome within CONNECT_TIMEOUT_MS),
 * says so briefly and returns null: the page then sails offline.
 */
export async function joinServer(url: string, player: string, physics: Physics): Promise<ServerLink | null> {
  const banner = document.createElement('div');
  banner.style.cssText =
    'position:fixed;top:8px;left:50%;transform:translateX(-50%);padding:4px 10px;z-index:20;' +
    'background:rgba(0,0,0,0.7);color:#e8e8e8;font:13px/1.35 ui-monospace,monospace;';
  document.body.appendChild(banner);
  const client = new NetClient(url, player);
  const show = (status: NetStatus): void => {
    if (client.replaced) {
      banner.textContent = 'your boat is sailing in another tab or browser: reload this page to take it back';
      banner.style.display = '';
      return;
    }
    const text = BANNER_TEXT[status];
    const attempt = status === 'reconnecting' ? `attempt ${client.attempt}, ` : '';
    banner.textContent = text === null ? '' : `${text} (${attempt}${url}${client.closeReason ? `, ${client.closeReason}` : ''})`;
    banner.style.display = text === null ? 'none' : '';
  };
  client.onStatus = show;
  show(client.status);
  try {
    const welcome = await client.welcome;
    return new ServerLink(client, welcome, configFromWelcome(welcome, physics), physics);
  } catch (err) {
    console.warn(err);
    client.onStatus = () => {};
    banner.textContent = `could not reach the server (${client.closeReason}): sailing offline`;
    banner.style.display = '';
    setTimeout(() => banner.remove(), FALLBACK_BANNER_MS);
    return null;
  }
}
