/**
 * Server mode: joins the Go server, which owns the seed, config and the authoritative boat. The page
 * keeps predicting with the TS sim; each snapshot corrects the prediction. Which server (or none) is
 * decided by `serverChoice`: the built site joins its own host, dev stays offline unless ?server.
 */
import { DEG, type BoatState, type Controls, type SimConfig } from '../sim';
import { NetClient, configFromWelcome, type NetStatus } from './client';
import { Corrector } from './correction';
import type { WelcomeMessage } from './protocol';

export class ServerLink {
  readonly corrector = new Corrector();

  constructor(
    readonly client: NetClient,
    readonly welcome: WelcomeMessage,
    readonly cfg: SimConfig,
  ) {}

  /** Folds the newest snapshot into `s` (mutated). True when `s` jumped (do not interpolate from before). */
  correct(s: BoatState): boolean {
    const snap = this.client.takeSnapshot();
    return snap !== null && this.corrector.apply(snap, s, this.client.nextSeq);
  }

  /** Sends one fixed step's controls and records `s`, the predicted state after them. */
  afterStep(s: BoatState, controls: Controls): void {
    this.corrector.afterStep(s, this.client.sendInput(controls), this.cfg.dt);
  }

  /** Restarts the server's boat; the caller restarts the local one. */
  reset(): void {
    this.client.sendReset();
    this.corrector.reset(this.client.nextSeq);
  }

  /** Debug overlay text. */
  describe(): string {
    const c = this.client;
    const snap = c.latest;
    const corr = this.corrector;
    const last = corr.last;
    const ms = (v: number): string => (Number.isNaN(v) ? '–' : `${v.toFixed(1)} ms`);
    return (
      `${c.url}  ${c.status}${c.status === 'disconnected' ? ` (${c.closeReason})` : ''}  seed ${this.welcome.seed}\n` +
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
  disconnected: 'disconnected from server: sailing on local prediction',
};
// TUNING GUESS: long enough for a slow phone connection, short enough that an unreachable server
// only delays the offline fallback a little.
const JOIN_TIMEOUT_MS = 5000;
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
 * Joins the server, showing a small status banner while connecting and after a disconnect. If it
 * cannot join (refused, closed or no welcome within JOIN_TIMEOUT_MS), says so briefly and returns
 * null: the page then sails offline.
 */
export async function joinServer(url: string): Promise<ServerLink | null> {
  const banner = document.createElement('div');
  banner.style.cssText =
    'position:fixed;top:8px;left:50%;transform:translateX(-50%);padding:4px 10px;z-index:20;' +
    'background:rgba(0,0,0,0.7);color:#e8e8e8;font:13px/1.35 ui-monospace,monospace;';
  document.body.appendChild(banner);
  const client = new NetClient(url);
  const show = (status: NetStatus): void => {
    const text = BANNER_TEXT[status];
    banner.textContent = text === null ? '' : `${text} (${url}${client.closeReason ? `, ${client.closeReason}` : ''})`;
    banner.style.display = text === null ? 'none' : '';
  };
  client.onStatus = show;
  show(client.status);
  const timer = setTimeout(() => client.close(`no answer within ${JOIN_TIMEOUT_MS / 1000} s`), JOIN_TIMEOUT_MS);
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
  } finally {
    clearTimeout(timer);
  }
}
