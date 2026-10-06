import { describe, expect, it } from 'vitest';
import { DEG, worldToBearing } from '../sim/frames';
import { NAV_MARKS, NAVIGATION, Navigation, graduatedBearing, lineIntersection, positionLine, solveFix, type FixContext, type Observation } from './navigation';

const at = (x = 0, z = 0, t = 0, velocity: FixContext['velocity'] = null): FixContext => ({ position: { x, z }, t, velocity });
function note(id: number, markId: string, from = { x: 0, z: 0 }, t = 0): Observation {
  const mark = NAV_MARKS.find((m) => m.name === markId)!;
  return { id, markId, bearing: worldToBearing(mark.x - from.x, mark.z - from.z), t };
}

/** Step the navigation model through simulated time. */
function run(nav: Navigation, seconds: number, speed = 2, dt = 0.1): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) nav.advance({ t: nav.t + dt, speed }, dt);
}

/** Take a complete bearing reading while aiming steadily. */
function sight(nav: Navigation, bearing: number): void {
  nav.setAim(bearing);
  nav.beginReading('bearing');
  run(nav, NAVIGATION.timing.bearingRead + 0.2);
  nav.setAim(null);
}

/** Hold the compass on a bearing that moves at `rate` rad/s, updating the aim every step like a camera frame. */
function track(nav: Navigation, start: number, rate: number, seconds: number, dt = 0.1): void {
  const t0 = nav.t;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    nav.setAim(start + rate * (nav.t + dt - t0));
    nav.advance({ t: nav.t + dt, speed: 2 }, dt);
  }
}

