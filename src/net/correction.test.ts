import { describe, expect, it } from 'vitest';
import { BERTHS, NEUTRAL_CONTROLS, browserConfig, buildBoat, mooredAt, type BoatState } from '../sim';
import { Corrector } from './correction';
import type { SnapshotMessage } from './protocol';

const DT = 1 / 60;
const boat = buildBoat();
const cfg = browserConfig(1);

function snapshot(ackSeq: number, state: BoatState): SnapshotMessage {
  return { type: 'snapshot', tick: ackSeq, ackSeq, state: { ...state }, controls: { ...NEUTRAL_CONTROLS }, boats: [] };
}

describe('Corrector cast-off', () => {
  it('keeps a pending cast-off against older moored snapshots, then follows the server again', () => {
    const c = new Corrector();
    const s = mooredAt(BERTHS[0]!, boat, cfg);
    const recorded: BoatState[] = [];
    for (let seq = 1; seq <= 3; seq++) {
      c.afterStep(s, seq, DT);
      recorded[seq] = { ...s };
    }
    // Input 4 carries the cast-off: the prediction unmoors before stepping it.
    s.moored = false;
    c.afterStep(s, 4, DT);
    c.noteCastOff(4);
    recorded[4] = { ...s };

    // A snapshot from before the cast-off still says moored, and is far enough off to snap.
    expect(c.apply(snapshot(3, { ...recorded[3]!, x: recorded[3]!.x + 3 }), s, 5)).toBe(true);
    expect(c.last?.kind).toBe('snap');
    expect(s.moored).toBe(false);

    // The server applied the cast-off on input 4: no moored mismatch, so no snap.
    expect(c.apply(snapshot(4, { ...recorded[4]!, x: recorded[4]!.x + 3 }), s, 5)).toBe(false);
    expect(s.moored).toBe(false);

    // The pending cast-off is settled, so a later moored server state (e.g. a respawn) moors again.
    c.afterStep(s, 5, DT);
    expect(c.apply(snapshot(5, { ...s, moored: true }), s, 6)).toBe(true);
    expect(s.moored).toBe(true);
  });

  it('forgetCastOff lets the server re-moor a boat whose cast-off was never applied', () => {
    const c = new Corrector();
    const s = mooredAt(BERTHS[0]!, boat, cfg);
    c.afterStep(s, 1, DT);
    s.moored = false;
    c.afterStep(s, 2, DT);
    c.noteCastOff(2);
    // A resumed connection drops the queued cast-off; the server boat is still moored.
    c.forgetCastOff();
    c.resync(mooredAt(BERTHS[0]!, boat, cfg), s, 1);
    expect(s.moored).toBe(true);
  });
});
