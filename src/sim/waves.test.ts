import { describe, expect, it } from 'vitest';
import { createWaveSample, defaultWaves, sampleWaveParticle, sampleWaves, setWaveParameters, waveAmplitude, WAVE_PARAMETERS } from './waves';

describe('shared Gerstner wave field', () => {
  const cfg = { ...defaultWaves(), enabled: true };

  it('has a flat surface and zero water velocity when disabled or at zero amplitude', () => {
    for (const flat of [{ ...cfg, enabled: false }, { ...cfg, amplitudeScale: 0 }]) {
      expect(sampleWaves(flat, 23, -17, 12, -0.4, createWaveSample())).toEqual({
        x: 23, y: 0, z: -17, slopeX: 0, slopeZ: 0, velocityX: 0, velocityY: 0, velocityZ: 0,
      });
    }
  });

  it('resolves displaced world coordinates and gives the actual surface gradient', () => {
    const max = { ...cfg, amplitudeScale: WAVE_PARAMETERS.maxAmplitudeScale };
    setWaveParameters(max, WAVE_PARAMETERS.minPeriodSeconds, 90);
    const h = 1e-4;
    for (const t of [0, 0.7, 3, 20]) {
      const particle = sampleWaveParticle(max, 2, -3, t, 0, createWaveSample());
      const surface = sampleWaves(max, particle.x, particle.z, t, 0, createWaveSample());
      expect(surface.x).toBeCloseTo(particle.x, 8);
      expect(surface.z).toBeCloseTo(particle.z, 8);
      expect(surface.y).toBeCloseTo(particle.y, 8);
      const px = sampleWaves(max, particle.x + h, particle.z, t, 0, createWaveSample());
      const nx = sampleWaves(max, particle.x - h, particle.z, t, 0, createWaveSample());
      const pz = sampleWaves(max, particle.x, particle.z + h, t, 0, createWaveSample());
      const nz = sampleWaves(max, particle.x, particle.z - h, t, 0, createWaveSample());
      expect(surface.slopeX).toBeCloseTo((px.y - nx.y) / (2 * h), 7);
      expect(surface.slopeZ).toBeCloseTo((pz.y - nz.y) / (2 * h), 7);
    }
  });

  it('orbital velocity is the time derivative of the displaced particle, including its sign', () => {
    const h = 1e-5;
    for (const depth of [0, -0.3, -2]) {
      const s = sampleWaveParticle(cfg, 1, 2, 0.7, depth, createWaveSample());
      const before = sampleWaveParticle(cfg, 1, 2, 0.7 - h, depth, createWaveSample());
      const after = sampleWaveParticle(cfg, 1, 2, 0.7 + h, depth, createWaveSample());
      expect(s.velocityX).toBeCloseTo((after.x - before.x) / (2 * h), 8);
      expect(s.velocityY).toBeCloseTo((after.y - before.y) / (2 * h), 8);
      expect(s.velocityZ).toBeCloseTo((after.z - before.z) / (2 * h), 8);
    }
  });

  it('single-wave orbits decay exponentially with depth, not with boat speed', () => {
    const single = { ...cfg, components: [cfg.components[0]!] };
    const surface = sampleWaveParticle(single, 0, 0, 0.5, 0, createWaveSample());
    const deep = sampleWaveParticle(single, 0, 0, 0.5, -1, createWaveSample());
    const factor = Math.exp(-single.components[0]!.k);
    expect(deep.velocityX).toBeCloseTo(surface.velocityX * factor, 12);
    expect(deep.velocityY).toBeCloseTo(surface.velocityY * factor, 12);
    expect(deep.y).toBeCloseTo(surface.y * factor, 12);
  });

  it('caps amplitude before the supplied spectrum can overturn', () => {
    const shortest = { ...cfg, amplitudeScale: 100 };
    setWaveParameters(shortest, WAVE_PARAMETERS.minPeriodSeconds, 90);
    const scale = waveAmplitude(shortest);
    expect(scale).toBe(WAVE_PARAMETERS.maxAmplitudeScale);
    const steepness = shortest.components.reduce((sum, w) => sum + w.k * w.amplitude * w.choppiness * scale, 0);
    expect(steepness).toBeLessThan(1);
    expect(waveAmplitude({ ...cfg, amplitudeScale: -1 })).toBe(0);
  });

  it('period controls obey dispersion and direction is propagation TO, not wind FROM', () => {
    const tuned = { ...cfg };
    setWaveParameters(tuned, 4, 180);
    const primary = tuned.components[0]!;
    expect(2 * Math.PI / primary.omega).toBeCloseTo(4, 12);
    expect(primary.omega ** 2 / primary.k).toBeCloseTo(9.81, 12);
    expect(primary.dx).toBeCloseTo(0, 12);
    expect(primary.dz).toBeCloseTo(1, 12);
    expect(primary.amplitude).toBe(cfg.components[0]!.amplitude);
    setWaveParameters(tuned, 100, -90);
    expect(tuned.periodSeconds).toBe(WAVE_PARAMETERS.maxPeriodSeconds);
    expect(tuned.directionDeg).toBe(270);
  });
});
