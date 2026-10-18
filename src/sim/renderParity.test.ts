import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import buoyData from '../../data/buoys.json';
import type { WaveConfig, WindConfig } from '../physics/types';
import type { Vec2 } from './frames';
import { BERTHS } from './mooring';
import { BAY, LANDMARKS, terrainHeight } from './terrain';
import { createWaveSample, sampleWaves, waveAmplitude, type WaveSample } from './waves';
import { getWind, windSpeedFactor } from './wind';

interface Samples {
  waves: {
    spec: Omit<WaveConfig, 'components' | 'amplitudeLimit'>;
    components: WaveConfig['components'];
    amplitudeLimit: number;
    amplitude: number;
    points: { x: number; z: number; t: number; depth: number; out: WaveSample }[];
  }[];
  wind: { config: WindConfig; points: { x: number; z: number; t: number; out: Vec2 }[] }[];
  windTime: { config: WindConfig; points: { x: number; z: number; t: number; wind: Vec2; factor: number }[] }[];
  terrain: { x: number; z: number; h: number }[];
  landmarks: { name: string; base: number }[];
}

const samples = JSON.parse(readFileSync(
  new URL('../../server/sim/testdata/golden/samples.json', import.meta.url), 'utf8',
)) as Samples;

function near(got: number, want: number, label: string): void {
  expect(Math.abs(got - want), label).toBeLessThanOrEqual(1e-9);
}

function windNear(got: Vec2, want: Vec2, label: string): void {
  near(got.x, want.x, `${label}.x`);
  near(got.z, want.z, `${label}.z`);
}

describe('render-only copies match native Go samples', () => {
  it('samples the Go-compiled wave field', () => {
    expect(samples.waves.length).toBeGreaterThan(0);
    const out = createWaveSample();
    for (const [index, sea] of samples.waves.entries()) {
      const cfg: WaveConfig = { ...sea.spec, components: sea.components, amplitudeLimit: sea.amplitudeLimit };
      near(waveAmplitude(cfg), sea.amplitude, `waves[${index}].amplitude`);
      expect(sea.points.length).toBeGreaterThan(0);
      for (const point of sea.points) {
        sampleWaves(cfg, point.x, point.z, point.t, point.depth, out);
        for (const key of Object.keys(point.out) as (keyof WaveSample)[]) {
          near(out[key], point.out[key], `waves[${index}] (${point.x}, ${point.z}, ${point.t}, ${point.depth}).${key}`);
        }
      }
    }
  });

  it('samples constant and gusting wind', () => {
    expect(samples.wind.length).toBeGreaterThan(0);
    for (const [index, field] of samples.wind.entries()) {
      expect(field.points.length).toBeGreaterThan(0);
      for (const point of field.points) {
        windNear(getWind(point, point.t, field.config), point.out, `wind[${index}] (${point.x}, ${point.z}, ${point.t})`);
      }
    }
  });

  it('matches gust velocity and speed factor at five sailing positions over ten minutes for both seeds', () => {
    expect(samples.windTime.map(({ config }) => config.gusts?.seed)).toEqual([1, 0x9e3779b9]);
    const positions = [BERTHS[0]!, BAY.harbour.departure,
      ...['N', 'E', 'S'].map((name) => buoyData.buoys.find((buoy) => buoy.name === name)!)];
    const expected = positions.flatMap(({ x, z }) => Array.from({ length: 21 }, (_, i) => `${x},${z},${i * 30}`)).sort();
    for (const field of samples.windTime) {
      expect(field.config.gusts?.enabled).toBe(true);
      expect(field.points.map(({ x, z, t }) => `${x},${z},${t}`).sort()).toEqual(expected);
      for (const point of field.points) {
        const label = `windTime seed ${field.config.gusts!.seed} (${point.x}, ${point.z}, ${point.t})`;
        windNear(getWind(point, point.t, field.config), point.wind, label);
        near(windSpeedFactor(point, point.t, field.config), point.factor, `${label}.factor`);
      }
    }
  });

  it('matches terrain elevation and landmark bases', () => {
    expect(samples.terrain.length).toBeGreaterThan(0);
    for (const point of samples.terrain) {
      near(terrainHeight(point.x, point.z), point.h, `terrain (${point.x}, ${point.z})`);
    }
    expect(LANDMARKS.map(({ name }) => name)).toEqual(samples.landmarks.map(({ name }) => name));
    for (const [index, landmark] of LANDMARKS.entries()) {
      near(landmark.base, samples.landmarks[index]!.base, `landmark ${landmark.name}.base`);
    }
  });
});
