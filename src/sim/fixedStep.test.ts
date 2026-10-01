import { describe, expect, it } from 'vitest';
import { FixedStep } from './fixedStep';
import { CubicSpline } from './spline';

describe('FixedStep', () => {
  it('runs whole steps and carries the remainder as the interpolation factor', () => {
    const f = new FixedStep(0.01);
    expect(f.advance(0.025)).toBe(2);
    expect(f.alpha).toBeCloseTo(0.5, 9);
    expect(f.advance(0.005)).toBe(1);
    expect(f.alpha).toBeCloseTo(0, 9);
  });

  it('caps a long frame instead of spiralling', () => {
    const f = new FixedStep(0.01, 0.1);
    expect(f.advance(5)).toBe(10);
  });
});

describe('CubicSpline', () => {
  it('passes through the knots and clamps outside', () => {
    const s = new CubicSpline([0, 1, 3, 4], [0, 2, 1, 5]);
    expect(s.at(1)).toBeCloseTo(2, 12);
    expect(s.at(3)).toBeCloseTo(1, 12);
    expect(s.at(-1)).toBe(0);
    expect(s.at(9)).toBe(5);
  });
});