describe('timed readings', () => {
  it('shows no motion estimate until course and speed have been read', () => {
    const nav = new Navigation();
    run(nav, 30);
    expect(nav.velocity).toBeNull();
    expect(nav.plotted).toMatchObject({ x: 0, z: 0, t: 0 });
  });

  it('takes the wake reading only after it has been watched long enough, and remembers its time', () => {
    const nav = new Navigation();
    nav.setAstern(true);
    nav.beginReading('speed');
    run(nav, NAVIGATION.timing.speedRead - 0.5, 2.5);
    expect(nav.speed).toBeNull();
    expect(nav.progress).toBeGreaterThan(0.5);
    run(nav, 1, 2.5);
    expect(nav.speed?.value).toBe(2.5);
    expect(nav.speed?.t).toBeGreaterThan(NAVIGATION.timing.speedRead - 0.5);
    expect(nav.task).toBeNull();
  });

  it('only judges the wake while looking astern, and the ring starts over when the sailor turns away', () => {
    const nav = new Navigation();
    nav.beginReading('speed');
    run(nav, 5, 2);
    expect(nav.speed).toBeNull();
    expect(nav.task!.elapsed).toBe(0);
    nav.setAstern(true);
    run(nav, 1, 2);
    nav.setAstern(false);
    run(nav, 1, 2);
    expect(nav.task!.elapsed).toBe(0);
    nav.setAstern(true);
    run(nav, NAVIGATION.timing.speedRead + 0.2, 2);
    expect(nav.speed?.value).toBe(2);
  });

  it('calls a remembered speed old after a couple of minutes', () => {
    const nav = new Navigation();
    nav.setAstern(true);
    nav.beginReading('speed');
    run(nav, NAVIGATION.timing.speedRead + 0.2, 2);
    expect(nav.speedStale).toBe(false);
    run(nav, NAVIGATION.speedStaleSeconds + 1, 2);
    expect(nav.speedStale).toBe(true);
  });

  it('records the bearing in view at the end of a steady hold', () => {
    const nav = new Navigation();
    sight(nav, 40 * DEG);
    expect(nav.observations).toHaveLength(1);
    expect(nav.observations[0]!.bearing / DEG).toBeCloseTo(40, 6);
  });

  it('restarts when the compass sweeps off the mark or points at nothing, and a released hold records nothing', () => {
    const nav = new Navigation();
    nav.beginReading('bearing');
    track(nav, 10 * DEG, 0, 2);
    track(nav, 10 * DEG + 12 * DEG, 0, 0.1); // 12 degrees in one step: a sweep, not a hold
    expect(nav.task!.elapsed).toBeLessThan(0.5);
    nav.setAim(null);
    run(nav, 5);
    expect(nav.task!.elapsed).toBe(0);
    nav.cancelReading();
    expect(nav.observations).toHaveLength(0);
    expect(nav.task).toBeNull();
  });

  it('lets a slow track on a mark finish and records its recent mean direction', () => {
    const nav = new Navigation();
    const rate = 3 * DEG; // the boat is swinging and the eye follows the buoy: the mean moves with it
    nav.beginReading('bearing');
    track(nav, 100 * DEG, rate, NAVIGATION.timing.bearingRead + 0.1);
    expect(nav.observations).toHaveLength(1);
    const finished = NAVIGATION.timing.bearingRead;
    const expected = 100 + (rate / DEG) * (finished - NAVIGATION.aimAverageSeconds / 2);
    expect(Math.abs(nav.observations[0]!.bearing / DEG - expected)).toBeLessThan(1);
  });

  it('averages out the rocking of the boat in waves', () => {
    const nav = new Navigation();
    nav.beginReading('bearing');
    const steps = Math.round((NAVIGATION.timing.bearingRead + 0.1) / 0.1);
    for (let i = 1; i <= steps; i++) {
      nav.setAim((60 + 5 * Math.sin(2 * Math.PI * i * 0.1 / 1.5)) * DEG);
      nav.advance({ t: nav.t + 0.1, speed: 2 }, 0.1);
    }
    expect(nav.observations).toHaveLength(1);
    expect(Math.abs(nav.observations[0]!.bearing / DEG - 60)).toBeLessThan(3);
  });

  it('tracks smoothly across north', () => {
    const nav = new Navigation();
    nav.beginReading('bearing');
    track(nav, 358 * DEG, 2 * DEG, NAVIGATION.timing.bearingRead + 0.1);
    expect(nav.observations).toHaveLength(1);
    const bearing = nav.observations[0]!.bearing / DEG;
    expect(Math.min(bearing, 360 - bearing)).toBeLessThan(6);
  });

  /** One hold on a steady 50 degree bearing, with the crosshair on `markAt(step)` and the bow on `bowAt(step)`. */
  function holdWith(nav: Navigation, markAt: (i: number) => string | null, bowAt: (i: number) => boolean = () => false): void {
    nav.beginReading('bearing');
    const steps = Math.round((NAVIGATION.timing.bearingRead + 0.1) / 0.1);
    for (let i = 1; i <= steps; i++) {
      nav.setAim(50 * DEG);
      nav.setAimedMark(markAt(i));
      nav.setAimedBow(bowAt(i));
      nav.advance({ t: nav.t + 0.1, speed: 2 }, 0.1);
    }
  }

  it('names the mark under the crosshair as the eye reads it, while the bearing stays the compass\'s', () => {
    const nav = new Navigation();
    holdWith(nav, () => 'NE');
    expect(nav.observations[0]!.markId).toBe('NE');
    expect(nav.observations[0]!.bearing / DEG).toBeCloseTo(50, 6);
  });

  it('forgives the rocking boat taking the crosshair off the mark for part of the hold', () => {
    const nav = new Navigation();
    holdWith(nav, (i) => (i % 5 < 3 ? 'E' : i % 5 === 3 ? 'N' : null)); // E 60%, N 20%, nothing 20%
    expect(nav.observations[0]!.markId).toBe('E');
  });

  it('names nothing when the crosshair was on a mark for too little of the hold', () => {
    const nav = new Navigation();
    holdWith(nav, (i) => (i % 10 === 0 ? 'E' : null));
    expect(nav.observations).toHaveLength(1);
    expect(nav.observations[0]!.markId).toBeNull();
  });

  it('takes a bow bearing as the remembered course, ahead of any mark in line, and leaves no note', () => {
    const nav = new Navigation();
    holdWith(nav, () => 'N', () => true);
    expect(nav.course?.value).toBeCloseTo(50 * DEG, 6);
    expect(nav.observations).toHaveLength(0);
  });

  it('does not take the course from a bow that was only briefly in line', () => {
    const nav = new Navigation();
    holdWith(nav, () => 'S', (i) => i % 3 === 0);
    expect(nav.course).toBeNull();
    expect(nav.observations[0]!.markId).toBe('S');
  });

  it('plots the newest named note of each mark taken since the last plot, skipping untagged, old and plotted ones', () => {
    const nav = new Navigation();
    run(nav, 1);
    nav.record(0); nav.identify(1, 'N');
    run(nav, 1);
    nav.record(0.1); nav.identify(2, 'N');
    nav.record(1); nav.identify(3, 'E');
    nav.record(2);
    expect(nav.candidateNotes().map((n) => n.id)).toEqual([2, 3]);
    nav.course = { value: 0, t: 0 };
    nav.speed = { value: 0, t: 0 };
    expect(nav.beginAutoPlot()).toBe(true);
    expect(nav.plotting).toBe('fix');
    run(nav, 2 * NAVIGATION.timing.plotLine + 0.2, 0);
    expect(nav.candidateNotes()).toEqual([]); // consumed: the next plot is the leg
    expect(nav.beginAutoPlot()).toBe(true);
    expect(nav.plotting).toBe('leg');
    nav.cancelPlot();
    run(nav, NAVIGATION.maxBearingAge + 1, 0);
    nav.record(0); nav.identify(6, 'N');
    run(nav, NAVIGATION.maxBearingAge + 1, 0);
    expect(nav.candidateNotes()).toEqual([]); // too old
  });

  it('keeps a pencil track of every plotted position and caps its length', () => {
    const nav = new Navigation();
    nav.course = { value: Math.PI / 2, t: 0 };
    nav.speed = { value: 2, t: 0 };
    expect(nav.track).toEqual([{ x: 0, z: 0, t: 0, radius: NAVIGATION.accuracy.departure }]);
    for (let i = 0; i < NAVIGATION.maxTrack + 5; i++) {
      nav.beginPlot('leg');
      run(nav, NAVIGATION.timing.plotLeg + 0.2, 2);
    }
    expect(nav.track).toHaveLength(NAVIGATION.maxTrack);
    expect(nav.track.at(-1)).toBe(nav.plotted);
    expect(nav.track[1]!.x).toBeGreaterThan(nav.track[0]!.x);
    nav.reset();
    expect(nav.track).toHaveLength(1);
  });

  it('pauses pencil work while the chart is out of view and resumes where it left off', () => {
    const nav = new Navigation();
    nav.course = { value: 0, t: 0 };
    nav.speed = { value: 1, t: 0 };
    nav.beginPlot('leg');
    run(nav, 2);
    nav.setLooking(false);
    run(nav, 10);
    expect(nav.task!.elapsed).toBeCloseTo(2, 6);
    nav.setLooking(true);
    run(nav, NAVIGATION.timing.plotLeg - 2 + 0.2);
    expect(nav.task).toBeNull();
    expect(nav.plotted.t).toBeGreaterThan(12);
  });

  it('keeps timed wake readings running while the chart is out of view', () => {
    const nav = new Navigation();
    nav.setLooking(false);
    nav.setAstern(true);
    nav.beginReading('speed');
    run(nav, NAVIGATION.timing.speedRead + 0.2, 2);
    expect(nav.speed?.value).toBe(2);
  });

  it('turns a note taken along the bow into the remembered course', () => {
    const nav = new Navigation();
    sight(nav, 90 * DEG);
    nav.assignCourse(1);
    expect(nav.course?.value).toBeCloseTo(Math.PI / 2, 6);
    expect(nav.observations).toHaveLength(0);
  });
});

