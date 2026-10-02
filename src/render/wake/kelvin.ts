/**
 * Visual Kelvin wake and bow wave (no Three.js: testable under Node). Visual only: the
 * boat's own wake never feeds back into the sim. The energy that makes it is the
 * residuary (wave-making) resistance the sim already charges the hull (data/wake.json).
 *
 * The pattern is written in trail coordinates: s = arc length behind the stem along the
 * world-anchored trail, n = signed distance off the trail. It is stationary in the boat
 * frame (deep-water dispersion, phase speed of each system = V cos(angle)):
 *   transverse  k_t = g / V^2,                phase k_t s
 *   divergent   k_d = g / (V cos(35.26))^2,   phase k_d (s cos 35.26 + |n| sin 35.26)
 * Divergent waves concentrate near the cusp lines |n| = s tan(19.47); transverse waves fill
 * the wedge. Amplitudes decay as s^-1/3 and s^-1/2 behind one transverse wavelength, and
 * with trail age. `kelvinWake` (TS) and `wakeGLSL` (shader) implement the same formula;
 * the tests exercise the TS version.
 */
import wake from '../../data/wake.json';

export const WAKE = wake;
const G = 9.81;
const DEG = Math.PI / 180;
const TAN_ALPHA = Math.tan(wake.kelvinHalfAngleDeg * DEG);
const COS_T = Math.cos(wake.cuspWaveAngleDeg * DEG);
const SIN_T = Math.sin(wake.cuspWaveAngleDeg * DEG);
/** Filter like the water grid: full detail at 8 samples per wavelength, none below 4. */
const FILTER_FULL = (2 * Math.PI) / 8;
const FILTER_ZERO = (2 * Math.PI) / 4;

/** Source amplitude from wave-making resistance: R_w = 1/2 rho g A^2 * width. */
export function wakeSourceAmplitude(residuaryN: number, rhoWater: number, beam: number): number {
  const width = wake.effectiveWidthFracBeam * beam;
  return residuaryN > 0 ? Math.sqrt((2 * residuaryN) / (rhoWater * G * width)) : 0;
}

