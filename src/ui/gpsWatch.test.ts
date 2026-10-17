import { describe, expect, it } from 'vitest';
import { KNOT } from '../sim/frames';
import { WatchReadout, type WatchFace } from './gpsWatch';

/** Feeds `knots` for `seconds` at 60 fps; returns every face shown. */
function run(watch: WatchReadout, knots: number, seconds: number): WatchFace[] {
  const faces: WatchFace[] = [];
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    const face = watch.step(knots * KNOT, 1 / 60);
    if (face) faces.push(face);
  }
  return faces;
}

describe('GPS watch readout', () => {
  it('ticks once a second and settles on the speed without jitter', () => {
    const watch = new WatchReadout();
    const faces = run(watch, 5, 20);
    expect(faces.length).toBeGreaterThanOrEqual(19);
    expect(faces.length).toBeLessThanOrEqual(21);
    expect(faces.at(-1)!.knots).toBe(5);
    // Noisy input at a steady mean: the shown tenth barely moves.
    const noisy = new WatchReadout();
    run(noisy, 4, 15);
    const shown: number[] = [];
    for (let i = 0; i < 10 * 60; i++) {
      const face = noisy.step((4 + (i % 2 ? 0.6 : -0.6)) * KNOT, 1 / 60);
      if (face) shown.push(face.knots);
    }
    expect(Math.max(...shown) - Math.min(...shown)).toBeLessThanOrEqual(0.1);
  });

  it('points the trend up while gaining, down while losing and flat when steady', () => {
    const watch = new WatchReadout();
    run(watch, 3, 15);
    expect(run(watch, 3, 4).at(-1)!.trend).toBe('steady');
    expect(run(watch, 6, 2).at(-1)!.trend).toBe('up');
    run(watch, 6, 15);
    expect(run(watch, 2, 2).at(-1)!.trend).toBe('down');
  });

  it('keeps the session best, and flashes only when a best that stood a while is beaten', () => {
    const watch = new WatchReadout();
    const climbing = run(watch, 5, 15);
    expect(climbing.some((f) => f.record)).toBe(false); // rising from rest: no flash every tick
    expect(climbing.at(-1)!.best).toBe(5);
    run(watch, 3, 20);
    expect(run(watch, 3, 1).at(-1)!.best).toBe(5); // slower now: the best stays
    const beaten = run(watch, 6, 10);
    expect(beaten.filter((f) => f.record)).toHaveLength(1);
    expect(beaten.at(-1)!.best).toBe(6);
  });
});
