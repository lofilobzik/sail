/**
 * Gust patches on the water. The sim's own wind speed factor (`windSpeedFactor`) is rasterized into
 * a world-anchored texture around the boat, so the dark patches the sailor sees are the gust puffs
 * that will reach the boat. The map holds the puffs' speed excess (factor - 1); puffs only add
 * wind, so there are no lulls. Texels sit on a fixed world grid (the window origin snaps to whole
 * cells), so patches move with the wind but never swim as the boat sails. Render only.
 *
 * The field is sampled exactly every RESAMPLE_SECONDS of sim time; the water shows a linear-in-time
 * blend of the two exact samples around the current time, not an exact evaluation in between. The
 * sim reads `windSpeedFactor` directly and is unaffected.
 */
import * as THREE from 'three';
import {
  DEG, WIND_PARAMETERS, activePuffs, bearingToWorld, gustDrift, puffShape, steadyWeight,
  type GustPuff, type Vec2,
} from '../sim';
import type { WindConfig } from '../physics/types';
import { NOISE_SIZE as SKY_NOISE_SIZE } from './sky';

const VISUAL = WIND_PARAMETERS.visual;
const SIZE = VISUAL.mapSize;
const CELL = VISUAL.mapCellM;
const RESAMPLE_SECONDS = 0.25; // TUNING GUESS: patches drift about 1 m per interval at 7 kn

/** Uniforms shared with the water shader (attach by reference; merge would clone them). */
export interface GustUniforms {
  [name: string]: THREE.IUniform;
  /** Sample at `sampledAt`. */
  gustMap: { value: THREE.DataTexture };
  /** Sample at `sampledAt + RESAMPLE_SECONDS`. */
  gustMapNext: { value: THREE.DataTexture };
  /** 0..1: how far the current time is from the first sample toward the next. */
  gustBlend: { value: number };
  /** Render-local position of texel (0, 0). */
  gustOrigin: { value: THREE.Vector2 };
  /** Cell size m, map size texels. */
  gustMapInfo: { value: THREE.Vector2 };
  /** 0 switches the gust code off entirely (gusts disabled). */
  gustStrength: { value: number };
  /** Unit world x-z direction the mean wind blows toward: the ripples run along it. */
  gustDown: { value: THREE.Vector2 };
  /** World offset (m) the patch-edge noise has drifted with the puffs, wrapped to the noise period. */
  gustNoiseOffset: { value: THREE.Vector2 };
}

interface Sample {
  /** Single channel: 0..255 maps the speed-factor excess [0, referenceExcess]. */
  data: Uint8Array;
  texture: THREE.DataTexture;
}

function createSample(): Sample {
  const data = new Uint8Array(SIZE * SIZE);
  const texture = new THREE.DataTexture(data, SIZE, SIZE, THREE.RedFormat, THREE.UnsignedByteType);
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  return { data, texture };
}

export class GustMap {
  readonly uniforms: GustUniforms;
  /** Logical-world position of texel (0, 0); lets tests and callers check the anchoring. */
  originX = 0;
  originZ = 0;
  private current = createSample();
  private next = createSample();
  /** Sim time of `current`'s sample; NaN forces a full resample. */
  private sampledAt = NaN;
  /** The wind inputs the samples were taken with (see update). */
  private windKey = '';
  /** Puffs reaching the map at the sample time, and the per-texel product of (1 - c_i / cap); reused. */
  private readonly puffs: GustPuff[] = [];
  private readonly prod = new Float64Array(SIZE * SIZE);

  constructor() {
    this.uniforms = {
      gustMap: { value: this.current.texture },
      gustMapNext: { value: this.next.texture },
      gustBlend: { value: 0 },
      gustOrigin: { value: new THREE.Vector2() },
      gustMapInfo: { value: new THREE.Vector2(CELL, SIZE) },
      gustStrength: { value: 0 },
      gustDown: { value: new THREE.Vector2(0, 1) },
      gustNoiseOffset: { value: new THREE.Vector2() },
    };
  }

