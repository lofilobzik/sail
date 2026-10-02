/**
 * Boat wake and bow wave for the water shader (visual only, reads sim state). Keeps a
 * world-anchored trail of the waterline stem and fills the uniforms used by the GLSL in
 * render/wake/kelvin.ts. Source amplitude comes from the sim's Delft residuary resistance.
 */
import * as THREE from 'three';
import { delftUpright, type BoatModel, type EnvironmentConfig, type Vec2 } from '../sim';
import { createWaveSample, sampleWaves, type WaveConfig } from '../sim/waves';
import type { BoatLayout } from './boatLayout';
import { WAKE, bowWaveHeight, wakeSourceAmplitude } from './wake/kelvin';
import { WakeTrail } from './wake/trail';

export interface WakePose {
  /** Logical world position of the sim reference point, m. */
  x: number;
  z: number;
  heading: number;
  /** Surge speed through the water, m/s. */
  surge: number;
  /** Simulation time, s. */
  t: number;
}

const TWO_PI = 2 * Math.PI;
const mod = (v: number, m: number) => ((v % m) + m) % m;
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
};

export class WakeView {
  enabled = true;
  readonly uniforms = {
    wakeA: { value: new Float32Array(WAKE.trailPoints * 4) },
    wakeB: { value: new Float32Array(WAKE.trailPoints * 4) },
    wakeCount: { value: 0 },
    wakeStem: { value: new THREE.Vector4(0, 0, 0, -1) },
    wakeHull: { value: new THREE.Vector4() },
    wakeProfile: { value: new Float32Array(WAKE.hullProfileSamples) },
    wakeFoam: { value: new THREE.Vector4() },
    wakeFoamPhase: { value: new THREE.Vector3() },
  };
  private readonly trail = new WakeTrail(WAKE);
  private readonly stemSurface = createWaveSample();
  /** Body x of the waterline stem, m. */
  private readonly stemX: number;

  constructor(
    private readonly model: BoatModel,
    layout: BoatLayout,
    private readonly env: EnvironmentConfig,
  ) {
    // Waterline stem: first station from the bow whose keel is below the waterline.
    let stem = layout.bowX;
    const step = layout.loa / 400;
    while (stem > layout.transomX && layout.keelAt(stem) >= 0) stem -= step;
    this.stemX = stem;
    const length = stem - layout.transomX;
    const profile = this.uniforms.wakeProfile.value;
    for (let i = 0; i < profile.length; i++) {
      profile[i] = layout.waterlineHalfBeamAt(stem - (i / (profile.length - 1)) * length);
    }
    this.uniforms.wakeHull.value.set(0, length, 0, model.cfg.hull.beam);
  }

  /**
   * `hullY` is the rendered height of the boat's reference point (wave heave). If the pitched bow
   * rises above the local water surface at the stem, the bow wave and bow foam fade out with the gap.
   */
  update(pose: WakePose & { pitch: number }, origin: Readonly<Vec2>, waves: WaveConfig, hullY: number): void {
    const u = this.uniforms;
    const fx = Math.sin(pose.heading);
    const fz = -Math.cos(pose.heading);
    const stemX = pose.x + fx * this.stemX;
    const stemZ = pose.z + fz * this.stemX;
    const speed = this.enabled && pose.surge > WAKE.minSpeed ? pose.surge : 0;
    const residuary = speed > 0 ? delftUpright(this.model, speed, this.env).residuary : 0;
    const amplitude = WAKE.visualGain * wakeSourceAmplitude(residuary, this.env.rhoWater, this.model.cfg.hull.beam);

    if (this.enabled) {
      this.trail.update({ x: stemX, z: stemZ, speed, amplitude, time: pose.t });
      u.wakeCount.value = this.trail.pack(origin, u.wakeA.value, u.wakeB.value);
    } else {
      this.trail.clear();
      u.wakeCount.value = 0;
    }
    u.wakeStem.value.set(stemX - origin.x, stemZ - origin.z, fx, fz);
    sampleWaves(waves, stemX, stemZ, pose.t, 0, this.stemSurface);
    const gap = hullY + Math.sin(pose.pitch) * this.stemX - this.stemSurface.y;
    const inWater = 1 - smoothstep(WAKE.bowLiftFadeStart, WAKE.bowLiftFadeEnd, gap);
    const hull = u.wakeHull.value;
    hull.x = bowWaveHeight(speed) * inWater;
    hull.z = Math.min(Math.max((speed - WAKE.foamMinSpeed) / WAKE.foamSpeedRange, 0), 1);

    // Foam noise stays world-anchored: reduce the origin modulo its period in doubles.
    const period = WAKE.foamNoisePeriod;
    u.wakeFoam.value.set(mod(origin.x, period), mod(origin.z, period), 0, 0);
    const [r0, r1, r2] = WAKE.foamNoiseRates as [number, number, number];
    u.wakeFoamPhase.value.set(mod(r0 * pose.t, TWO_PI), mod(r1 * pose.t, TWO_PI), mod(r2 * pose.t, TWO_PI));
  }
}
