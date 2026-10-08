/** Screen tiles bound candidate work; the final test is the actual water point in the moving cockpit. */
import * as THREE from 'three';
import type { BoatMesh } from './boatMesh';
import type { BoatLayout } from './boatLayout';
import { cockpitOutline } from './hull';
import details from '../../data/hull-details.json';
import tuning from '../../data/water-exclusion.json';

interface Entry {
  boat: BoatMesh;
  inverse: THREE.Matrix4;
  left: number;
  right: number;
  bottom: number;
  top: number;
}

/** No fixed boat budget: textures grow on joins/resizes, not during steady-state mask updates. */
export class WaterExclusion {
  readonly uniforms: Record<string, THREE.IUniform>;
  readonly fragmentGLSL: string;
  private readonly entries: Entry[] = [];
  private readonly clip = new THREE.Matrix4();
  private readonly corner = new THREE.Vector4();
  private readonly bufferSize = new THREE.Vector2();
  private readonly indexSize = new THREE.Vector2();
  private readonly matrixSize = new THREE.Vector2();
  private readonly tiles = new THREE.Vector2();
  private readonly bounds = new THREE.Vector4(1, 1, 0, 0);
  private indices = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  private matrices = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  private readonly floor: number;
  private readonly rim: number;

  constructor(private readonly layout: BoatLayout) {
    const c = layout.cockpit;
    const outline = cockpitOutline(layout);
    const edges: THREE.Vector3[] = [];
    let rim = -Infinity;
    for (let i = 0; i < outline.length - 1; i++) {
      const a = outline[i]!, b = outline[i + 1]!;
      const dx = b.x - a.x, dy = b.y - a.y;
      edges.push(new THREE.Vector3(-dy, dx, dy * a.x - dx * a.y));
      rim = Math.max(rim, layout.sheerAt(a.x) + details.coaming.height);
    }
    this.floor = c.floorZ;
    this.rim = rim;
    this.uniforms = {
      cockpitCandidates: { value: this.indices },
      cockpitMatrices: { value: this.matrices },
      cockpitCandidateSize: { value: this.indexSize },
      cockpitMatrixSize: { value: this.matrixSize },
      cockpitTiles: { value: this.tiles },
      cockpitTileBounds: { value: this.bounds },
      cockpitEdges: { value: edges },
    };
    this.fragmentGLSL = `
      uniform sampler2D cockpitCandidates;
      uniform sampler2D cockpitMatrices;
      uniform vec2 cockpitCandidateSize;
      uniform vec2 cockpitMatrixSize;
      uniform vec2 cockpitTiles;
      uniform vec4 cockpitTileBounds;
      uniform vec3 cockpitEdges[${edges.length}];
      vec4 cockpitTexel(sampler2D tex, vec2 size, float index) {
        return texture2D(tex, (vec2(mod(index, size.x), floor(index / size.x)) + 0.5) / size);
      }
      bool cockpitContains(vec3 waterPoint) {
        vec2 tile = min(floor(gl_FragCoord.xy / ${tuning.tilePixels.toFixed(1)}), cockpitTiles - 1.0);
        if (any(lessThan(tile, cockpitTileBounds.xy)) || any(greaterThan(tile, cockpitTileBounds.zw))) return false;
        float node = cockpitTexel(cockpitCandidates, cockpitCandidateSize, tile.y * cockpitTiles.x + tile.x).r;
        // Only projected cockpit tiles have a list. No loop over distant/out-of-view boats.
        while (node > 0.0) {
          vec2 candidate = cockpitTexel(cockpitCandidates, cockpitCandidateSize, node).rg;
          float base = candidate.x * 4.0;
          mat4 worldToBoat = mat4(
            cockpitTexel(cockpitMatrices, cockpitMatrixSize, base),
            cockpitTexel(cockpitMatrices, cockpitMatrixSize, base + 1.0),
            cockpitTexel(cockpitMatrices, cockpitMatrixSize, base + 2.0),
            cockpitTexel(cockpitMatrices, cockpitMatrixSize, base + 3.0));
          vec3 local = (worldToBoat * vec4(waterPoint, 1.0)).xyz;
          if (local.y >= ${this.floor.toPrecision(12)} && local.y <= ${this.rim.toPrecision(12)}) {
            vec3 bodyXY = vec3(-local.z, local.x, 1.0);
            bool inside = true;
            for (int edge = 0; edge < ${edges.length}; edge++) {
              if (dot(cockpitEdges[edge], bodyXY) < 0.0) { inside = false; break; }
            }
            if (inside) return true;
          }
          node = candidate.y;
        }
        return false;
      }
    `;
  }

  add(boat: BoatMesh): void {
    this.entries.push({ boat, inverse: new THREE.Matrix4(), left: 0, right: -1, bottom: 0, top: -1 });
  }

  remove(boat: BoatMesh): void {
    const index = this.entries.findIndex((entry) => entry.boat === boat);
    if (index !== -1) this.entries.splice(index, 1);
  }

