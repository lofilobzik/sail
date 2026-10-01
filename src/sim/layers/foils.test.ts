import { describe, expect, it } from 'vitest';
import { buildBoat } from '../boat';
import { defaultConfig } from '../config';
import { DEG } from '../frames';
import { ittcFriction } from '../friction';
import { initialState } from '../state';
import { foilForces, foilLiftCoefficient, zeroLiftDrift } from './foils';

const boat = buildBoat();
const cfg = defaultConfig();
const noTiller = { tiller: 0, sheet: 0, hike: 0 };
const terms = { ...cfg.terms, zeroLiftDrift: true };

describe('L3 foils', () => {
  it('uses the Day 2017 p6 lift slope with AR_E = 2b/c, standard and printed forms', () => {
    const ar = (2 * 0.68) / 0.341;
    expect(boat.board.aspectRatioImage).toBeCloseTo(ar, 12);
    expect(boat.board.liftSlope).toBeCloseTo((5.7 * ar) / (1.8 + Math.sqrt(ar * ar + 4)), 12);
    expect(boat.board.liftSlopePrinted).toBeCloseTo((5.7 * ar) / (1.8 + Math.sqrt(ar ** 4 + 4)), 12);
    expect(boat.board.cHull).toBeCloseTo(1 + 1.8 * (boat.tc / 0.68), 12);
  });

  it('the printed lift slope makes the board produce less side force at the same leeway', () => {
    const state = { ...initialState(0, 2), v: 2 * Math.tan(3 * DEG) };
    const std = foilForces(state, noTiller, boat, cfg.env, cfg.terms, cfg.models);
    const printed = foilForces(state, noTiller, boat, cfg.env, cfg.terms, { ...cfg.models, liftSlope: 'printed' });
    expect(Math.abs(printed.board.fy)).toBeLessThan(0.5 * Math.abs(std.board.fy));
  });

  it('is linear below stall and capped at clMax above it', () => {
    const slope = boat.board.liftSlope * boat.board.cHull;
    const small = foilLiftCoefficient(slope, 2 * DEG, boat.cfg.foil.clMax);
    expect(small.cl).toBeCloseTo(slope * 2 * DEG, 12);
    expect(small.stalled).toBe(false);
    const big = foilLiftCoefficient(slope, 40 * DEG, boat.cfg.foil.clMax);
    expect(big.stalled).toBe(true);
    expect(Math.abs(big.cl)).toBeLessThanOrEqual(boat.cfg.foil.clMax);
    expect(foilLiftCoefficient(slope, -2 * DEG, boat.cfg.foil.clMax).cl).toBeCloseTo(-small.cl, 12);
  });

  it('zero-lift drift: printed value read in degrees or radians, signed with heel', () => {
    const phi = 20 * DEG;
    const value = (0.405 * 11.755 * phi) ** 2; // 2.76
    expect(zeroLiftDrift(phi, 11.755, 'deg', 1)).toBeCloseTo(value * DEG, 12);
    expect(zeroLiftDrift(phi, 11.755, 'rad', 1)).toBeCloseTo(value, 12);
    expect(zeroLiftDrift(-phi, 11.755, 'deg', 1)).toBeCloseTo(-value * DEG, 12);
    expect(zeroLiftDrift(phi, 11.755, 'deg', -1)).toBeCloseTo(-value * DEG, 12);
    expect(zeroLiftDrift(0, 11.755, 'deg', 1)).toBe(0);
  });

  it('with sign +1, heel to the leeward side costs board lift at the same leeway', () => {
    const sliding = { ...initialState(0, 2), v: 2 * Math.tan(3 * DEG) }; // sliding to starboard
    const upright = foilForces(sliding, noTiller, boat, cfg.env, terms, cfg.models);
    const heeled = foilForces({ ...sliding, heel: 15 * DEG }, noTiller, boat, cfg.env, terms, cfg.models);
    expect(heeled.lambda0).toBeGreaterThan(0);
    expect(Math.abs(heeled.board.lift)).toBeLessThan(Math.abs(upright.board.lift));
  });

  it('resists leeway: sliding to starboard pushes the board to port', () => {
    const state = { ...initialState(0, 2), v: 2 * Math.tan(4 * DEG) };
    const f = foilForces(state, noTiller, boat, cfg.env, cfg.terms, cfg.models);
    expect(f.board.fy).toBeLessThan(0);
    // Along the direction of travel only drag remains: it opposes the motion.
    const speed = Math.hypot(state.u, state.v);
    expect((f.board.fx * state.u + f.board.fy * state.v) / speed).toBeCloseTo(-f.board.drag, 9);
    // Lift is perpendicular to the flow, so it leans forward: a little drive from the board.
    expect(f.board.fx).toBeGreaterThan(0);
    expect(f.heelMoment).toBeGreaterThan(0); // board below the waterline pushing to port heels the top to starboard
  });

  it('turns the bow away from the tiller when sailing forward and toward it going astern', () => {
    const forward = foilForces(initialState(0, 2), { ...noTiller, tiller: 1 }, boat, cfg.env, cfg.terms, cfg.models);
    expect(forward.yawMoment).toBeLessThan(0); // tiller to starboard -> bow to port
    const astern = foilForces(initialState(0, -1), { ...noTiller, tiller: 1 }, boat, cfg.env, cfg.terms, cfg.models);
    expect(astern.yawMoment).toBeGreaterThan(0);
  });

  it('downwash from the loaded board reduces the rudder load', () => {
    const state = { ...initialState(0, 2), v: 2 * Math.tan(4 * DEG) };
    const withDw = foilForces(state, noTiller, boat, cfg.env, cfg.terms, cfg.models);
    const noDw = foilForces(state, noTiller, boat, cfg.env, { ...cfg.terms, downwash: false }, cfg.models);
    expect(withDw.downwash).toBeGreaterThan(0);
    expect(Math.abs(withDw.rudder.lift)).toBeLessThan(Math.abs(noDw.rudder.lift));
    expect(withDw.board.lift).toBeCloseTo(noDw.board.lift, 12);
  });

  it('ITTC-1957 friction line', () => {
    expect(ittcFriction(1e7)).toBeCloseTo(0.075 / 25, 12);
    expect(ittcFriction(1e6)).toBeGreaterThan(ittcFriction(1e7));
  });
});
