import { describe, expect, it } from 'vitest';
import { buildBoat } from '../boat';
import { defaultConfig } from '../config';
import { DEG, G } from '../frames';
import { initialState } from '../state';
import { step } from '../step';
import { crewPosition, rightingMoment } from './heel';

const boat = buildBoat();

describe('L5 heel and hiking', () => {
  it('matches Day 2017 Eq. 18 with the crew fully hiked', () => {
    const c = boat.cfg.crew;
    const phi = 12 * DEG;
    const dY = c.hikeReachFrac * c.cgHeightFrac * c.height; // 95% of 55% of height
    const dZ = c.hikedZAboveHullCg;
    const gz = boat.gm * Math.sin(phi);
    const eq18 = boat.hullMass * G * gz + boat.crewMass * G * (gz + dY * Math.cos(phi) - dZ * Math.sin(phi));
    // Heeled to starboard with the crew hiking on the port side.
    expect(-rightingMoment(phi, -dY, dZ, boat)).toBeCloseTo(eq18, 9);
  });

  it('puts the crew on the side opposite the boom, further out when hiking', () => {
    const state = { ...initialState(), boomSide: 1 as const };
    const sitting = crewPosition(state, { tiller: 0, sheet: 0, hike: 0 }, boat);
    const hiked = crewPosition(state, { tiller: 0, sheet: 0, hike: 1 }, boat);
    expect(sitting.targetY).toBeLessThan(0);
    expect(hiked.targetY).toBeLessThan(sitting.targetY);
    expect(hiked.targetY).toBeCloseTo(-0.95 * 0.55 * boat.cfg.crew.height, 12);
  });

  it('moves the crew target toward the centreline as luffAmount rises, keeping the crew height', () => {
    const state = { ...initialState(), boomSide: 1 as const };
    const hiking = { tiller: 0, sheet: 0, hike: 0.5 };
    const full = crewPosition(state, hiking, boat).targetY;
    expect(crewPosition(state, hiking, boat, 0).targetY).toBe(full);
    expect(crewPosition(state, hiking, boat, 0.5).targetY).toBeCloseTo(full / 2, 12);
    expect(crewPosition(state, hiking, boat, 1).targetY).toBeCloseTo(0, 12);
    expect(crewPosition(state, hiking, boat, 1).z).toBe(crewPosition(state, hiking, boat).z);
  });

  it('settles at the heel where righting balances a steady moment, and hiking reduces it', () => {
    // No sail, no foils, no hull: only the crew moment and hydrostatics act.
    const cfg = defaultConfig();
    cfg.layers = { ...cfg.layers, sail: false, foils: false, hull: false, yaw: false };
    const settle = (crewY: number) => {
      let s = { ...initialState(), crewY, boomSide: (crewY < 0 ? 1 : -1) as 1 | -1 };
      const hike = Math.abs(crewY) > boat.cfg.crew.sitInOffset ? 1 : 0;
      for (let i = 0; i < 60 * 30; i++) s = step(s, { tiller: 0, sheet: 0, hike }, boat, cfg).state;
      return s.heel;
    };
    const sitting = settle(-boat.cfg.crew.sitInOffset);
    expect(sitting).toBeLessThan(0); // crew to port heels the boat to port
    const crewZ = boat.cfg.crew.sitInZAboveHullCg;
    expect(Math.abs(rightingMoment(sitting, -boat.cfg.crew.sitInOffset, crewZ, boat))).toBeLessThan(1);
  });

  it('clamps heel at the limit', () => {
    const cfg = defaultConfig();
    cfg.layers = { ...cfg.layers, sail: false, foils: false, hull: false, yaw: false };
    const light = { ...boat, gm: 0.01 }; // nearly no form stability: the crew alone tips it over
    let s = { ...initialState(), crewY: -1 };
    for (let i = 0; i < 60 * 20; i++) s = step(s, { tiller: 0, sheet: 0, hike: 1 }, light, cfg).state;
    expect(s.heel).toBeCloseTo(-boat.cfg.dynamics.heelLimitDeg * DEG, 9);
  });

  it('keeps the boat upright when the layer is off', () => {
    const cfg = defaultConfig();
    cfg.layers.heel = false;
    let s = { ...initialState(), crewY: -0.9 };
    for (let i = 0; i < 120; i++) s = step(s, { tiller: 0, sheet: 0, hike: 1 }, boat, cfg).state;
    expect(s.heel).toBe(0);
  });
});
