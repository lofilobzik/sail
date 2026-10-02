/**
 * Gust patches on the water. The sim's own wind speed factor (`windSpeedFactor`) is sampled into a
 * small world-anchored texture around the boat, so the dark patches the sailor sees are exactly the
 * gusts that will reach the boat. Texels sit on a fixed world grid (the window origin snaps to whole
 * cells), so patches move with the wind but never swim as the boat sails. Render only.
 */
import * as THREE from 'three';
import { WIND_PARAMETERS, windSpeedFactor, type Vec2, type WindConfig } from '../sim';

const VISUAL = WIND_PARAMETERS.visual;
const SIZE = VISUAL.mapSize;
const CELL = VISUAL.mapCellM;

/** Uniforms shared with the water shader (attach by reference; merge would clone them). */
export interface GustUniforms {
  [name: string]: THREE.IUniform;
  gustMap: { value: THREE.DataTexture };
  /** Render-local position of texel (0, 0). */
  gustOrigin: { value: THREE.Vector2 };
  /** cell size m, map size texels, darkenMax, lullBrighten. */
  gustMapInfo: { value: THREE.Vector4 };
  /** 0 switches the gust code off entirely (gusts disabled). */
  gustStrength: { value: number };
}

export class GustMap {
  /** Single channel: 0..255 maps the speed-factor deviation [-referenceDeviation, +referenceDeviation]. */
  readonly data = new Uint8Array(SIZE * SIZE);
  readonly texture = new THREE.DataTexture(this.data, SIZE, SIZE, THREE.RedFormat, THREE.UnsignedByteType);
  readonly uniforms: GustUniforms;
  /** Logical-world position of texel (0, 0); lets tests and callers check the anchoring. */
  originX = 0;
  originZ = 0;
  private readonly point: Vec2 = { x: 0, z: 0 };

  constructor() {
    this.texture.magFilter = this.texture.minFilter = THREE.LinearFilter;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.uniforms = {
      gustMap: { value: this.texture },
      gustOrigin: { value: new THREE.Vector2() },
      gustMapInfo: { value: new THREE.Vector4(CELL, SIZE, VISUAL.darkenMax, VISUAL.lullBrighten) },
      gustStrength: { value: 0 },
    };
  }

  /** Resample the gust field for sim time `t` around the logical boat position `origin`. */
  update(wind: WindConfig, origin: Readonly<Vec2>, t: number): void {
    if (!wind.gusts?.enabled) {
      this.uniforms.gustStrength.value = 0;
      return;
    }
    const half = (SIZE * CELL) / 2;
    this.originX = Math.round((origin.x - half) / CELL) * CELL;
    this.originZ = Math.round((origin.z - half) / CELL) * CELL;
    const scale = 127.5 / VISUAL.referenceDeviation;
    const p = this.point;
    for (let j = 0; j < SIZE; j++) {
      p.z = this.originZ + j * CELL;
      for (let i = 0; i < SIZE; i++) {
        p.x = this.originX + i * CELL;
        const deviation = windSpeedFactor(p, t, wind) - 1;
        this.data[j * SIZE + i] = Math.min(255, Math.max(0, Math.round(127.5 + deviation * scale)));
      }
    }
    this.texture.needsUpdate = true;
    this.uniforms.gustOrigin.value.set(this.originX - origin.x, this.originZ - origin.z);
    this.uniforms.gustStrength.value = 1;
  }
}

/** GLSL: `gustAmount(p)` in about [-1, 1] for a render-local water position; + is a gust, - a lull. */
export function gustGLSL(): string {
  return `
uniform sampler2D gustMap;
uniform vec2 gustOrigin;
uniform vec4 gustMapInfo;
uniform float gustStrength;

float gustAmount(vec2 p) {
  if (gustStrength <= 0.0) return 0.0;
  vec2 grid = (p - gustOrigin) / gustMapInfo.x + 0.5;
  vec2 edge = min(grid, gustMapInfo.y - grid);
  float fade = smoothstep(0.0, ${VISUAL.edgeFadeCells.toFixed(1)}, min(edge.x, edge.y));
  return (texture2D(gustMap, grid / gustMapInfo.y).r * 2.0 - 1.0) * fade;
}
`;
}
