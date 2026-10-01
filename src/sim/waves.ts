/**
 * Shared CPU/shader Gerstner model. GPU Gems ch. 1 §1.2.3 Eq. 9, with y up,
 * k = 2 pi / wavelength and omega = sqrt(g k) (Eq. 13). Direction is TO.
 * Phase = k dot(direction, label) - omega t + phase0.
 * Particle displacement = (Q A D cos(phase), A sin(phase)); its time derivative
 * supplies orbital velocity, attenuated by exp(k depth) below the surface.
 * Multiple components and the boat response are approximations, not a sea-state VPP.
 */
import parameters from '../data/waves.json';
import { DEG, G, clamp } from './frames';

export interface WaveComponent {
  readonly dx: number;
  readonly dz: number;
  readonly k: number;
  readonly omega: number;
  readonly amplitude: number;
  readonly phase: number;
  readonly choppiness: number;
}

export interface WaveConfig {
  enabled: boolean;
  amplitudeScale: number;
  /** Period of the primary component, seconds. */
  periodSeconds: number;
  /** Primary wave propagation TO compass bearing, degrees. */
  directionDeg: number;
  components: readonly WaveComponent[];
}

const components: readonly WaveComponent[] = parameters.waves.map((w) => {
  const k = 2 * Math.PI / w.wavelength;
  return Object.freeze({
    dx: Math.sin(w.directionDeg * DEG), dz: -Math.cos(w.directionDeg * DEG),
    k, omega: Math.sqrt(G * k), amplitude: w.amplitude, phase: w.phase, choppiness: w.choppiness,
  });
});

export function defaultWaves(): WaveConfig {
  // Headless/flat-water callers retain their existing behavior. main.ts enables browser waves.
  return {
    enabled: false, amplitudeScale: parameters.amplitudeScale,
    periodSeconds: 2 * Math.PI / components[0]!.omega,
    directionDeg: parameters.waves[0]!.directionDeg, components,
  };
}

export const WAVE_PARAMETERS = parameters;

/** Recompile the spectrum only when a period/direction control changes, not per sample. */
export function setWaveParameters(cfg: WaveConfig, periodSeconds: number, directionDeg: number): void {
  cfg.periodSeconds = clamp(periodSeconds, parameters.minPeriodSeconds, parameters.maxPeriodSeconds);
  cfg.directionDeg = ((directionDeg % 360) + 360) % 360;
  const periodRatio = cfg.periodSeconds * components[0]!.omega / (2 * Math.PI);
  const turn = (cfg.directionDeg - parameters.waves[0]!.directionDeg) * DEG;
  const c = Math.cos(turn), s = Math.sin(turn);
  cfg.components = components.map((w) => Object.freeze({
    ...w, dx: w.dx * c - w.dz * s, dz: w.dx * s + w.dz * c,
    k: w.k / (periodRatio * periodRatio), omega: w.omega / periodRatio,
  }));
}

export function waveAmplitude(cfg: WaveConfig): number {
  return cfg.enabled ? clamp(cfg.amplitudeScale, 0, parameters.maxAmplitudeScale) : 0;
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
 * small waves (maximum sum Q k A < 0.57 over allowed controls). No per-sample allocation.
 */
export function sampleWaves(
  cfg: WaveConfig, x: number, z: number, t: number, depth: number, out: WaveSample,
): WaveSample {
  let qx = x, qz = z;
  const scale = waveAmplitude(cfg);
  if (scale !== 0) {
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
  }
  return sampleWaveParticle(cfg, qx, qz, t, depth, out);
}

/**
 * GLSL specialization of this model, generated from the SAME compiled components.
 * Called once during material creation, never per frame. The shader exposes both
 * displacement and analytic tangents (not mesh finite-difference normals).
 * Footprint is the x/z sampling interval (mesh cell or pixel). Zero footprint
 * gives the unfiltered physical model. Nonzero footprints band-limit rendering,
 * not CPU physics; normals ignore derivatives of the slowly changing LOD weight.
 */
export function gerstnerGLSL(waves: readonly WaveComponent[]): string {
  return `
uniform vec4 waveShape[${waves.length}];
uniform vec3 waveMotion[${waves.length}];
void gerstnerWave(vec2 label, float time, float scale, vec2 footprint, out vec3 position, out vec3 normal) {
  position = vec3(label.x, 0.0, label.y);
  vec3 tx = vec3(1.0, 0.0, 0.0);
  vec3 tz = vec3(0.0, 0.0, 1.0);
  ${waves.map((_, i) => `{
    vec2 d = waveShape[${i}].xy;
    float k = waveShape[${i}].z;
    float phaseStep = k * max(abs(d.x) * footprint.x, abs(d.y) * footprint.y);
    float weight = 1.0 - smoothstep(
      ${(2 * Math.PI / parameters.waterFilterFullSamples).toFixed(10)},
      ${(2 * Math.PI / parameters.waterFilterZeroSamples).toFixed(10)}, phaseStep);
    float a = scale * waveShape[${i}].w * weight;
    float qa = a * waveMotion[${i}].z;
    float phase = k * dot(d, label) - waveMotion[${i}].x * time + waveMotion[${i}].y;
    float s = sin(phase), c = cos(phase);
    position += vec3(qa * d.x * c, a * s, qa * d.y * c);
    tx += vec3(-qa*k*d.x*d.x*s, a*k*d.x*c, -qa*k*d.x*d.y*s);
    tz += vec3(-qa*k*d.x*d.y*s, a*k*d.y*c, -qa*k*d.y*d.y*s);
  }`).join('\n')}
  normal = normalize(cross(tz, tx));
}
`;
}
