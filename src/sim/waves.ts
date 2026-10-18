/**
 * Render-only copy of server/sim/waves.go: drawing only. Gameplay (forces, wind on the sail, grounding, buoy checks) comes from the Go physics (src/physics). Kept equal by src/sim/renderParity.test.ts.
 */
/**
 * Shared CPU/shader Gerstner model. GPU Gems ch. 1 §1.2.3 Eq. 9, with y up,
 * k = 2 pi / wavelength and omega = sqrt(g k) (Eq. 13). Direction is TO.
 * Phase = k dot(direction, label) - omega t + phase0.
 * Particle displacement = (Q A D cos(phase), A sin(phase)); its time derivative
 * supplies orbital velocity, attenuated by exp(k depth) below the surface.
 * Multiple components and the boat response are approximations, not a sea-state VPP.
 */
import parameters from '../../data/waves.json';
import { clamp } from './frames';
import type { WaveComponent, WaveConfig } from '../physics/types';

export const WAVE_PARAMETERS = parameters;

export function waveAmplitude(cfg: WaveConfig): number {
  return cfg.enabled ? clamp(cfg.amplitudeScale, 0, cfg.amplitudeLimit) : 0;
}

export interface WaveSample {
  /** Displaced world position; y is elevation, not depth. */
  x: number;
  y: number;
  z: number;
  /** Eulerian surface gradients dy/dx, dy/dz. */
  slopeX: number;
  slopeZ: number;
  /** Particle orbital velocity, world axes, m/s. */
  velocityX: number;
  velocityY: number;
  velocityZ: number;
}

export function createWaveSample(): WaveSample {
  return { x: 0, y: 0, z: 0, slopeX: 0, slopeZ: 0, velocityX: 0, velocityY: 0, velocityZ: 0 };
}

/** Sample a particle label, matching the shader. `depth` <= 0 is below local surface. */
export function sampleWaveParticle(
  cfg: WaveConfig, x: number, z: number, t: number, depth: number, out: WaveSample,
): WaveSample {
  const scale = waveAmplitude(cfg);
  let px = x, py = 0, pz = z;
  let jxx = 1, jxz = 0, jzz = 1, hx = 0, hz = 0;
  let vx = 0, vy = 0, vz = 0;
  if (scale !== 0) for (const w of cfg.components) {
    const a = scale * w.amplitude * Math.exp(w.k * Math.min(depth, 0));
    const phase = w.k * (w.dx * x + w.dz * z) - w.omega * t + w.phase;
    const s = Math.sin(phase), c = Math.cos(phase);
    const qa = w.choppiness * a;
    px += qa * w.dx * c;
    py += a * s;
    pz += qa * w.dz * c;
    const horizontalDerivative = -qa * w.k * s;
    jxx += horizontalDerivative * w.dx * w.dx;
    jxz += horizontalDerivative * w.dx * w.dz;
    jzz += horizontalDerivative * w.dz * w.dz;
    hx += a * w.k * w.dx * c;
    hz += a * w.k * w.dz * c;
    vx += qa * w.omega * w.dx * s;
    vy -= a * w.omega * c;
    vz += qa * w.omega * w.dz * s;
  }
  const determinant = jxx * jzz - jxz * jxz;
  out.x = px; out.y = py; out.z = pz;
  out.slopeX = (hx * jzz - hz * jxz) / determinant;
  out.slopeZ = (hz * jxx - hx * jxz) / determinant;
  out.velocityX = vx; out.velocityY = vy; out.velocityZ = vz;
  return out;
}

/**
 * Eulerian lookup: invert horizontal Gerstner displacement before sampling at a
 * boat/foil's world position. Fixed-point iteration is contractive for the supplied
 * waves (effective sum Q k A <= 0.6 over sea controls). No per-sample allocation.
 */
export function sampleWaves(
  cfg: WaveConfig, x: number, z: number, t: number, depth: number, out: WaveSample,
): WaveSample {
  return sampleWavesNear(cfg, x, z, t, depth, out, COLD_START, 0);
}

const COLD_START = new Float64Array(2);

/**
 * sampleWaves with the inversion started from a known horizontal displacement instead of none:
 * `offsets[2 * slot]`, `offsets[2 * slot + 1]` hold the displacement (world minus particle label)
 * at this or a nearby point, e.g. last frame's. The iteration has a unique fixed point, so a good
 * guess only reaches it in fewer passes. The converged displacement is written back to the slot.
 */
