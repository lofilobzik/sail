/**
 * Server mode (?server=ws://host:port/ws, or a bare ?server for this site's own /ws): joins the Go
 * server, which owns the seed, config and the authoritative boat. The page keeps predicting with the
 * TS sim; each snapshot corrects the prediction.
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

/** The socket for `?server=<value>`: an explicit URL, or empty for the same host the page came from (wss on https). */
export function serverSocketUrl(param: string): string {
  if (param !== '') return param;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

/** Joins the server; shows a small status banner while connecting and after a disconnect. Throws if it cannot join. */
export async function connectToServer(url: string): Promise<ServerLink> {
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
  try {
    const welcome = await client.welcome;
    return new ServerLink(client, welcome, configFromWelcome(welcome));
  } catch (err) {
    banner.textContent = String(err);
    banner.style.display = '';
    throw err;
  }
}