  /** The sample at `sampledAt` (not necessarily at the latest update's time). */
  get data(): Uint8Array {
    return this.current.data;
  }

  /** The sample at `sampledAt + RESAMPLE_SECONDS`. */
  get nextData(): Uint8Array {
    return this.next.data;
  }

  /**
   * Gust patches for sim time `t` in a window around the logical boat position `center`; `origin`
   * is the logical position of render-local zero.
   */
  update(wind: WindConfig, center: Readonly<Vec2>, origin: Readonly<Vec2>, t: number): void {
    const gusts = wind.gusts;
    if (!gusts?.enabled) {
      this.uniforms.gustStrength.value = 0;
      this.sampledAt = NaN;
      return;
    }
    // Everything windSpeedFactor reads besides position and time; the debug overlay and server
    // snapshots change these in place.
    const key = `${wind.speedKn}|${wind.fromDeg}|${gusts.seed}|${gusts.gustScale}`;
    const half = (SIZE * CELL) / 2;
    const ox = Math.round((center.x - half) / CELL) * CELL;
    const oz = Math.round((center.z - half) / CELL) * CELL;
    if (!(t >= this.sampledAt) || ox !== this.originX || oz !== this.originZ || key !== this.windKey) {
      this.sampledAt = t;
      this.originX = ox;
      this.originZ = oz;
      this.windKey = key;
      this.sample(this.current, t, wind);
      this.sample(this.next, t + RESAMPLE_SECONDS, wind);
    } else if (t - this.sampledAt >= RESAMPLE_SECONDS) {
      const k = Math.floor((t - this.sampledAt) / RESAMPLE_SECONDS);
      this.sampledAt += k * RESAMPLE_SECONDS;
      if (k === 1) {
        [this.current, this.next] = [this.next, this.current];
        this.uniforms.gustMap.value = this.current.texture;
        this.uniforms.gustMapNext.value = this.next.texture;
      } else {
        this.sample(this.current, this.sampledAt, wind);
      }
      this.sample(this.next, this.sampledAt + RESAMPLE_SECONDS, wind);
    }
    this.uniforms.gustBlend.value = (t - this.sampledAt) / RESAMPLE_SECONDS;
    this.uniforms.gustOrigin.value.set(this.originX - origin.x, this.originZ - origin.z);
    this.uniforms.gustStrength.value = 1;
    // The mean direction only: the ripple phase is computed from world coordinates, so turning the
    // ripples with the slow shift pivots every crest about the world origin, and a kilometre away even a
    // tenth of a degree per second sweeps them sideways at metres per second, back and forth with the shift.
    const from = bearingToWorld(wind.fromDeg * DEG);
    this.uniforms.gustDown.value.set(-from.x, -from.z);
    const drift = gustDrift(wind);
    const period = SKY_NOISE_SIZE * RAGGED_SCALE_M; // both noise octaves repeat over this
    this.uniforms.gustNoiseOffset.value.set((drift.x * t) % period, (drift.z * t) % period);
  }