/** Bow wave crest height, a fraction of the stagnation head V^2 / 2g. */
export function bowWaveHeight(speed: number): number {
  return speed > wake.minSpeed ? (wake.bowHeadFrac * speed * speed) / (2 * G) : 0;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

const filterWeight = (phaseStep: number) => 1 - smoothstep(FILTER_FULL, FILTER_ZERO, phaseStep);

export interface WakeSample {
  h: number;
  dhds: number;
  dhdn: number;
}

/**
 * Height and gradient in trail coordinates. `fade` (0..1) covers points off the ends of
 * the trail; `footprint` is the sampling cell size in metres (0 = unfiltered).
 */
export function kelvinWake(
  s: number,
  n: number,
  speed: number,
  amplitude: number,
  age: number,
  fade: number,
  footprint: number,
  out: WakeSample,
): WakeSample {
  out.h = out.dhds = out.dhdn = 0;
  const amp = amplitude * fade * Math.exp(-age / wake.decayTime);
  if (speed < wake.minSpeed || amp <= 0) return out;
  const sp = Math.max(s, 0);
  const an = Math.abs(n);
  const kt = G / (speed * speed);
  const lambda = (2 * Math.PI) / kt;
  const kd = kt / (COS_T * COS_T);
  const sRef = Math.max(sp, lambda);
  const start = smoothstep(0, wake.startLength, sp);

  const sigma = wake.armWidthFracWavelength * lambda + wake.armWidthGrowth * sp;
  const x = an - sp * TAN_ALPHA;
  const envD = Math.exp((-0.5 * x * x) / (sigma * sigma)) * start;
  const ad = amp * (lambda / sRef) ** wake.divergentDecayExponent * envD * filterWeight(kd * footprint);
  const phd = kd * (sp * COS_T + an * SIN_T);

  const wedge = Math.max(sp * TAN_ALPHA, 1e-3);
  const envT = (1 - smoothstep(0.6, 1.0, an / wedge)) * start;
  const at = wake.transverseFrac * amp * (lambda / sRef) ** wake.transverseDecayExponent * envT * filterWeight(kt * footprint);
  const pht = kt * sp;

  out.h = ad * Math.sin(phd) + at * Math.sin(pht);
  out.dhds = ad * kd * COS_T * Math.cos(phd) + at * kt * Math.cos(pht);
  out.dhdn = Math.sign(n) * ad * kd * SIN_T * Math.cos(phd);
  return out;
}

const f = (v: number) => v.toFixed(10);

/**
 * Shader code. Uniforms (filled by render/wake.ts):
 *   wakeA[N] (local x, local z, s, speed), wakeB[N] (amplitude, age, 0, 0), wakeCount,
 *   wakeStem (local x, z of the waterline stem, forward unit x, z),
 *   wakeHull (bow wave height, waterline length, foam speed factor, beam),
 *   wakeWet (metres aft of the design stem, signed starboard offset of the current hull/sea contact),
 *   wakeProfile[P] waterline half-beam from stem (a = 0) to transom (a = Lwl),
 *   wakeFoam (noise origin offset x, z mod period, 0, 0), wakeFoamPhase (drift phases).
 * `wakeFrameGLSL` is vertex-only (trail search); `wakeShadeGLSL` is shared.
 */
export function wakeShadeGLSL(): string {
  const P = wake.hullProfileSamples;
  const k = (2 * Math.PI) / wake.foamNoisePeriod;
  return `
uniform vec4 wakeStem;
uniform vec4 wakeHull;
uniform vec2 wakeWet;
uniform float wakeProfile[${P}];
uniform vec4 wakeFoam;
uniform vec3 wakeFoamPhase;

float wakeFilter(float phaseStep) {
  return 1.0 - smoothstep(${f(FILTER_FULL)}, ${f(FILTER_ZERO)}, phaseStep);
}

// Height and trail-space gradient (h, dh/ds, dh/dn); mirrors kelvinWake in kelvin.ts.
vec3 kelvinWake(vec4 sn, vec4 props, float footprint) {
  float speed = props.x;
  float amp = props.y * props.w * exp(-props.z / ${f(wake.decayTime)});
  if (speed < ${f(wake.minSpeed)} || amp <= 0.0) return vec3(0.0);
  float s = max(sn.x, 0.0);
  float an = abs(sn.y);
  float kt = ${f(G)} / (speed * speed);
  float lambda = 6.2831853072 / kt;
  float kd = kt / ${f(COS_T * COS_T)};
  float sRef = max(s, lambda);
  float start = smoothstep(0.0, ${f(wake.startLength)}, s);
  float sigma = ${f(wake.armWidthFracWavelength)} * lambda + ${f(wake.armWidthGrowth)} * s;
  float x = an - s * ${f(TAN_ALPHA)};
  float envD = exp(-0.5 * x * x / (sigma * sigma)) * start;
  float ad = amp * pow(lambda / sRef, ${f(wake.divergentDecayExponent)}) * envD * wakeFilter(kd * footprint);
  float phd = kd * (s * ${f(COS_T)} + an * ${f(SIN_T)});
  float wedge = max(s * ${f(TAN_ALPHA)}, 1e-3);
  float envT = (1.0 - smoothstep(0.6, 1.0, an / wedge)) * start;
  float at = ${f(wake.transverseFrac)} * amp * pow(lambda / sRef, ${f(wake.transverseDecayExponent)}) * envT * wakeFilter(kt * footprint);
  float pht = kt * s;
  return vec3(
    ad * sin(phd) + at * sin(pht),
    ad * kd * ${f(COS_T)} * cos(phd) + at * kt * cos(pht),
    sign(sn.y) * ad * kd * ${f(SIN_T)} * cos(phd));
}

// Hull-relative coordinates: a = metres aft of the waterline stem, b = |offset| from the centreline.
vec2 wakeHullCoords(vec2 p) {
  vec2 d = p - wakeStem.xy;
  vec2 fwd = wakeStem.zw;
  return vec2(-dot(d, fwd), abs(fwd.x * d.y - fwd.y * d.x));
}

float wakeHalfBeam(float a) {
  if (a <= 0.0 || a >= wakeHull.y) return 0.0;
  float u = a / wakeHull.y * ${f(P - 1)};
  int i = int(floor(u));
  float t = u - float(i);
  return mix(wakeProfile[i], wakeProfile[min(i + 1, ${P - 1})], t);
}

// 0 inside the waterline footprint of the hull, 1 outside.
float wakeHullMask(vec2 p) {
  vec2 ab = wakeHullCoords(p);
  if (ab.x <= 0.0 || ab.x >= wakeHull.y) return 1.0;
  float c = wakeHalfBeam(ab.x);
  return smoothstep(c - 0.03, c + 0.03, ab.y);
}

// Bow wave: a > shaped chevron leaving the foremost wetted hull point.
// wakeWet is its horizontal heading-frame offset, including pitch and heel.
float wakeBow(vec2 p) {
  float height = wakeHull.x;
  if (height <= 0.0) return 0.0;
  vec2 d = p - wakeStem.xy;
  vec2 fwd = wakeStem.zw;
  float x = -dot(d, fwd) - wakeWet.x;
  float b = abs(fwd.x * d.y - fwd.y * d.x - wakeWet.y);
  float a = max(x, 0.0);
  float along = smoothstep(-${f(wake.bowAhead)}, 0.0, x) * exp(-a / ${f(wake.bowLength)});
  float crest = ${f(wake.bowOffset)} + a * ${f(Math.tan(wake.bowAngleDeg * DEG))};
  float u = (b - crest) / (${f(wake.bowWidth)} + ${f(wake.bowWidthGrowth)} * a);
  return height * along * exp(-u * u);
}

// The bow crest is a Gaussian of width bowWidth: resolved while the sampling cell is
// no larger than that width, faded out by twice it.
float wakeBowFilter(float footprint) {
  return 1.0 - smoothstep(${f(wake.bowWidth)}, ${f(2 * wake.bowWidth)}, footprint);
}

// World-anchored foam noise in 0..1; wavenumbers are whole multiples of 2 pi / period so the
// pattern tiles with the origin offset reduced modulo the period on the CPU.
float wakeNoise(vec2 p, float footprint) {
  vec2 q = p + wakeFoam.xy;
  float n = sin(dot(q, vec2(${f(97 * k)}, ${f(23 * k)})) + wakeFoamPhase.x)
          * sin(dot(q, vec2(${f(-31 * k)}, ${f(89 * k)})) + wakeFoamPhase.y)
          + 0.5 * sin(dot(q, vec2(${f(151 * k)}, ${f(-127 * k)})) + wakeFoamPhase.z);
  float detail = wakeFilter(${f(Math.hypot(151, 127) * k)} * footprint);
  return mix(0.5, 0.5 + 0.33 * n, detail);
}

// Foam coverage 0..1: turbulent wake behind the transom plus whitewater on the bow wave.
float wakeFoamAmount(vec2 p, vec4 sn, vec4 props, float bow, float footprint) {
  float speedFactor = wakeHull.z;
  if (speedFactor <= 0.0) return 0.0;
  float age = props.z;
  float behindTransom = sn.x - wakeHull.y;
  float width = ${f(wake.foamWidthFracBeam)} * wakeHull.w + ${f(wake.foamSpreadRate)} * age;
  float turbulent = (1.0 - smoothstep(0.5 * width, width, abs(sn.y)))
    * smoothstep(-0.2, 0.4, behindTransom) * exp(-age / ${f(wake.foamFadeTime)}) * props.w * wakeHullMask(p);
  float crest = smoothstep(${f(wake.foamBowThreshold)}, 1.0, bow / max(wakeHull.x, 1e-4));
  float coverage = speedFactor * max(turbulent, crest);
  float noise = wakeNoise(p, footprint);
  // Boost so the turbulent core is a continuous streak and only its edges break up into patches.
  float boosted = min(coverage * 1.8, 1.0);
  return smoothstep(1.0 - boosted, 1.0 - boosted + 0.3, noise) * boosted;
}
`;
}

export function wakeFrameGLSL(): string {
  const N = wake.trailPoints;
  return `
uniform vec4 wakeA[${N}];
uniform vec4 wakeB[${N}];
uniform int wakeCount;

// Nearest trail segment: sn = (s, n, tangent x, tangent z), props = (speed, amplitude, age, fade).
void wakeFrame(vec2 p, out vec4 sn, out vec4 props) {
  float best = 1e9;
  sn = vec4(0.0, 1e4, 1.0, 0.0);
  props = vec4(0.0);
  for (int i = 0; i < ${N - 1}; i++) {
    if (i + 1 >= wakeCount) break;
    vec2 a = wakeA[i].xy;
    vec2 seg = wakeA[i + 1].xy - a;
    float len2 = dot(seg, seg);
    if (len2 < 1e-8) continue;
    float t = dot(p - a, seg) / len2;
    float tc = clamp(t, 0.0, 1.0);
    vec2 q = a + seg * tc;
    float d = distance(p, q);
    if (d < best) {
      best = d;
      float len = sqrt(len2);
      vec2 tangent = seg / len;
      // Points ahead of the stem or beyond the oldest point fade out instead of
      // reading a clamped, sideways-stretched pattern.
      float outside = (i == 0 ? max(-t, 0.0) : 0.0) + (i + 2 == wakeCount ? max(t - 1.0, 0.0) : 0.0);
      sn = vec4(mix(wakeA[i].z, wakeA[i + 1].z, tc), dot(p - q, vec2(-tangent.y, tangent.x)), tangent);
      props = vec4(
        mix(wakeA[i].w, wakeA[i + 1].w, tc),
        mix(wakeB[i].x, wakeB[i + 1].x, tc),
        mix(wakeB[i].y, wakeB[i + 1].y, tc),
        1.0 - smoothstep(0.0, ${f(wake.tailFade)}, outside * len));
    }
  }
}
`;
}