describe('plotting the dead-reckoning leg', () => {
  function sailingEast(): Navigation {
    const nav = new Navigation();
    sight(nav, 90 * DEG);
    nav.assignCourse(1);
    nav.setAstern(true);
    nav.beginReading('speed');
    run(nav, NAVIGATION.timing.speedRead + 0.2, 3);
    return nav;
  }

  it('refuses until a course and a speed are remembered', () => {
    const nav = new Navigation();
    expect(nav.beginPlot('leg')).toBe(false);
    sight(nav, 90 * DEG);
    nav.assignCourse(1);
    expect(nav.beginPlot('leg')).toBe(false);
    expect(nav.task).toBeNull();
  });

  it('leaves the marker where it was until the plotting time has passed', () => {
    const nav = sailingEast();
    run(nav, 20, 3);
    expect(nav.plotted.x).toBe(0);
    expect(nav.beginPlot('leg')).toBe(true);
    run(nav, NAVIGATION.timing.plotLeg - 1, 3);
    expect(nav.plotted.x).toBe(0);
    run(nav, 1.2, 3);
    expect(nav.plotted.t).toBeGreaterThan(30);
    expect(nav.plotted.x).toBeCloseTo(3 * nav.plotted.t, 6);
    expect(nav.plotted.z).toBeCloseTo(0, 6);
  });

  it('carries on from the remembered values, even after the boat changes course', () => {
    const nav = sailingEast();
    run(nav, 60, 1); // the real boat slowed down; the sailor still remembers 3 m/s
    nav.beginPlot('leg');
    run(nav, NAVIGATION.timing.plotLeg + 0.2, 1);
    expect(nav.plotted.x).toBeCloseTo(3 * nav.plotted.t, 6);
  });

  it('adds doubt in proportion to the distance sailed on memory, and abandoned plotting changes nothing', () => {
    const nav = sailingEast();
    run(nav, 100, 3);
    const before = { ...nav.plotted };
    nav.beginPlot('leg');
    nav.cancelPlot();
    run(nav, 10, 3);
    expect(nav.plotted).toEqual(before);
    nav.beginPlot('leg');
    run(nav, NAVIGATION.timing.plotLeg + 0.2, 3);
    const { speedFraction, courseSigmaDeg, departure } = NAVIGATION.accuracy;
    const expected = departure + Math.hypot(speedFraction, Math.tan(courseSigmaDeg * DEG)) * nav.plotted.x;
    expect(nav.plotted.radius).toBeCloseTo(expected, 6);
    expect(nav.plotted.radius).toBeGreaterThan(NAVIGATION.accuracy.departure + 30);
  });

  it('resets to the known departure, forgetting every reading', () => {
    const nav = sailingEast();
    nav.reset();
    expect(nav.plotted).toEqual({ x: 0, z: 0, t: 0, radius: NAVIGATION.accuracy.departure });
    expect(nav.course).toBeNull();
    expect(nav.speed).toBeNull();
    expect(nav.t).toBe(0);
  });

  it('resets to a spawn the server announces, with ages from its time', () => {
    const nav = sailingEast();
    nav.reset({ x: 15, z: -15, t: 500 });
    expect(nav.plotted).toEqual({ x: 15, z: -15, t: 500, radius: NAVIGATION.accuracy.departure });
    expect(nav.track).toEqual([nav.plotted]);
    expect(nav.t).toBe(500);
    expect(nav.estimate).toEqual({ x: 15, z: -15 });
  });

  it('ignores invalid instrument steps', () => {
    const nav = new Navigation();
    nav.advance({ t: NaN, speed: 2 }, 1);
    nav.advance({ t: 1, speed: 2 }, -1);
    expect(nav.t).toBe(0);
  });
});