  /**
   * Rasterizes the puffs once per puff over its bounding box. Same arithmetic, in the same puff
   * order, as `puffsAt` in src/sim/wind.ts, so each texel is `windSpeedFactor` exactly before byte
   * quantization.
   */
  private sample(target: Sample, t: number, wind: WindConfig): void {
    const data = target.data;
    target.texture.needsUpdate = true;
    const gustScale = wind.gusts!.gustScale;
    if (gustScale <= 0) {
      data.fill(0);
      return;
    }
    const v = gustDrift(wind);
    const ox = this.originX;
    const oz = this.originZ;
    const span = (SIZE - 1) * CELL;
    const puffs = this.puffs;
    puffs.length = 0;
    activePuffs(ox - v.x * t, oz - v.z * t, ox + span - v.x * t, oz + span - v.z * t, t, wind, puffs);
    const prod = this.prod;
    prod.fill(1);
    const limit = WIND_PARAMETERS.puffs.cap * gustScale;
    for (const puff of puffs) {
      const cx = puff.qx + v.x * t;
      const cz = puff.qz + v.z * t;
      const reach = puff.along; // conservative: a circle around the ellipse
      const i0 = Math.max(0, Math.ceil((cx - reach - ox) / CELL));
      const i1 = Math.min(SIZE - 1, Math.floor((cx + reach - ox) / CELL));
      const j0 = Math.max(0, Math.ceil((cz - reach - oz) / CELL));
      const j1 = Math.min(SIZE - 1, Math.floor((cz + reach - oz) / CELL));
      for (let j = j0; j <= j1; j++) {
        const qz = oz + j * CELL - v.z * t;
        for (let i = i0; i <= i1; i++) {
          const m = puffShape(puff, ox + i * CELL - v.x * t, qz);
          if (m > 0) {
            const k = j * SIZE + i;
            const wgt = puff.env * m;
            prod[k] = prod[k]! * (1 - (puff.strength * wgt) / limit);
          }
        }
      }
    }
    const reference = VISUAL.referenceExcess;
    for (let j = 0; j < SIZE; j++) {
      const z = oz + j * CELL;
      for (let i = 0; i < SIZE; i++) {
        const k = j * SIZE + i;
        const factor = 1 + steadyWeight(ox + i * CELL, z) * (limit * (1 - prod[k]!));
        data[k] = Math.min(255, Math.max(0, Math.round((255 * (factor - 1)) / reference)));
      }
    }
  }
}

// Fine wind ripples that grow only in gusts (TUNING GUESS: wavelength m, angle from downwind rad,
// phase rad). Cat's paws are short ripples running roughly with the wind, so the angles stay within
// about 45 degrees of downwind and the wavelengths are short and incommensurate: resolved, they read
// as a fine wind-combed texture; unresolved, as roughness. The real centimetre ripples are left out:
// on screen they only shimmer.
const RIPPLES: ReadonlyArray<readonly [number, number, number]> = [
  [0.15, 0.15, 0.0], [0.19, -0.55, 1.7], [0.24, 0.4, 3.1], [0.3, -0.2, 4.4],
  [0.37, 0.7, 2.2], [0.45, -0.75, 5.3], [0.53, 0.05, 0.8], [0.62, -0.35, 3.9],
];
const GRAVITY = 9.81; // m/s^2
const SURFACE_TENSION = 7.3e-5; // m^3/s^2, water surface tension over density (capillary dispersion)
// TUNING GUESS: the ripples move at this fraction of their real speed (1 = real, about 0.5-1 m/s for this
// set). The earlier dizziness came from the shift sweep (see update) and the centimetre ripples, not from
// the real speed, so they run at it.
const RIPPLE_TIME_SCALE = 1;
// A ripple fades out once its crests are this many pixels apart (fully gone at the second value), well
// before aliasing, so nearly resolved ripples do not sparkle; what is faded becomes smooth roughness.
const FADE_PIXELS = [8, 3.5] as const;
// rippleSlope is the RMS slope of the whole set at full gust; each component carries an equal share.
const COMPONENT_SLOPE = Math.sqrt(2 / RIPPLES.length);
// TUNING GUESS: patch edges are frayed by noise of this relative strength, at RAGGED_SCALE_M and half that.
const RAGGED = 0.7;
const RAGGED_SCALE_M = 32;

