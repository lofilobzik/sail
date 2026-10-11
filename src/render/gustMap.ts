/**
 * Gust patches on the water. The sim's own wind speed factor (`windSpeedFactor`) is sampled into a
 * small world-anchored texture around the boat, so the dark patches the sailor sees are the gusts
 * that will reach the boat. Texels sit on a fixed world grid (the window origin snaps to whole
 * cells), so patches move with the wind but never swim as the boat sails. Render only.
 *
 * The field is sampled exactly every RESAMPLE_SECONDS of sim time; the water shows a linear-in-time
 * blend of the two exact samples around the current time, not an exact evaluation in between. The
 * sim reads `windSpeedFactor` directly and is unaffected.
 */
import * as THREE from 'three';
import { WIND_PARAMETERS, windSpeedFactor, type Vec2, type WindConfig } from '../sim';

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
  /** cell size m, map size texels, darkenMax, lullBrighten. */
  gustMapInfo: { value: THREE.Vector4 };
  /** 0 switches the gust code off entirely (gusts disabled). */
  gustStrength: { value: number };
}

interface Sample {
  /** Single channel: 0..255 maps the speed-factor deviation [-referenceDeviation, +referenceDeviation]. */
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
  private readonly point: Vec2 = { x: 0, z: 0 };

  constructor() {
    this.uniforms = {
      gustMap: { value: this.current.texture },
      gustMapNext: { value: this.next.texture },
      gustBlend: { value: 0 },
      gustOrigin: { value: new THREE.Vector2() },
      gustMapInfo: { value: new THREE.Vector4(CELL, SIZE, VISUAL.darkenMax, VISUAL.lullBrighten) },
      gustStrength: { value: 0 },
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
  }

  private sample(target: Sample, t: number, wind: WindConfig): void {
    const scale = 127.5 / VISUAL.referenceDeviation;
    const p = this.point;
    const data = target.data;
    for (let j = 0; j < SIZE; j++) {
      p.z = this.originZ + j * CELL;
      for (let i = 0; i < SIZE; i++) {
        p.x = this.originX + i * CELL;
        const deviation = windSpeedFactor(p, t, wind) - 1;
        data[j * SIZE + i] = Math.min(255, Math.max(0, Math.round(127.5 + deviation * scale)));
      }
    }
    target.texture.needsUpdate = true;
  }
}

/** GLSL: `gustAmount(p)` in about [-1, 1] for a render-local water position; + is a gust, - a lull. */
export function gustGLSL(): string {
  return `
uniform sampler2D gustMap;
uniform sampler2D gustMapNext;
uniform float gustBlend;
uniform vec2 gustOrigin;
uniform vec4 gustMapInfo;
uniform float gustStrength;

float gustAmount(vec2 p) {
  if (gustStrength <= 0.0) return 0.0;
  vec2 grid = (p - gustOrigin) / gustMapInfo.x + 0.5;
  vec2 edge = min(grid, gustMapInfo.y - grid);
  float fade = smoothstep(0.0, ${VISUAL.edgeFadeCells.toFixed(1)}, min(edge.x, edge.y));
  vec2 uv = grid / gustMapInfo.y;
  float a = texture2D(gustMap, uv).r;
  float b = texture2D(gustMapNext, uv).r;
  return (mix(a, b, gustBlend) * 2.0 - 1.0) * fade;
}
`;
}