describe('bearing lines and fixes', () => {
  it('graduates and wraps bearings on both sides of north', () => {
    expect(graduatedBearing(359.9 * DEG)).toBeCloseTo(0, 10);
    expect(graduatedBearing(-0.6 * DEG) / DEG).toBeCloseTo(359.5, 10);
    expect(graduatedBearing(720.6 * DEG) / DEG).toBeCloseTo(0.5, 10);
  });

  it('projects a one-bearing estimate onto the line without inventing an along-line fix', () => {
    const buoy = NAV_MARKS.find((m) => m.name === 'N')!;
    const result = solveFix([note(1, 'N')], at(40, 25));
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The foot of the perpendicular from (40, 25) on the line through the origin and the buoy.
      const length = Math.hypot(buoy.x, buoy.z);
      const along = (40 * buoy.x + 25 * buoy.z) / length;
      expect(result.position.x).toBeCloseTo((along * buoy.x) / length, 8);
      expect(result.position.z).toBeCloseTo((along * buoy.z) / length, 8);
    }
  });

  it('recovers an independent point from two identified bearings', () => {
    const from = { x: 35, z: 45 };
    const result = solveFix([note(1, 'N', from), note(2, 'E', from)], at(60, 80));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.position.x).toBeCloseTo(from.x, 10);
      expect(result.position.z).toBeCloseTo(from.z, 10);
    }
  });

  it('exposes the crossing of two drawn lines and nothing for near-parallel ones', () => {
    const from = { x: -20, z: 30 };
    const a = positionLine(note(1, 'N', from), at())!;
    const b = positionLine(note(2, 'E', from), at())!;
    expect(lineIntersection(a, b)!.x).toBeCloseTo(from.x, 10);
    expect(lineIntersection(a, a)).toBeNull();
  });

  it('carries earlier lines forward by the remembered motion between sightings and plotting', () => {
    const velocity = { x: 2, z: 1 };
    const first = note(1, 'N');
    const second = note(2, 'E', { x: 40, z: 20 }, 20);
    const context = at(80, 10, 35, velocity);
    const result = solveFix([first, second], context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Second sighting at (40, 20); 15 s at (2, 1) m/s carries it to (70, 35).
      expect(result.position.x).toBeCloseTo(70, 10);
      expect(result.position.z).toBeCloseTo(35, 10);
    }
    const n = NAV_MARKS.find((m) => m.name === 'N')!;
    expect(positionLine(first, context)?.mark).toEqual({ x: n.x + 70, z: n.z + 35 });
  });

  it('fixes on a landmark ashore just like on a buoy', () => {
    const from = { x: 300, z: -200 };
    const result = solveFix([note(1, 'N', from), note(2, 'LIGHT', from)], at(0, 0, 0));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.position.x).toBeCloseTo(from.x, 6);
      expect(result.position.z).toBeCloseTo(from.z, 6);
    }
  });

  it('rejects parallel/antiparallel geometry, unidentified/expired notes, wrong-way rays and unremembered motion', () => {
    const a = note(1, 'N');
    const parallel = { ...note(2, 'E'), bearing: a.bearing + 5 * DEG };
    const opposite = { ...parallel, bearing: a.bearing + Math.PI };
    expect(solveFix([a, parallel], at())).toMatchObject({ ok: false, reason: expect.stringMatching(/parallel/) });
    expect(solveFix([a, opposite], at()).ok).toBe(false);
    expect(solveFix([{ ...a, markId: null }], at()).ok).toBe(false);
    expect(solveFix([a], at(0, 0, NAVIGATION.maxBearingAge + 1, { x: 0, z: 0 })).ok).toBe(false);
    expect(solveFix([{ ...a, bearing: Math.PI }], at())).toMatchObject({ ok: false, reason: expect.stringMatching(/away/) });
    expect(solveFix([a], at(0, 0, 30))).toMatchObject({ ok: false, reason: expect.stringMatching(/course and speed/) });
    expect(solveFix([], at()).ok).toBe(false);
  });

  it('plots a fix only after the pencil time, moves the marker there and tightens the doubt', () => {
    const nav = new Navigation();
    nav.course = { value: 0, t: 0 };
    nav.speed = { value: 0, t: 0 };
    const mark = NAV_MARKS.find((m) => m.name === 'N')!;
    run(nav, 1, 0);
    nav.record(worldToBearing(mark.x - 0, mark.z - 0));
    nav.identify(1, 'N');
    expect(nav.beginPlot('fix')).toBe(true);
    run(nav, NAVIGATION.timing.plotLine - 1, 0);
    expect(nav.plotted.radius).toBe(NAVIGATION.accuracy.departure);
    run(nav, 1.2, 0);
    expect(nav.plotted.radius).toBe(NAVIGATION.accuracy.oneLineFix);
    expect(nav.plotted.t).toBeGreaterThan(NAVIGATION.timing.plotLine - 0.2);
  });

  it('requires a named note before a fix, keeps readings, and bounds notes', () => {
    const nav = new Navigation();
    nav.course = { value: 0, t: 0 };
    nav.speed = { value: 1, t: 0 };
    run(nav, 1, 0);
    nav.record(0);
    expect(nav.beginPlot('fix')).toBe(false);
    nav.identify(1, 'N');
    expect(nav.beginPlot('fix')).toBe(true);
    nav.cancelPlot();
    for (let i = 0; i < NAVIGATION.maxObservations + 3; i++) nav.record(i);
    expect(nav.observations).toHaveLength(NAVIGATION.maxObservations);
    expect(nav.course).not.toBeNull();
    expect(nav.speed).not.toBeNull();
  });
});
