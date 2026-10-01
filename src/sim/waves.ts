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
  bigScale: number;
  rippleScale: number;
  /** Fixed seed for strengths/phases; wind and sea controls never re-roll it. */
  seed: number;
  /** Wind driving the compiled sea, updated alongside the true wind by its owner. */
  windSpeedKn: number;
  /** Cached safe overall amplitude multiplier for the compiled components. */
  amplitudeLimit: number;
  /** Primary broad-wave period at reference wind, seconds. */
  periodSeconds: number;
  /** Primary wave propagation TO compass bearing, degrees. */
  directionDeg: number;
  components: readonly WaveComponent[];
}

const components: readonly WaveComponent[] = [...parameters.bigWaves, ...parameters.ripples].map((w) => {
  const k = 2 * Math.PI / w.wavelength;
  return Object.freeze({
    dx: Math.sin(w.directionOffsetDeg * DEG), dz: -Math.cos(w.directionOffsetDeg * DEG),
    k, omega: Math.sqrt(G * k), amplitude: w.amplitude, phase: w.phase, choppiness: w.choppiness,
  });
});

export function defaultWaves(seed = parameters.variation.seed): WaveConfig {
  // Headless/flat-water callers retain their existing behavior. main.ts enables browser waves.
  const cfg: WaveConfig = {
    enabled: false, amplitudeScale: parameters.amplitudeScale,
    bigScale: 1, rippleScale: 1, windSpeedKn: parameters.wind.referenceSpeedKn,
    seed,
    amplitudeLimit: parameters.maxAmplitudeScale,
    periodSeconds: 2 * Math.PI / components[0]!.omega,
    directionDeg: parameters.directionDeg, components,
  };
  compileWaves(cfg);
  return cfg;
}

export const WAVE_PARAMETERS = parameters;

/** Stateless 32-bit mixing: deterministic variation without per-sample randomness. */
function randomUnit(seed: number, index: number): number {
  let value = (seed + Math.imul(index + 1, 0x9e3779b9)) | 0;
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  return ((value ^ (value >>> 15)) >>> 0) / 0x100000000;
}

/** Recompile only when wind or sea controls change, never per frame/sample. */
function compileWaves(cfg: WaveConfig): void {
  const ratio = cfg.windSpeedKn / parameters.wind.referenceSpeedKn;
  const lengthRatio = Math.max(parameters.wind.minLengthRatio, ratio);
  const periodRatio = cfg.periodSeconds * components[0]!.omega / (2 * Math.PI)
    * lengthRatio ** parameters.wind.bigPeriodExponent;
  const rippleLength = lengthRatio ** parameters.wind.rippleLengthExponent;
  const bigHeight = ratio ** parameters.wind.bigHeightExponent * cfg.bigScale;
  const rippleHeight = ratio ** parameters.wind.rippleHeightExponent * cfg.rippleScale;
  const turn = cfg.directionDeg * DEG;
  const c = Math.cos(turn), s = Math.sin(turn);
  let steepness = 0;
  let height = 0;
  cfg.components = components.map((w, i) => {
    const big = i < parameters.bigWaves.length;
    const length = big ? periodRatio * periodRatio : rippleLength;
    const k = w.k / length;
    const strength = 1 + parameters.variation.amplitudeSpread * (2 * randomUnit(cfg.seed, i * 2) - 1);
    const amplitude = w.amplitude * (big ? bigHeight : rippleHeight) * strength;
    const phase = w.phase + 2 * Math.PI * randomUnit(cfg.seed, i * 2 + 1);
    steepness += k * amplitude * w.choppiness;
    height += amplitude;
    return Object.freeze({
      ...w, dx: w.dx * c - w.dz * s, dz: w.dx * s + w.dz * c,
      k, omega: Math.sqrt(G * k), amplitude, phase,
    });
  });
  cfg.amplitudeLimit = height === 0 ? 0
    : Math.min(parameters.maxAmplitudeScale, parameters.maxSteepness / steepness);
}

export function setWaveParameters(cfg: WaveConfig, periodSeconds: number, directionDeg: number): void {
  cfg.periodSeconds = clamp(periodSeconds, parameters.minPeriodSeconds, parameters.maxPeriodSeconds);
  cfg.directionDeg = ((directionDeg % 360) + 360) % 360;
  compileWaves(cfg);
}

export function setWaveWind(cfg: WaveConfig, speedKn: number): void {
  const speed = Math.max(0, speedKn);
  if (cfg.windSpeedKn === speed) return;
  cfg.windSpeedKn = speed;
  compileWaves(cfg);
}

export function setWaveLayers(cfg: WaveConfig, bigScale: number, rippleScale: number): void {
  cfg.bigScale = clamp(bigScale, 0, parameters.maxLayerScale);
  cfg.rippleScale = clamp(rippleScale, 0, parameters.maxLayerScale);
  compileWaves(cfg);
}

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
 */
export function gerstnerGLSL(waves: readonly WaveComponent[]): string {
  return `
uniform vec4 waveShape[${waves.length}];
uniform vec2 waveMotion[${waves.length}];
void gerstnerWave(vec2 label, float scale, vec2 footprint, out vec3 position, out vec3 normal) {
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
    if (a != 0.0) {
      float qa = a * waveMotion[${i}].y;
      float phase = k * dot(d, label) + waveMotion[${i}].x;
      float s = sin(phase), c = cos(phase);
      position += vec3(qa * d.x * c, a * s, qa * d.y * c);
      tx += vec3(-qa*k*d.x*d.x*s, a*k*d.x*c, -qa*k*d.x*d.y*s);
      tz += vec3(-qa*k*d.x*d.y*s, a*k*d.y*c, -qa*k*d.y*d.y*s);
    }
  }`).join('\n')}
  normal = normalize(cross(tz, tx));
}
`;
}
