import { describe, expect, it } from 'vitest';
import { INTERP_DELAY, RemoteFleet } from './remote';
import type { RemoteBoat } from './protocol';

const DT = 0.05; // 20 Hz snapshots

function boat(id: number, fields: Partial<RemoteBoat> = {}): RemoteBoat {
  return {
    id, x: 0, z: 0, heading: 0, u: 0, heel: 0, pitch: 0, boom: 0, crewY: 0, tiller: 0, sheet: 0,
    apparentU: 0, apparentV: 0, luffAmount: 0, stallAmount: 0, ...fields,
  };
}

/** Snapshots arriving exactly on time: server time t arrives at local time t + 1 (offset -1). */
function arrive(fleet: RemoteFleet, t: number, boats: RemoteBoat[]): void {
  fleet.receive(t, boats, t + 1);
}

describe('RemoteFleet', () => {
  it('interpolates INTERP_DELAY in the past', () => {
    const fleet = new RemoteFleet();
    for (let i = 0; i <= 4; i++) arrive(fleet, i * DT, [boat(7, { x: i * DT * 10 })]);
    // Local 1 + 0.15 shows server 0.15 - INTERP_DELAY = 0.05: x = 0.5.
    expect(fleet.sample(1 + 0.15).get(7)!.x).toBeCloseTo((0.15 - INTERP_DELAY) * 10, 9);
    expect(fleet.sample(1 + 0.175).get(7)!.x).toBeCloseTo((0.175 - INTERP_DELAY) * 10, 9);
  });

  it('turns the short way across ±180°', () => {
    const fleet = new RemoteFleet();
    arrive(fleet, 0, [boat(1, { heading: Math.PI - 0.1 })]);
    arrive(fleet, DT, [boat(1, { heading: -Math.PI + 0.1 })]);
    const h = fleet.sample(1 + INTERP_DELAY + DT / 2).get(1)!.heading;
    // Halfway through a 0.2 rad turn through 180°, not a 6 rad swing through 0°.
    expect(Math.abs(Math.cos(h) - Math.cos(Math.PI))).toBeLessThan(1e-9);
  });

  it('holds the last pose when starved, then interpolates across the gap', () => {
    const fleet = new RemoteFleet();
    arrive(fleet, 0, [boat(1, { x: 0 })]);
    arrive(fleet, DT, [boat(1, { x: 1 })]);
    // Long after the last snapshot: held, not extrapolated.
    expect(fleet.sample(1 + 0.5).get(1)!.x).toBe(1);
    // The snapshots resume after a 0.45 s gap; the render time is still inside it.
    arrive(fleet, 0.5, [boat(1, { x: 10 })]);
    arrive(fleet, 0.55, [boat(1, { x: 11 })]);
    expect(fleet.sample(1 + 0.375 + INTERP_DELAY).get(1)!.x).toBeCloseTo(1 + 9 * (0.375 - DT) / 0.45, 9);
  });

  it('holds the first pose before its time and drops repeated ticks', () => {
    const fleet = new RemoteFleet();
    arrive(fleet, 1, [boat(1, { x: 5 })]);
    expect(fleet.sample(1).get(1)!.x).toBe(5);
    arrive(fleet, 1, [boat(1, { x: 99 })]);
    expect(fleet.sample(2 + INTERP_DELAY).get(1)!.x).toBe(5);
  });

  it('adds a boat on its first snapshot and removes it when it is absent', () => {
    const fleet = new RemoteFleet();
    arrive(fleet, 0, [boat(1)]);
    arrive(fleet, DT, [boat(1), boat(2, { x: 3 })]);
    expect([...fleet.sample(1 + DT).keys()]).toEqual([1, 2]);
    expect(fleet.sample(1 + DT).get(2)!.x).toBe(3);
    arrive(fleet, 2 * DT, [boat(2, { x: 3 })]);
    expect(fleet.size).toBe(1);
    expect(fleet.sample(1 + 2 * DT).has(1)).toBe(false);
    // Rejoining starts a new track, not an interpolation from the old one.
    arrive(fleet, 3 * DT, [boat(1, { x: 50 }), boat(2)]);
    expect(fleet.sample(1 + 3 * DT).get(1)!.x).toBe(50);
  });

  it('smooths arrival jitter and adopts a large clock jump at once', () => {
    const fleet = new RemoteFleet();
    arrive(fleet, 0, []);
    expect(fleet.offset).toBe(-1);
    fleet.receive(DT, [], DT + 1 + 0.04); // 40 ms late
    expect(fleet.offset).toBeGreaterThan(-1.01);
    expect(fleet.offset).toBeLessThan(-1);
    fleet.receive(0, [], 10); // the server restarted its clock: far beyond CLOCK_SNAP
    expect(fleet.offset).toBe(-10);
  });

  it('forgets boats and the clock on clear', () => {
    const fleet = new RemoteFleet();
    arrive(fleet, 0, [boat(1)]);
    fleet.clear();
    expect(fleet.size).toBe(0);
    expect(fleet.offset).toBeNaN();
  });
});
