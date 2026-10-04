/**
 * Analytic sky shared by the dome and the water. One GLSL function (`skyRadiance`) is the sky:
 * the dome shades with it, the water reflects it and fogs toward it, so horizon, sun and clouds
 * always agree. Adapted from three's examples Sky (Preetham daylight model with its procedural
 * clouds); see data/sky.json `sources`. Fixed sun, wind-driven cloud drift, no renderer tone mapping.
 */
import * as THREE from 'three';
import type { Vec2 } from '../sim';
import {
  SKY, atmosphere, clearSky, dayFactor, hemisphereIntensity, sunDirection, sunLight,
  type Atmosphere, type Vec3,
} from './skyModel';

const SKY_RADIUS = 25000; // m: beyond the farthest land and water edge (20 km), inside the 30 km far plane
const DOME_SEGMENTS: [number, number] = [32, 16]; // smooth horizon silhouette; shading is per pixel
const SUN_LIGHT_DISTANCE = 100; // m: only the direction matters
// Sky.js: evolve = time * cloudSpeed * 300 with cloudSpeed 0.00002, per second of sim time.
const CLOUD_EVOLVE_RATE = 0.00002 * 300;
const NOISE_SIZE = 256; // texels per side of the tiling cloud noise texture
const NOISE_SEED = 1987; // TUNING GUESS: any seed gives a valid sky; fixed for repeatable looks
// Cloud-plane offsets wrap here: 1000 * 2.56 and 300 * 2.56 are both whole texture periods, so
// the fbm (x1000) and coverage (x300) lookups repeat exactly and the float offset stays small.
const CLOUD_OFFSET_PERIOD = 2.56;
// Standard deviation of Sky.js's gradient noise (x1.6) over that of smoothed value noise in [-1, 1],
// both measured on 40000 random samples (0.282 / 0.449), so cloud coverage thresholds behave alike.
const NOISE_GAIN = 0.63;

const f = (x: number): string => (Number.isInteger(x) ? x.toFixed(1) : String(x));