export function sampleWavesNear(
  cfg: WaveConfig, x: number, z: number, t: number, depth: number, out: WaveSample,
  offsets: Float64Array, slot: number,
): WaveSample {
  let qx = x, qz = z;
  const scale = waveAmplitude(cfg);
  if (scale !== 0) {
    qx -= offsets[2 * slot]!;
    qz -= offsets[2 * slot + 1]!;
    // Covers the shortest allowed period at maximum amplitude; exits early for light chop.
    for (let i = 0; i < 48; i++) {
      // Inversion only needs horizontal displacement, not normals or velocity.
      let ex = qx - x, ez = qz - z;
      for (const w of cfg.components) {
        const qa = scale * w.amplitude * w.choppiness * Math.exp(w.k * Math.min(depth, 0));
        const c = Math.cos(w.k * (w.dx * qx + w.dz * qz) - w.omega * t + w.phase);
        ex += qa * w.dx * c;
        ez += qa * w.dz * c;
      }
      qx -= ex; qz -= ez;
      if (Math.abs(ex) + Math.abs(ez) < 1e-10) break;
    }
    if (offsets !== COLD_START) {
      offsets[2 * slot] = x - qx;
      offsets[2 * slot + 1] = z - qz;
    }
  }
  return sampleWaveParticle(cfg, qx, qz, t, depth, out);
}

/**
 * Phase at a logical-world origin, reduced in double precision before GPU upload.
 * The shader adds only the nearby label's spatial phase; neither large world
 * coordinates nor elapsed time enter float32 arithmetic. CPU sampling is unchanged.
 */
export function wavePhaseAt(w: WaveComponent, x: number, z: number, t: number): number {
  const phase = (w.k * (w.dx * x + w.dz * z) - w.omega * t + w.phase) % (2 * Math.PI);
  return phase > Math.PI ? phase - 2 * Math.PI : phase < -Math.PI ? phase + 2 * Math.PI : phase;
}

/**
 * GLSL specialization of this model, generated from the SAME compiled components.
 * Called once during material creation, never per frame. The shader exposes both
 * displacement and analytic tangents (not mesh finite-difference normals).
 * Labels/positions are render-local. waveMotion holds the reduced phase at the
 * render origin and choppiness; upload it using wavePhaseAt for the rendered time.
 * Footprint is the x/z sampling interval (mesh cell or pixel). Zero footprint
 * gives the unfiltered physical model. Nonzero footprints band-limit rendering,
 * not CPU physics; normals ignore derivatives of the slowly changing LOD weight.
 * Components from `bigCount` on (the ripples) are skipped together when the footprint is at least
 * the `waveRippleCutoff` uniform (see rippleCutoff): each of them would have weight exactly 0.
 */
export function gerstnerGLSL(waves: readonly WaveComponent[], bigCount: number): string {
  const block = (i: number) => `{
    vec2 d = waveShape[${i}].xy;
    float k = waveShape[${i}].z;
    float phaseStep = k * max(abs(d.x) * footprint.x, abs(d.y) * footprint.y);
    float weight = 1.0 - smoothstep(
      ${(2 * Math.PI / parameters.waterFilterFullSamples).toFixed(10)},
      ${(2 * Math.PI / parameters.waterFilterZeroSamples).toFixed(10)}, phaseStep);
    float a = scale * waveShape[${i}].w * weight;
    if (a != 0.0) {
      float qa = a * waveMotion[${i}].y;
      float phase = k * dot(d, label) + waveMotion[${i}].x;
      float s = sin(phase), c = cos(phase);
      position += vec3(qa * d.x * c, a * s, qa * d.y * c);
      tx += vec3(-qa*k*d.x*d.x*s, a*k*d.x*c, -qa*k*d.x*d.y*s);
      tz += vec3(-qa*k*d.x*d.y*s, a*k*d.y*c, -qa*k*d.y*d.y*s);
    }
  }`;
  const indices = waves.map((_, i) => i);
  return `
uniform vec4 waveShape[${waves.length}];
uniform vec2 waveMotion[${waves.length}];
uniform float waveRippleCutoff;
void gerstnerWave(vec2 label, float scale, vec2 footprint, out vec3 position, out vec3 normal) {
  position = vec3(label.x, 0.0, label.y);
  vec3 tx = vec3(1.0, 0.0, 0.0);
  vec3 tz = vec3(0.0, 0.0, 1.0);
  ${indices.slice(0, bigCount).map(block).join('\n')}
  if (min(footprint.x, footprint.y) < waveRippleCutoff) {
    ${indices.slice(bigCount).map(block).join('\n')}
  }
  normal = normalize(cross(tz, tx));
}
`;
}

/**
 * Smallest footprint at which every ripple (components from `bigCount` on) is filtered to weight 0:
 * a ripple's weight is 0 once k * max(|dx| fx, |dz| fz) >= 2 pi / zeroSamples, and that is at least
 * k * min(fx, fz) / sqrt(2) for a unit direction. 0 when there are no ripples.
 */
export function rippleCutoff(waves: readonly WaveComponent[], bigCount: number): number {
  const ripples = waves.slice(bigCount);
  if (ripples.length === 0) return 0;
  return (2 * Math.PI / parameters.waterFilterZeroSamples) * Math.SQRT2 / Math.min(...ripples.map((w) => w.k));
}
