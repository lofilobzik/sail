import { describe, expect, it } from 'vitest';
import { WIND_PARAMETERS, windSpeedFactor } from '../sim';
import type { WindConfig } from '../physics/types';
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
    map.update(wind, boat, boat, 42);
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
    const at = (x: number) => ({ x, z: 500 });
    map.update(wind, at(500), at(500), 10);
    const ox = map.originX;
    const snapshot = Uint8Array.from(map.data);
    map.update(wind, at(500 + V.mapCellM * 0.3), at(500 + V.mapCellM * 0.3), 10);
    expect(map.originX).toBe(ox);
    expect(map.data).toEqual(snapshot);
    map.update(wind, at(500 + 3 * V.mapCellM), at(500 + 3 * V.mapCellM), 10);
    expect(map.originX - ox).toBeCloseTo(3 * V.mapCellM, 9);
    // A world node present in both windows keeps its value.
    expect(map.data[0 * V.mapSize + 5]).toBe(snapshot[0 * V.mapSize + 8]);
  });

  it('switches the shader code off and leaves the texture alone when gusts are disabled', () => {
    const map = new GustMap();
    const P = { x: 0, z: 0 };
    map.update(wind, P, P, 1);
    expect(map.uniforms.gustStrength.value).toBe(1);
    const before = Uint8Array.from(map.data);
    const far = { x: 900, z: 900 };
    map.update({ ...wind, gusts: { ...wind.gusts!, enabled: false } }, far, far, 50);
    expect(map.uniforms.gustStrength.value).toBe(0);
    expect(map.data).toEqual(before);
    map.update({ speedKn: 7, fromDeg: 0 }, P, P, 1);
    expect(map.uniforms.gustStrength.value).toBe(0);
  });

  it('interpolates between exact samples, swaps at the interval and resamples on wind changes', () => {
    const map = new GustMap();
    const P = { x: 300, z: -200 };
    // Bytes the map would hold for an exact sample at time t (same encoding as above).
    const exact = (t: number, w: WindConfig) => {
      const out = new Uint8Array(V.mapSize * V.mapSize);
      for (let j = 0; j < V.mapSize; j++) {
        for (let i = 0; i < V.mapSize; i++) {
          const deviation = windSpeedFactor({ x: map.originX + i * V.mapCellM, z: map.originZ + j * V.mapCellM }, t, w) - 1;
          out[j * V.mapSize + i] = Math.min(255, Math.max(0, Math.round(127.5 + (deviation * 127.5) / V.referenceDeviation)));
        }
      }
      return out;
    };
    const w: WindConfig = { ...wind, gusts: { ...wind.gusts! } };
    map.update(w, P, P, 10);
    expect(map.data).toEqual(exact(10, w));
    expect(map.nextData).toEqual(exact(10.25, w));
    expect(map.uniforms.gustBlend.value).toBe(0);

    const data = Uint8Array.from(map.data);
    const next = Uint8Array.from(map.nextData);
    map.update(w, P, P, 10.1);
    expect(map.data).toEqual(data);
    expect(map.nextData).toEqual(next);
    expect(Math.abs(map.uniforms.gustBlend.value - 0.4)).toBeLessThan(1e-12);

    map.update(w, P, P, 10.25);
    expect(map.data).toEqual(next);
    expect(map.nextData).toEqual(exact(10.5, w));
    expect(map.uniforms.gustBlend.value).toBe(0);

    // The debug overlay and server snapshots change the wind in place.
    w.speedKn = 12;
    map.update(w, P, P, 10.3);
    expect(map.data).toEqual(exact(10.3, w));
    expect(map.uniforms.gustBlend.value).toBe(0);
  });
});