/** Tiling single-channel random lattice for the cloud noise; seeded, so every run draws the same sky. */
function createNoiseTexture(): THREE.DataTexture {
  const data = new Uint8Array(NOISE_SIZE * NOISE_SIZE);
  let state = NOISE_SEED;
  for (let i = 0; i < data.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0; // Numerical Recipes LCG
    data[i] = state >>> 24;
  }
  const texture = new THREE.DataTexture(data, NOISE_SIZE, NOISE_SIZE, THREE.RedFormat, THREE.UnsignedByteType);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** Uniforms and `skyRadiance(dir, octaves, sunDisc, cloudWeight)`; display-range linear colour. */
export function skyGLSL(): string {
  return `
uniform vec3 skySun;
uniform vec3 skyBetaR;
uniform vec3 skyBetaM;
uniform float skySunE;
uniform vec4 skyCloud; // coverage, density, cloud-plane offset x, z
uniform float skyEvolve;
uniform sampler2D skyNoiseTexture;

// Smoothed value noise in about [-1, 1]: the quintic fade moves the sample between two texel
// centres so hardware bilinear filtering does the interpolation, one fetch per call.
float skyNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 fr = fract(p);
  vec2 u = fr * fr * fr * (fr * (fr * 6.0 - 15.0) + 10.0);
  return (texture2D(skyNoiseTexture, (i + u + 0.5) / ${f(NOISE_SIZE)}).r * 2.0 - 1.0) * ${f(NOISE_GAIN)};
}

float skyFbm(vec2 p, float drift, int octaves) {
  float result = 0.0;
  float amplitude = 1.0;
  for (int i = 0; i < 4; i++) {
    if (i >= octaves) break;
    result += amplitude * skyNoise(p);
    amplitude *= 0.5;
    p = p * 2.0 + drift;
  }
  return result;
}

// dir: unit view direction. octaves: cloud detail (0 = clear sky). sunDisc: 0 or 1.
// cloudWeight: 0..1 cloud opacity multiplier, so callers can fade clouds out smoothly.
vec3 skyRadiance(vec3 dir, int octaves, float sunDisc, float cloudWeight) {
  float zenithAngle = acos(max(0.0, dir.y));
  float inverse = 1.0 / (cos(zenithAngle) + 0.15 * pow(93.885 - degrees(zenithAngle), -1.253));
  float sR = ${f(8.4e3)} * inverse;
  float sM = ${f(1.25e3)} * inverse;
  vec3 Fex = exp(-(skyBetaR * sR + skyBetaM * sM));

  float cosTheta = dot(dir, skySun);
  float rPhase = 0.05968310365946075 * (1.0 + pow(cosTheta * 0.5 + 0.5, 2.0));
  float g2 = ${f(SKY.mieDirectionalG * SKY.mieDirectionalG)};
  float mPhase = 0.07957747154594767 * ((1.0 - g2) / pow(1.0 - 2.0 * ${f(SKY.mieDirectionalG)} * cosTheta + g2, 1.5));
  vec3 betaRTheta = skyBetaR * rPhase;
  vec3 betaMTheta = skyBetaM * mPhase;

  vec3 ratio = skySunE * ((betaRTheta + betaMTheta) / (skyBetaR + skyBetaM));
  vec3 Lin = pow(ratio * (1.0 - Fex), vec3(1.5));
  Lin *= mix(vec3(1.0), pow(ratio * Fex, vec3(0.5)), clamp(pow(1.0 - skySun.y, 5.0), 0.0, 1.0));
  vec3 L0 = vec3(0.1) * Fex;

  float disc = clamp((cosTheta - 0.999956676946448443553574619906976478926848692873900859324) * 50000.0, 0.0, 1.0) * sunDisc;
  vec3 discColour = (760.0 * disc) * min(skySunE * Fex, 80.0);
  vec3 sky = (Lin + L0) * 0.04 + discColour + vec3(0.0, 0.0003, 0.00075);

  if (octaves > 0 && cloudWeight > 0.0 && dir.y > 0.0 && skyCloud.x > 0.0) {
    float elevation = mix(1.0, 0.1, ${f(SKY.cloudElevation)});
    vec2 cloudUV = dir.xz / (dir.y * elevation) * ${f(SKY.cloudScale)} + skyCloud.zw;
    float cloudNoise = clamp(skyFbm(cloudUV * 1000.0, skyEvolve, octaves) * 0.7 + 0.5, 0.0, 1.0);
    float region = skyNoise(cloudUV * 300.0) * 0.37 + 0.5;
    float cov = clamp(skyCloud.x + (region - 0.5) * 0.6, 0.0, 1.0);
    float threshold = 1.0 - cov;
    float cloudMask = smoothstep(threshold, threshold + 0.3, cloudNoise);
    float horizonFade = smoothstep(0.0, ${f(0.03 + 0.06 * SKY.cloudElevation)}, dir.y);
    cloudMask *= horizonFade;

    float dayFactor = smoothstep(-0.08, 0.3, skySun.y);
    vec3 sunColour = skySunE * Fex * 0.22 * 0.04;
    vec3 skyAmbient = Lin * 0.04 + vec3(0.0, 0.0003, 0.00075);
    float depth = max(0.0, cloudNoise - threshold);
    float beer = exp(depth * -4.0);
    float powder = 1.0 - beer * beer;
    float shade = mix(0.45, 1.0, clamp(beer * powder * 2.6, 0.0, 1.0));
    float silver = clamp(0.51 / pow(1.49 - cosTheta * 1.4, 1.5), 0.0, 3.0);
    float edge = cloudMask * (1.0 - cloudMask) * 4.0;
    vec3 cloudColour = skyAmbient + sunColour * shade;
    cloudColour += sunColour * silver * edge * 0.6;
    cloudColour *= max(dayFactor, 0.03);

    float alpha = (1.0 - exp(depth * skyCloud.y * -12.0)) * horizonFade * cloudWeight;
    sky -= L0 * 0.04 * alpha;
    sky = mix(sky, mix(sky, cloudColour, Fex), alpha);
  }
  return 1.0 - exp(-${f(SKY.exposure)} * sky);
}
`;
}

/** Shared sky uniforms, attached by reference to the dome and the water (merge would clone them). */
export interface SkyUniforms {
  [name: string]: THREE.IUniform;
  skySun: { value: THREE.Vector3 };
  skyBetaR: { value: THREE.Vector3 };
  skyBetaM: { value: THREE.Vector3 };
  skySunE: { value: number };
  skyCloud: { value: THREE.Vector4 };
  skyEvolve: { value: number };
  skyNoiseTexture: { value: THREE.DataTexture };
}

export class SkyView {
  readonly mesh: THREE.Mesh;
  readonly uniforms: SkyUniforms = {
    skySun: { value: new THREE.Vector3() },
    skyBetaR: { value: new THREE.Vector3() },
    skyBetaM: { value: new THREE.Vector3() },
    skySunE: { value: 0 },
    skyCloud: { value: new THREE.Vector4(SKY.cloudCoverage, SKY.cloudDensity, 0, 0) },
    skyEvolve: { value: 0 },
    skyNoiseTexture: { value: createNoiseTexture() },
  };
  private atm: Atmosphere = atmosphere(1);
  private lastT = 0;
  // Cloud-plane offsets in doubles; the uniform carries them wrapped to one noise period.
  private offsetX = 0;
  private offsetZ = 0;

  constructor(
    private readonly sun: THREE.DirectionalLight,
    private readonly hemisphere: THREE.HemisphereLight,
    private readonly scene: THREE.Scene,
  ) {
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: `
        varying vec3 skyDirection;
        void main() {
          skyDirection = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          // Far plane: drawn after the opaque scene, depth testing rejects every pixel the water,
          // boat or buoys already cover before the sky shader runs. A reversed depth buffer puts
          // the far plane at 0 instead of 1.
          #ifdef USE_REVERSED_DEPTH_BUFFER
          gl_Position.z = 0.0;
          #else
          gl_Position.z = gl_Position.w;
          #endif
        }
      `,
      fragmentShader: `
        varying vec3 skyDirection;
        ${skyGLSL()}
        void main() {
          gl_FragColor = vec4(skyRadiance(normalize(skyDirection), 4, 1.0, 1.0), 1.0);
          #include <colorspace_fragment>
        }
      `,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, ...DOME_SEGMENTS), material);
    this.mesh.renderOrder = 1000; // after all opaque objects
    this.mesh.frustumCulled = false;
    this.setSun(SKY.sunElevationDeg, SKY.sunAzimuthDeg);
  }

  /** Move the sun: sky uniforms, light direction/colour/strength and the horizon fog colour. */
  setSun(elevationDeg: number, azimuthDeg: number): void {
    const dir = sunDirection(elevationDeg, azimuthDeg);
    this.atm = atmosphere(dir[1]);
    const u = this.uniforms;
    u.skySun.value.set(...dir);
    u.skyBetaR.value.set(...this.atm.betaR);
    u.skyBetaM.value.set(...this.atm.betaM);
    u.skySunE.value = this.atm.sunE;

    const light = sunLight(this.atm, dir);
    this.sun.position.set(dir[0], dir[1], dir[2]).multiplyScalar(SUN_LIGHT_DISTANCE);
    this.sun.color.setRGB(...light.colour);
    this.sun.intensity = light.intensity;
    this.hemisphere.intensity = hemisphereIntensity(dir[1]);

    // Distant boat parts and buoys fog toward the horizon colour 90 degrees from the sun.
    const across: Vec3 = [-dir[2], 0, dir[0]];
    const length = Math.hypot(across[0], across[2]) || 1;
    const horizon = clearSky(this.atm, dir, [across[0] / length, 0, across[2] / length]);
    if (this.scene.fog) this.scene.fog.color.setRGB(...horizon);
    this.scene.background = new THREE.Color().setRGB(...horizon);
  }

  setCloudCoverage(coverage: number): void {
    this.uniforms.skyCloud.value.x = Math.min(Math.max(coverage, 0), 1);
  }

  get cloudCoverage(): number {
    return this.uniforms.skyCloud.value.x;
  }

  get dayFactor(): number {
    return dayFactor(this.uniforms.skySun.value.y);
  }

  /**
   * Advance cloud drift to sim time `t` with the true wind (m/s, world x/z). Drift integrates the
   * wind, so a wind change bends the motion instead of jumping the pattern; a time rewind (reset)
   * keeps the pattern where it is.
   */
  update(t: number, wind: Vec2): void {
    const dt = Math.max(t - this.lastT, 0);
    this.lastT = t;
    const cloud = this.uniforms.skyCloud.value;
    const nextX = this.offsetX - wind.x * SKY.cloudSpeedPerWindMs * dt;
    const nextZ = this.offsetZ - wind.z * SKY.cloudSpeedPerWindMs * dt;
    this.offsetX = ((nextX % CLOUD_OFFSET_PERIOD) + CLOUD_OFFSET_PERIOD) % CLOUD_OFFSET_PERIOD;
    this.offsetZ = ((nextZ % CLOUD_OFFSET_PERIOD) + CLOUD_OFFSET_PERIOD) % CLOUD_OFFSET_PERIOD;
    cloud.z = this.offsetX;
    cloud.w = this.offsetZ;
    this.uniforms.skyEvolve.value = t * CLOUD_EVOLVE_RATE;
  }

  /** Keep the dome centred on the camera. */
  follow(camera: THREE.Camera): void {
    camera.getWorldPosition(this.mesh.position);
  }
}
