import { expect, it } from 'vitest';
import { DEG } from '../sim/frames';
import { sightingBearing } from './sighting';

it('reads compass direction from horizontal aim, including a tilted viewing direction', () => {
  expect(sightingBearing({ x: 0, y: 0.4, z: -0.8 })).toBe(0);
  expect(sightingBearing({ x: 1, y: 0, z: 0 })).toBeCloseTo(90 * DEG);
  expect(sightingBearing({ x: -1, y: 0.5, z: 0 })).toBeCloseTo(270 * DEG);
  expect(sightingBearing({ x: 0, y: 1, z: 0 })).toBeNull();
  expect(sightingBearing({ x: NaN, y: 0, z: 1 })).toBeNull();
});
