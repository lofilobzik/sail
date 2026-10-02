import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SkyView } from './sky';
import { SKY, atmosphere, clearSky, dayFactor, hemisphereIntensity, sunDirection, sunLight, transmittance } from './skyModel';

describe('sky model', () => {
  it('points the sun along the compass bearing at the requested elevation (+x east, +z south)', () => {
    const [x, y, z] = sunDirection(30, 90);
    expect(y).toBeCloseTo(0.5, 12);
    expect(x).toBeCloseTo(Math.cos((30 * Math.PI) / 180), 12);
    expect(z).toBeCloseTo(0, 12);
    expect(sunDirection(0, 180)[2]).toBeCloseTo(1, 12);
  });

  it('gives a warmer, dimmer sun at low elevation and no light below the horizon', () => {
    const high = sunDirection(60, 0);
    const low = sunDirection(5, 0);
    const highLight = sunLight(atmosphere(high[1]), high);
    const lowLight = sunLight(atmosphere(low[1]), low);
    // Blue is scattered out of a long low path: blue/red falls as the sun drops.
    expect(lowLight.colour[2] / lowLight.colour[0]).toBeLessThan(highLight.colour[2] / highLight.colour[0]);
    expect(lowLight.intensity).toBeLessThan(highLight.intensity);
    const night = sunDirection(-20, 0);
    expect(sunLight(atmosphere(night[1]), night).intensity).toBe(0);
    expect(hemisphereIntensity(night[1])).toBeCloseTo(SKY.hemisphereIntensity * SKY.hemisphereNightFrac, 12);
    expect(dayFactor(1)).toBe(1);
  });

  it('extinction grows toward the horizon and the clear sky stays in display range', () => {
    const sun = sunDirection(40, 100);
    const atm = atmosphere(sun[1]);
    const zenith = transmittance(atm, 1);
    const low = transmittance(atm, 0.05);
    for (let i = 0; i < 3; i++) expect(low[i]!).toBeLessThan(zenith[i]!);
    for (const elevation of [0, 5, 20, 60, 90]) {
      const dir: [number, number, number] = [Math.cos((elevation * Math.PI) / 180), Math.sin((elevation * Math.PI) / 180), 0];
      for (const c of clearSky(atm, sun, dir)) {
        expect(c).toBeGreaterThan(0);
        expect(c).toBeLessThan(1);
      }
    }
  });

  it('is bluer at the zenith than the horizon, which is the paler haze', () => {
    const sun = sunDirection(59, 124);
    const atm = atmosphere(sun[1]);
    const zenith = clearSky(atm, sun, [0, 1, 0]);
    const horizon = clearSky(atm, sun, [1, 0, 0]);
    expect(zenith[2] - zenith[0]).toBeGreaterThan(horizon[2] - horizon[0]);
  });
});

describe('cloud drift', () => {
  const make = () => new SkyView(new THREE.DirectionalLight(), new THREE.HemisphereLight(), new THREE.Scene());
  const offset = (sky: SkyView): [number, number] => [sky.uniforms.skyCloud.value.z, sky.uniforms.skyCloud.value.w];

  it('moves the pattern with the wind, and not at all in a calm', () => {
    const sky = make();
    sky.update(0, { x: 0, z: 0 });
    sky.update(100, { x: 0, z: 0 });
    expect(offset(sky)).toEqual([0, 0]);
    sky.update(200, { x: 3.6, z: 0 });
    // Pattern shifts toward +x (downwind): the sampling offset moves opposite, wrapped into one period.
    const moved = offset(sky)[0];
    expect(moved).toBeGreaterThan(2.56 - 0.01);
    expect(offset(sky)[1]).toBe(0);
  });

  it('integrates changing wind without jumps and ignores a time rewind', () => {
    const sky = make();
    sky.update(0, { x: 0, z: 2 });
    sky.update(10, { x: 0, z: 2 });
    const before = offset(sky)[1];
    sky.update(10.1, { x: 0, z: -2 });
    const step = Math.abs(offset(sky)[1] - before);
    expect(step).toBeLessThan(1e-4); // 0.1 s of drift only
    const held = offset(sky);
    sky.update(0, { x: 5, z: 5 }); // reset: sim time goes backwards
    expect(offset(sky)).toEqual(held);
  });

  it('keeps the uniform offset within one noise period however long the session runs', () => {
    const sky = make();
    for (let t = 0; t <= 2_000_000; t += 1000) sky.update(t, { x: 7, z: -7 });
    const [x, z] = offset(sky);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThan(2.56);
    expect(z).toBeGreaterThanOrEqual(0);
    expect(z).toBeLessThan(2.56);
  });
});