function rippleGLSL(): string {
  return RIPPLES.map(([wavelength, angle, phase]) => {
    const k = (2 * Math.PI) / wavelength;
    const omega = RIPPLE_TIME_SCALE * Math.sqrt(GRAVITY * k + SURFACE_TENSION * k * k * k);
    const d = `(${Math.cos(angle).toFixed(4)} * gustDown + ${Math.sin(angle).toFixed(4)} * across)`;
    return `  keep = 1.0 - smoothstep(${(wavelength / FADE_PIXELS[0]).toFixed(4)}, ${(wavelength / FADE_PIXELS[1]).toFixed(4)}, pixel);
  r.xy += amplitude * keep * cos(${k.toFixed(3)} * dot(${d}, p) - ${omega.toFixed(3)} * time + ${phase.toFixed(2)}) * ${d};
  r.z += 0.5 * amplitude * amplitude * (1.0 - keep);`;
  }).join('\n');
}

/**
 * GLSL: `gustAmount(p)` in 0..1 (the map's gust excess, sharpened into patches with a rim) for a
 * render-local water position, `gustRipples(p, time, pixel)` (slope of the gust ripples at world
 * position p, and in .z the slope variance of the ripples too small for the pixel), and the
 * roughness constants. Uses `skyNoise` from skyGLSL(), which must come first in the shader.
 */
export function gustGLSL(): string {
  return `
uniform sampler2D gustMap;
uniform sampler2D gustMapNext;
uniform float gustBlend;
uniform vec2 gustOrigin;
uniform vec2 gustMapInfo;
uniform float gustStrength;
uniform vec2 gustDown;
uniform vec2 gustNoiseOffset;
#define GUST_WAVE_ROUGH ${VISUAL.waveRough.toFixed(3)}
#define GUST_RIPPLE_SLOPE ${VISUAL.rippleSlope.toFixed(3)}
#define GUST_FRESNEL_DROP ${VISUAL.fresnelDrop.toFixed(3)}
#define GUST_SKY_LIFT ${VISUAL.skyLift.toFixed(3)}

// Gust ripples at world position p: slope in .xy (ripples the pixel resolves) and, in .z, the slope
// variance of those it cannot, which the caller turns into broader glint and weaker reflection.
vec3 gustRipples(vec2 p, float time, float pixel) {
  vec3 r = vec3(0.0);
  float keep;
  vec2 across = vec2(-gustDown.y, gustDown.x);
  float amplitude = ${COMPONENT_SLOPE.toFixed(4)} * GUST_RIPPLE_SLOPE;
${rippleGLSL()}
  return r;
}

// Gust strength 0..1 at a water position (render-local p, world position world), faded out with
// distance from the map centre (the boat).
float gustAmount(vec2 p, vec2 world) {
  if (gustStrength <= 0.0) return 0.0;
  vec2 centre = gustOrigin + 0.5 * gustMapInfo.x * (gustMapInfo.y - 1.0);
  float fade = 1.0 - smoothstep(${VISUAL.fadeStartM.toFixed(3)}, ${VISUAL.fadeEndM.toFixed(3)}, length(p - centre));
  if (fade <= 0.0) return 0.0;
  vec2 uv = ((p - gustOrigin) / gustMapInfo.x + 0.5) / gustMapInfo.y;
  float excess = mix(texture2D(gustMap, uv).r, texture2D(gustMapNext, uv).r, gustBlend);
  // The puffs are smooth ellipses: two octaves of noise, carried with the puffs, fray their edges
  // into irregular cat's-paw shapes without moving where the gust is.
  vec2 q = world - gustNoiseOffset;
  excess *= 1.0 + ${RAGGED.toFixed(2)} * (skyNoise(q / ${RAGGED_SCALE_M.toFixed(1)}) + 0.5 * skyNoise(q / ${(RAGGED_SCALE_M / 2).toFixed(1)} + 17.0));
  // The puffs' falloff is too gradual to read on water: give each patch a defined rim, and keep
  // stronger gusts a little rougher than weak ones.
  float cover = smoothstep(${VISUAL.edgeLow.toFixed(3)}, ${VISUAL.edgeHigh.toFixed(3)}, excess) * (0.7 + 0.3 * clamp(excess, 0.0, 1.0));
  return cover * fade;
}
`;
}