  /** Called after scene matrices update, once for each split camera, before drawing that pass. */
  prepare(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    renderer.getDrawingBufferSize(this.bufferSize);
    const columns = Math.ceil(this.bufferSize.x / tuning.tilePixels);
    const rows = Math.ceil(this.bufferSize.y / tuning.tilePixels);
    this.tiles.set(columns, rows);
    let required = columns * rows;
    this.bounds.set(columns, rows, -1, -1);
    const c = this.layout.cockpit;
    for (let boat = 0; boat < this.entries.length; boat++) {
      const entry = this.entries[boat]!;
      this.clip.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(entry.boat.heel.matrixWorld);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      let nearCrossing = false, allBehindNear = true, allBeyondFar = true;
      for (let i = 0; i < 8; i++) {
        this.corner.set(i & 1 ? c.halfWidth : -c.halfWidth, i & 2 ? this.rim : this.floor, i & 4 ? -c.fore : -c.aft, 1).applyMatrix4(this.clip);
        const p = this.corner;
        if (p.z >= -p.w && p.w > 0) allBehindNear = false;
        if (p.z <= p.w && p.w > 0) allBeyondFar = false;
        if (p.w <= 0) {
          nearCrossing = true;
          continue;
        }
        minX = Math.min(minX, p.x / p.w); maxX = Math.max(maxX, p.x / p.w);
        minY = Math.min(minY, p.y / p.w); maxY = Math.max(maxY, p.y / p.w);
      }
      entry.right = -1;
      if (allBehindNear || allBeyondFar) continue;
      // Crossing the eye plane has an unbounded projection; conservatively cover the viewport.
      if (nearCrossing) { minX = minY = -1; maxX = maxY = 1; }
      if (maxX < -1 || minX > 1 || maxY < -1 || minY > 1) continue;
      entry.left = Math.max(0, Math.floor((minX + 1) * 0.5 * this.bufferSize.x / tuning.tilePixels));
      entry.right = Math.min(columns - 1, Math.floor((maxX + 1) * 0.5 * this.bufferSize.x / tuning.tilePixels));
      entry.bottom = Math.max(0, Math.floor((minY + 1) * 0.5 * this.bufferSize.y / tuning.tilePixels));
      entry.top = Math.min(rows - 1, Math.floor((maxY + 1) * 0.5 * this.bufferSize.y / tuning.tilePixels));
      entry.inverse.copy(entry.boat.heel.matrixWorld).invert();
      required += (entry.right - entry.left + 1) * (entry.top - entry.bottom + 1);
      this.bounds.x = Math.min(this.bounds.x, entry.left);
      this.bounds.y = Math.min(this.bounds.y, entry.bottom);
      this.bounds.z = Math.max(this.bounds.z, entry.right);
      this.bounds.w = Math.max(this.bounds.w, entry.top);
    }
    // An empty pass needs no candidate uploads or sampling; the shader's bounds reject every pixel.
    if (this.bounds.z < 0) return;
    this.indices = this.ensureCapacity(this.indices, required, renderer, this.indexSize);
    this.matrices = this.ensureCapacity(this.matrices, this.entries.length * 4, renderer, this.matrixSize);
    this.uniforms.cockpitCandidates!.value = this.indices;
    this.uniforms.cockpitMatrices!.value = this.matrices;
    const indices = this.indices.image.data as Float32Array;
    const matrices = this.matrices.image.data as Float32Array;
    indices.fill(0, 0, columns * rows * 4);
    let node = columns * rows;
    for (let boat = 0; boat < this.entries.length; boat++) {
      const entry = this.entries[boat]!;
      if (entry.right < 0) continue;
      entry.inverse.toArray(matrices, boat * 16);
      for (let y = entry.bottom; y <= entry.top; y++) {
        for (let x = entry.left; x <= entry.right; x++) {
          const head = (y * columns + x) * 4;
          indices[node * 4] = boat;
          indices[node * 4 + 1] = indices[head]!;
          indices[head] = node++;
        }
      }
    }
    this.indices.needsUpdate = true;
    this.matrices.needsUpdate = true;
  }

  private ensureCapacity(texture: THREE.DataTexture, texels: number, renderer: THREE.WebGLRenderer, size: THREE.Vector2): THREE.DataTexture {
    const width = Math.min(tuning.textureRowTexels, renderer.capabilities.maxTextureSize);
    const requiredRows = Math.max(1, Math.ceil(texels / width));
    if (texture.image.width !== width || texture.image.height < requiredRows) {
      const height = Math.min(renderer.capabilities.maxTextureSize, 2 ** Math.ceil(Math.log2(requiredRows)));
      if (height < requiredRows || texels >= 2 ** 24) throw new Error('Cockpit exclusion exceeds GPU texture address capacity');
      texture.dispose();
      texture = new THREE.DataTexture(new Float32Array(width * height * 4), width, height, THREE.RGBAFormat, THREE.FloatType);
      texture.minFilter = texture.magFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
    }
    size.set(texture.image.width, texture.image.height);
    return texture;
  }

  dispose(): void {
    this.indices.dispose();
    this.matrices.dispose();
  }
}
