import { describe, expect, it } from 'vitest';
import { WIND_PARAMETERS, windSpeedFactor, type WindConfig } from '../sim';
import { GustMap } from './gustMap';

const V = WIND_PARAMETERS.visual;
const wind: WindConfig = {
  speedKn: 7, fromDeg: 20,
  gusts: { enabled: true, seed: 1987, gustScale: 1, shiftScale: 1 },
};
const decode = (byte: number): number => 1 + ((byte - 127.5) / 127.5) * V.referenceDeviation;

describe('gust map', () => {
  it('stores the sim wind speed factor at each texel to byte precision, on a fixed world grid', () => {
    const map = new GustMap();
    const boat = { x: 1234.5, z: -987.6 };
    map.update(wind, boat, 42);
    for (const [i, j] of [[0, 0], [10, 20], [V.mapSize - 1, V.mapSize - 1], [31, 32]] as const) {
      const x = map.originX + i * V.mapCellM;
      const z = map.originZ + j * V.mapCellM;
      const expected = windSpeedFactor({ x, z }, 42, wind);
      expect(decode(map.data[j * V.mapSize + i]!)).toBeCloseTo(expected, 2);
    }
    // Render-local texel origin is the logical grid origin relative to the rebased boat.
    expect(map.uniforms.gustOrigin.value.x).toBeCloseTo(map.originX - boat.x, 9);
    expect(map.uniforms.gustOrigin.value.y).toBeCloseTo(map.originZ - boat.z, 9);
    expect(Math.abs(map.uniforms.gustOrigin.value.x)).toBeLessThan(V.mapSize * V.mapCellM);
  });

  it('does not move texels while the boat sails inside a cell, and shifts exactly whole cells otherwise', () => {
    const map = new GustMap();
    map.update(wind, { x: 500, z: 500 }, 10);
    const ox = map.originX;
    const snapshot = Uint8Array.from(map.data);
    map.update(wind, { x: 500 + V.mapCellM * 0.3, z: 500 }, 10);
    expect(map.originX).toBe(ox);
    expect(map.data).toEqual(snapshot);
    map.update(wind, { x: 500 + 3 * V.mapCellM, z: 500 }, 10);
    expect(map.originX - ox).toBeCloseTo(3 * V.mapCellM, 9);
    // A world node present in both windows keeps its value.
    expect(map.data[0 * V.mapSize + 5]).toBe(snapshot[0 * V.mapSize + 8]);
  });

  it('switches the shader code off and leaves the texture alone when gusts are disabled', () => {
    const map = new GustMap();
    map.update(wind, { x: 0, z: 0 }, 1);
    expect(map.uniforms.gustStrength.value).toBe(1);
    const before = Uint8Array.from(map.data);
    map.update({ ...wind, gusts: { ...wind.gusts!, enabled: false } }, { x: 900, z: 900 }, 50);
    expect(map.uniforms.gustStrength.value).toBe(0);
    expect(map.data).toEqual(before);
    map.update({ speedKn: 7, fromDeg: 0 }, { x: 0, z: 0 }, 1);
    expect(map.uniforms.gustStrength.value).toBe(0);
  });
});
