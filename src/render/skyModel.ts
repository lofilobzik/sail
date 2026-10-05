/**
 * Clear-sky atmosphere constants and a CPU evaluation of the same model the shared GLSL sky uses
 * (render/sky.ts). The CPU side only supplies uniforms, the horizon fog colour and the sun light
 * colour; the per-pixel sky is the GLSL. No Three.js imports.
 * Source: Preetham, Shirley, Smits, "A Practical Analytic Model for Daylight", as implemented in
 * three's examples Sky (node_modules/three/examples/jsm/objects/Sky.js, three 0.186.1).
 */
import { DEG, bearingToWorld, clamp } from '../sim/frames';
import skyData from '../../data/sky.json';

export const SKY = skyData;

export type Vec3 = [number, number, number];

// Sky.js constants: Rayleigh coefficients at 680/550/450 nm for air, Mie constant, zenith optical lengths.
export const TOTAL_RAYLEIGH: Vec3 = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
export const MIE_CONST: Vec3 = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
export const RAYLEIGH_ZENITH_LENGTH = 8.4e3; // m
export const MIE_ZENITH_LENGTH = 1.25e3; // m
export const CUTOFF_ANGLE = 1.6110731556870734; // earth-shadow hack, rad
export const STEEPNESS = 1.5;
export const EE = 1000;

export interface Atmosphere {
  betaR: Vec3;
  betaM: Vec3;
  sunE: number;
}

export function sunDirection(elevationDeg: number, azimuthDeg: number): Vec3 {
  const h = bearingToWorld(azimuthDeg * DEG);
  const el = elevationDeg * DEG;
  return [h.x * Math.cos(el), Math.sin(el), h.z * Math.cos(el)];
}

export function sunIntensity(zenithAngleCos: number): number {
  const c = clamp(zenithAngleCos, -1, 1);
  return EE * Math.max(0, 1 - Math.exp(-((CUTOFF_ANGLE - Math.acos(c)) / STEEPNESS)));
}

/** Scattering coefficients and sun intensity for a sun whose unit vector has height `sunY`. */
export function atmosphere(sunY: number, turbidity = SKY.turbidity): Atmosphere {
  const c = 0.2 * turbidity * 10e-18;
  return {
    betaR: TOTAL_RAYLEIGH.map((b) => b * SKY.rayleigh) as Vec3,
    betaM: MIE_CONST.map((m) => 0.434 * c * m * SKY.mieCoefficient) as Vec3,
    sunE: sunIntensity(sunY),
  };
}

/** Extinction toward a direction of height `dirY` (Sky.js optical length, cut off at the horizon). */
export function transmittance(atm: Atmosphere, dirY: number): Vec3 {
  const zenith = Math.acos(Math.max(0, dirY));
  const inverse = 1 / (Math.cos(zenith) + 0.15 * Math.pow(93.885 - (zenith * 180) / Math.PI, -1.253));
  const sR = RAYLEIGH_ZENITH_LENGTH * inverse;
  const sM = MIE_ZENITH_LENGTH * inverse;
  return [0, 1, 2].map((i) => Math.exp(-(atm.betaR[i]! * sR + atm.betaM[i]! * sM))) as Vec3;
}

/** Tone curve shared with the GLSL: display-range colour from raw radiance. */
export function toneMap(raw: Vec3): Vec3 {
  return raw.map((v) => 1 - Math.exp(-SKY.exposure * v)) as Vec3;
}

/** Cloud-free, sun-disc-free sky colour (linear, display range) toward a unit direction. */
export function clearSky(atm: Atmosphere, sun: Vec3, dir: Vec3): Vec3 {
  const fex = transmittance(atm, dir[1]);
  const cosTheta = dir[0] * sun[0] + dir[1] * sun[1] + dir[2] * sun[2];
  const rayleighPhase = (3 / (16 * Math.PI)) * (1 + Math.pow(cosTheta * 0.5 + 0.5, 2));
  const g = SKY.mieDirectionalG;
  const miePhase = (1 / (4 * Math.PI)) * ((1 - g * g) / Math.pow(1 - 2 * g * cosTheta + g * g, 1.5));
  const lowSun = clamp(Math.pow(1 - sun[1], 5), 0, 1);
  const raw = [0, 1, 2].map((i) => {
    const ratio = (atm.sunE * (atm.betaR[i]! * rayleighPhase + atm.betaM[i]! * miePhase)) / (atm.betaR[i]! + atm.betaM[i]!);
    let lin = Math.pow(ratio * (1 - fex[i]!), 1.5);
    lin *= 1 + (Math.pow(ratio * fex[i]!, 0.5) - 1) * lowSun;
    return (lin + 0.1 * fex[i]!) * 0.04 + [0, 0.0003, 0.00075][i]!;
  }) as Vec3;
  return toneMap(raw);
}

/** Sky.js day factor: 0 with the sun well below the horizon, 1 in daylight. */
export function dayFactor(sunY: number): number {
  const t = clamp((sunY + 0.08) / (0.3 + 0.08), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Sun light colour (normalised atmosphere transmittance toward the sun) and intensity. */
export function sunLight(atm: Atmosphere, sun: Vec3): { colour: Vec3; intensity: number } {
  const fex = transmittance(atm, sun[1]);
  const peak = Math.max(fex[0], fex[1], fex[2], 1e-6);
  return {
    colour: fex.map((v) => v / peak) as Vec3,
    intensity: SKY.sunLightIntensity * dayFactor(sun[1]),
  };
}

/** Hemisphere light intensity: full by day, a fraction when the sun is down. */
export function hemisphereIntensity(sunY: number): number {
  return SKY.hemisphereIntensity * (SKY.hemisphereNightFrac + (1 - SKY.hemisphereNightFrac) * dayFactor(sunY));
}
