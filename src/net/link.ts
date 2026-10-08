/**
 * Server mode: joins the Go server's room, which owns the seed, the config and the authoritative
 * boats. The page keeps predicting its own boat with the TS sim; each snapshot corrects the
 * prediction, and the other boats come with it (NetClient.remote). After a drop the client
 * reconnects with its resume token. Which server (or none) is decided by `serverChoice`: the built
 * site joins its own host, dev stays offline unless ?server.
 */
import { DEG, type BoatState, type Controls, type SimConfig } from '../sim';
import { NetClient, adoptServerConfig, configFromWelcome, type NetStatus } from './client';
import { Corrector } from './correction';
import type { WelcomeMessage } from './protocol';

/** What the server's news did to the predicted boat this frame. */
export type Sync =
  | 'steady'
  /** The state jumped (a snap or a resync, e.g. a resumed boat): do not interpolate from before. */
  | 'jumped'
  /** A new boat (a fresh welcome or a reset): restart the boat and navigation from `spawn`. */
  | 'respawned';

export class ServerLink {
  readonly corrector = new Corrector();
  /** The boat's known departure: the spawn of the newest new-boat welcome or reset. */
  spawn: BoatState;
  /** After a reset: the first snapshot acking this seq or later shows the new spawn. 0 when none is pending. */
  private respawnSeq = 0;

  constructor(
    readonly client: NetClient,
    /** The newest welcome. */
    public welcome: WelcomeMessage,
    readonly cfg: SimConfig,
  ) {
    this.spawn = { ...welcome.state };
  }

  /**
   * Folds in what the server sent since the last frame: a reconnect's welcome, then the newest
   * snapshot. `s` is corrected in place, except on 'respawned', where the caller restarts from `spawn`.
   */
  sync(s: BoatState): Sync {
    const c = this.client;
    const w = c.takeRewelcome();
    if (w) {
      this.welcome = w;
      this.respawnSeq = 0;
      if (!w.resumed) {
        // A new boat, maybe in a restarted server's new world: adopt its config too.
        adoptServerConfig(this.cfg, w);
        this.corrector.reset(c.nextSeq);
        this.spawn = { ...w.state };
        return 'respawned';
      }
      this.corrector.resync(w.state, s, c.nextSeq);
    }
    const snap = c.takeSnapshot();
    if (snap && this.respawnSeq && snap.ackSeq >= this.respawnSeq) {
      this.respawnSeq = 0;
      this.corrector.reset(c.nextSeq);
      this.spawn = { ...snap.state };
      return 'respawned';
    }
    const jumped = snap !== null && this.corrector.apply(snap, s, c.nextSeq);
    return w || jumped ? 'jumped' : 'steady';
  }

  /** Sends one fixed step's controls and records `s`, the predicted state after them. */
  afterStep(s: BoatState, controls: Controls): void {
    this.corrector.afterStep(s, this.client.sendInput(controls), this.cfg.dt);
  }

  /**
   * Respawns the server's boat at a free slot. The local boat sails on until the first snapshot
   * after the reset, which `sync` reports as 'respawned'.
   */
  reset(): void {
    this.client.sendReset();
    this.respawnSeq = this.client.nextSeq;
    this.corrector.reset(this.respawnSeq);
  }

  /** Debug overlay text. */
  describe(): string {
    const c = this.client;
    const snap = c.latest;
    const corr = this.corrector;
    const last = corr.last;
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
        ? `last correction ${last.kind} ${(last.position * 100).toFixed(1)} cm  ${(last.heading / DEG).toFixed(2)}°  (blend mean ${(corr.meanPosition * 100).toFixed(1)} cm)\n`
        : 'no correction yet\n') +
      `blends ${corr.counts.blend}  snaps ${corr.counts.snap}  resyncs ${corr.counts.resync}`
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
export async function joinServer(url: string, player: string): Promise<ServerLink | null> {
  const banner = document.createElement('div');
  banner.style.cssText =
    'position:fixed;top:8px;left:50%;transform:translateX(-50%);padding:4px 10px;z-index:20;' +
    'background:rgba(0,0,0,0.7);color:#e8e8e8;font:13px/1.35 ui-monospace,monospace;';
  document.body.appendChild(banner);
  const client = new NetClient(url, player);
  const show = (status: NetStatus): void => {
    const text = BANNER_TEXT[status];
    const attempt = status === 'reconnecting' ? `attempt ${client.attempt}, ` : '';
    banner.textContent = text === null ? '' : `${text} (${attempt}${url}${client.closeReason ? `, ${client.closeReason}` : ''})`;
    banner.style.display = text === null ? 'none' : '';
  };
  client.onStatus = show;
  show(client.status);
  try {
    const welcome = await client.welcome;
    return new ServerLink(client, welcome, configFromWelcome(welcome));
  } catch (err) {
    console.warn(err);
    client.onStatus = () => {};
    banner.textContent = `could not reach the server (${client.closeReason}): sailing offline`;
    banner.style.display = '';
    setTimeout(() => banner.remove(), FALLBACK_BANNER_MS);
    return null;
  }
}
