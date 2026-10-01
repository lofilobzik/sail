import { describe, expect, it } from 'vitest';
import { rateLimit } from './rateLimit';

describe('rateLimit', () => {
  it('ramps at the given rate', () => {
    expect(rateLimit(0, 1, 2, 0.1)).toBeCloseTo(0.2);
  });

  it('holds once the target is reached', () => {
    expect(rateLimit(0.5, 0.5, 2, 0.1)).toBe(0.5);
  });

  it('never overshoots the target', () => {
    let x = 0;
    for (let i = 0; i < 100; i++) {
      x = rateLimit(x, 0.33, 2, 1 / 60);
      expect(x).toBeLessThanOrEqual(0.33);
    }
    expect(x).toBe(0.33);
    expect(rateLimit(0.9, 1, 5, 1)).toBe(1);
  });

  it('is symmetric for the negative direction', () => {
    expect(rateLimit(0, -1, 2, 0.1)).toBeCloseTo(-rateLimit(0, 1, 2, 0.1));
    expect(rateLimit(-0.95, -1, 2, 0.1)).toBe(-1);
  });
});
