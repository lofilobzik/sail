import { describe, expect, it } from 'vitest';
import table from '../../../data/sail-coefficients.json';
import { buildBoat } from '../boat';
import { defaultConfig } from '../config';
import { DEG, clamp } from '../frames';
import { initialState } from '../state';
import { apparentWind } from './apparentWind';
import { boomKinematics, sailCoefficients, sailForces } from './sail';
import { getWind } from '../wind';

const boat = buildBoat();
const rig = boat.cfg.rig;
const alphaOpt = boat.betaPeak - rig.boomMinDeg * DEG;
const bestBoom = (beta: number) => clamp(beta - alphaOpt, rig.boomMinDeg * DEG, rig.boomMaxDeg * DEG);

describe('L2 sail coefficients (best-trim envelope over Day 2017 Table 1)', () => {
  it('reproduces Table 1 at best trim above the angle of maximum lift', () => {
    for (const beta of [60, 90, 120, 150, 180]) {
      const i = table.betaDeg.indexOf(beta);
      const c = sailCoefficients(boat, beta * DEG, bestBoom(beta * DEG));
      expect(c.cl).toBeCloseTo(table.cl[i]!, 9);
      expect(c.cdv).toBeCloseTo(table.cdv[i]!, 9);
      expect(c.luffAmount).toBe(0);
    }
  });

  it('reproduces Table 1 upwind with the boom sheeted hard in, above the luffing band', () => {
    for (const beta of [28]) {
      const i = table.betaDeg.indexOf(beta);
      const c = sailCoefficients(boat, beta * DEG, rig.boomMinDeg * DEG);
      expect(c.cl).toBeCloseTo(table.cl[i]!, 9);
      expect(c.cdv).toBeCloseTo(table.cdv[i]!, 9);
    }
  });

  it('pinching through the luffing band collapses lift even with the sheet in', () => {
    const sheetedIn = (betaDeg: number) => sailCoefficients(boat, betaDeg * DEG, rig.boomMinDeg * DEG);
    expect(sheetedIn(rig.luffStartBetaEffDeg).luffAmount).toBe(0);
    expect(sheetedIn(rig.luffStartBetaEffDeg).cl).toBeCloseTo(boat.clTable.at(rig.luffStartBetaEffDeg), 9);
    const mid = (rig.luffStartBetaEffDeg + rig.luffFullBetaEffDeg) / 2;
    expect(sheetedIn(mid).luffAmount).toBeCloseTo(0.5, 9);
    expect(sheetedIn(mid).cl).toBeCloseTo(0.5 * boat.clTable.at(mid), 9);
    expect(sheetedIn(rig.luffFullBetaEffDeg).cl).toBe(0);
    expect(sheetedIn(rig.luffFullBetaEffDeg).cdv).toBeCloseTo(table.cdv[0]!, 9);
  });

  it('puts maximum lift between the 28 and 60 degree table points (Day p5: around 34)', () => {
    expect(boat.betaPeak / DEG).toBeGreaterThan(28);
    expect(boat.betaPeak / DEG).toBeLessThan(60);
  });

  it('loses lift and starts luffing when eased past best trim', () => {
    const beta = 60 * DEG;
    let prevCl = Infinity;
    let prevLuff = -Infinity;
    for (let eased = 0; eased <= 30; eased += 5) {
      const c = sailCoefficients(boat, beta, bestBoom(beta) + eased * DEG);
      expect(c.cl).toBeLessThanOrEqual(prevCl + 1e-12);
      expect(c.luffAmount).toBeGreaterThanOrEqual(prevLuff);
      prevCl = c.cl;
      prevLuff = c.luffAmount;
    }
    const flagging = sailCoefficients(boat, beta, beta); // boom along the wind: alpha = 0
    expect(flagging.cl).toBe(0);
    expect(flagging.luffAmount).toBe(1);
    expect(flagging.cdv).toBeCloseTo(table.cdv[0]!, 9);
  });

  it('stalls when over-sheeted: less lift, more drag', () => {
    const beta = 90 * DEG;
    const best = sailCoefficients(boat, beta, bestBoom(beta));
    const tight = sailCoefficients(boat, beta, rig.boomMinDeg * DEG);
    expect(tight.trimError).toBeLessThan(0);
    expect(tight.cl).toBeLessThan(best.cl);
    expect(tight.cdv).toBeGreaterThan(best.cdv);
    expect(tight.luffAmount).toBe(0);
  });

  it('luffs when pinching head to wind even with the sheet in', () => {
    expect(sailCoefficients(boat, 4 * DEG, rig.boomMinDeg * DEG).luffAmount).toBeGreaterThan(0.5);
  });

  it('stallAmount: zero at best trim, grows when over-sheeted and on a run with the boom at its limit', () => {
    for (const beta of [28, 60, 90, 120]) expect(sailCoefficients(boat, beta * DEG, bestBoom(beta * DEG)).stallAmount).toBe(0);
    const beta = 90 * DEG;
    const over10 = sailCoefficients(boat, beta, bestBoom(beta) - 10 * DEG).stallAmount;
    const over30 = sailCoefficients(boat, beta, bestBoom(beta) - 30 * DEG).stallAmount;
    expect(over10).toBeGreaterThan(0);
    expect(over30).toBeGreaterThan(over10);
    expect(sailCoefficients(boat, beta, bestBoom(beta) + 10 * DEG).stallAmount).toBe(0); // eased: luffing side
    expect(sailCoefficients(boat, Math.PI, rig.boomMaxDeg * DEG).stallAmount).toBeGreaterThan(0.9); // dead run
  });
});

describe('L2 boom kinematics', () => {
  it('limits the boom by the sheet and lets it weathervane when eased further', () => {
    const state = { ...initialState(), boomSide: -1 as const };
    // Wind 120 deg off starboard, boom to port.
    const half = boomKinematics(120 * DEG, state, 0.5, boat);
    expect(half.boomSide).toBe(-1);
    expect(half.target / DEG).toBeCloseTo(-(rig.boomMinDeg + 0.5 * (rig.boomMaxDeg - rig.boomMinDeg)), 9);
    const free = boomKinematics(30 * DEG, state, 1, boat);
    expect(free.target / DEG).toBeCloseTo(-30, 9);
  });

  it('flips side when the wind crosses the bow (tack)', () => {
    const state = { ...initialState(), boomSide: -1 as const }; // boom to port, wind was from starboard
    const k = boomKinematics(-10 * DEG, state, 0.2, boat); // wind now from port
    expect(k.boomSide).toBe(1);
    expect(k.target).toBeGreaterThan(0);
  });

  it('only gybes once the wind is past the by-the-lee margin', () => {
    const state = { ...initialState(), boomSide: -1 as const };
    const byTheLeeSmall = boomKinematics(-(180 - rig.gybeByTheLeeDeg + 5) * DEG, state, 1, boat);
    expect(byTheLeeSmall.boomSide).toBe(-1);
    const byTheLeeBig = boomKinematics(-(180 - rig.gybeByTheLeeDeg - 5) * DEG, state, 1, boat);
    expect(byTheLeeBig.boomSide).toBe(1);
  });
});

describe('L2 sail forces', () => {
  const cfg = defaultConfig();
  const trimmed = (heading: number, windFromDeg: number) => {
    const wind = getWind({ x: 0, z: 0 }, 0, { speedKn: 7, fromDeg: windFromDeg });
    const s0 = initialState(heading, 0);
    const aw = apparentWind(s0, wind, true);
    const side: 1 | -1 = aw.angle > 0 ? -1 : 1;
    const boom = side * bestBoom(Math.abs(aw.angle));
    const state = { ...s0, boomSide: side, boom };
    return sailForces(state, aw, 0, boat, cfg.env, cfg.terms);
  };

  it('drives forward and pushes to leeward on a beam reach, mirror-symmetric between tacks', () => {
    const stbdTack = trimmed(0, 90); // wind from starboard
    const portTack = trimmed(0, 270);
    expect(stbdTack.fx).toBeGreaterThan(0);
    expect(stbdTack.fy).toBeLessThan(0); // leeward = port
    expect(stbdTack.heelMoment).toBeLessThan(0); // heels to port
    expect(portTack.fx).toBeCloseTo(stbdTack.fx, 9);
    expect(portTack.fy).toBeCloseTo(-stbdTack.fy, 9);
    expect(portTack.yawMoment).toBeCloseTo(-stbdTack.yawMoment, 9);
  });

  it('drag-only sail on a dead run pushes the boat downwind', () => {
    const run = trimmed(0, 180);
    expect(run.fx).toBeGreaterThan(0);
    expect(Math.abs(run.cl)).toBeLessThan(0.2);
  });

  it('has no induced drag term when switched off', () => {
    const on = trimmed(0, 45);
    const cfgOff = { ...cfg.terms, sailInducedDrag: false };
    const wind = getWind({ x: 0, z: 0 }, 0, { speedKn: 7, fromDeg: 45 });
    const s0 = initialState(0, 0);
    const aw = apparentWind(s0, wind, true);
    const off = sailForces({ ...s0, boomSide: -1, boom: -bestBoom(aw.angle) }, aw, 0, boat, cfg.env, cfgOff);
    expect(off.cdi).toBe(0);
    expect(on.cdi).toBeGreaterThan(0);
    expect(off.drag).toBeLessThan(on.drag);
  });
});
