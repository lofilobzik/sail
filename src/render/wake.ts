/**
 * Boat wake and emitted bow fronts for the water shader (visual only, reads sim state).
 * Keeps a world-anchored Kelvin trail and a bow field for render/wake/kelvin.ts; the bow field is
 * rendered on the GPU from the packed fronts (render/wake/bowField.ts) into a float target.
 * Kelvin source amplitude comes from a drawing-only Delft wave-making estimate.
 */
import * as THREE from 'three';
import type { BoatModel, Vec2 } from '../sim';
import type { EnvironmentConfig, WaveConfig } from '../physics/types';
import type { GpuTimer } from '../debug/gpuTimer';
import type { BoatLayout } from './boatLayout';
import { WAKE, bowWaveHeight, wakeBoundsMargin, wakeResiduary, wakeSourceAmplitude } from './wake/kelvin';
import { BowContact, type ContactPose } from './wake/contact';
import { BowWaveField, bowFieldGLSL, type BowEmitter } from './wake/bowField';
import { WakeTrail } from './wake/trail';

export interface WakePose extends ContactPose {
  /** Surge speed through the water, m/s. */
  surge: number;
}

const TWO_PI = 2 * Math.PI;
const BOW_FIELD_INTERVAL = 1 / 30; // s of sim time between field renders
const mod = (v: number, m: number) => ((v % m) + m) % m;

/** Independent wake components, each a shader switch (components of the `wakeLayers` uniform). */
const WAKE_LAYERS = { kelvin: 'x', bowWaves: 'y', foam: 'z' } as const;
export type WakeLayer = keyof typeof WAKE_LAYERS;

export class WakeView {
  enabled = true;
  /** CPU side: emits, ages and packs the fronts. Read-only outside (checking aids). */
  readonly bowField = new BowWaveField(WAKE);
  private readonly bowEmitter: BowEmitter = { x: 0, z: 0, time: 0, height: 0, speed: 0, foam: 0 };
  private readonly packetTexture = new THREE.DataTexture(
    this.bowField.packed, WAKE.bowFronts, 2, THREE.RGBAFormat, THREE.FloatType,
  );
  /** The rendered field: one texel per node (RGBA: signed height, source height, foam, width). */
  readonly fieldTarget = new THREE.WebGLRenderTarget(WAKE.bowFieldResolution, WAKE.bowFieldResolution, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false,
  });
  private readonly fieldScene = new THREE.Scene();
  private readonly fieldCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  /** False without float colour buffers: bow waves stay off. */
  private readonly fieldSupported: boolean;
  /** The field changed since the last render. */
  private pending = true;
  private renderedAt = NaN;
  private renderedOriginX = 0;
  private renderedOriginZ = 0;
  readonly uniforms = {
    wakeA: { value: new Float32Array(WAKE.trailPoints * 4) },
    wakeB: { value: new Float32Array(WAKE.trailPoints * 4) },
    wakeCount: { value: 0 },
    /** Render-local box the wake can reach (kelvin.ts wakeBoundsMargin); empty while there is no trail. */
    wakeBounds: { value: new THREE.Vector4(1, 1, -1, -1) },
    wakeStem: { value: new THREE.Vector4(0, 0, 0, -1) },
    wakeHull: { value: new THREE.Vector4() },
    bowField: { value: this.fieldTarget.texture as THREE.Texture },
    bowFieldOrigin: { value: new THREE.Vector2() },
    bowFieldCell: { value: this.bowField.cellSize },
    bowFieldResolution: { value: this.bowField.resolution },
    wakeProfile: { value: new Float32Array(WAKE.hullProfileSamples) },
    wakeFoam: { value: new THREE.Vector4() },
    wakeFoamPhase: { value: new THREE.Vector3() },
    wakeLayers: { value: new THREE.Vector3(1, 1, 1) },
  };
  private readonly trail = new WakeTrail(WAKE);
  private readonly contact: BowContact;
  /** Body x of the waterline stem, m. */
  private readonly stemX: number;

  constructor(
    private readonly model: BoatModel,
    layout: BoatLayout,
    private readonly env: EnvironmentConfig,
    private readonly renderer: THREE.WebGLRenderer,
    private readonly gpu: GpuTimer,
  ) {
    this.contact = new BowContact(layout, WAKE.contactSamples);
    this.packetTexture.minFilter = THREE.NearestFilter;
    this.packetTexture.magFilter = THREE.NearestFilter;
    this.packetTexture.generateMipmaps = false;
    this.packetTexture.needsUpdate = true;
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: bowFieldGLSL(WAKE),
      uniforms: { bowPackets: { value: this.packetTexture } },
      depthTest: false,
      depthWrite: false,
    }));
    quad.frustumCulled = false;
    this.fieldScene.add(quad);
    this.fieldSupported = renderer.extensions.has('EXT_color_buffer_float');
    if (!this.fieldSupported) {
      console.warn('bow waves off: EXT_color_buffer_float unavailable');
      this.uniforms.wakeLayers.value.y = 0;
      const empty = new THREE.DataTexture(new Uint16Array(4), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType);
      empty.needsUpdate = true;
      this.uniforms.bowField.value = empty;
    }
    // Waterline stem: first station from the bow whose keel is below the waterline.
    let stem = layout.bowX;
    const step = layout.loa / 400;
    while (stem > layout.transomX && layout.keelAt(stem) >= 0) stem -= step;
    this.stemX = stem;
    const length = stem - layout.transomX;
    const profile = this.uniforms.wakeProfile.value;
    for (let i = 0; i < profile.length; i++) {
      profile[i] = layout.waterlineHalfBeamAt(stem - (i / (profile.length - 1)) * length);
    }
    this.uniforms.wakeHull.value.set(0, length, 0, model.cfg.hull.beam);
  }

  /**
   * Show or hide one wake component (Kelvin stern waves, bow V waves, foam). Shader-side only:
   * the trail and the bow field keep their history, so switching back shows the true wake.
   */
  setLayer(layer: WakeLayer, on: boolean): void {
    this.uniforms.wakeLayers.value[WAKE_LAYERS[layer]] = on ? 1 : 0;
  }

  update(pose: WakePose, origin: Readonly<Vec2>, waves: WaveConfig, hullY: number, pitch = pose.pitch): void {
    const u = this.uniforms;
    const fx = Math.sin(pose.heading);
    const fz = -Math.cos(pose.heading);
    const stemX = pose.x + fx * this.stemX;
    const stemZ = pose.z + fz * this.stemX;
    const speed = this.enabled && pose.surge > WAKE.minSpeed ? pose.surge : 0;
    const residuary = speed > 0 ? wakeResiduary(this.model, speed, this.env.rhoWater) : 0;
    const amplitude = WAKE.visualGain * wakeSourceAmplitude(residuary, this.env.rhoWater, this.model.cfg.hull.beam);

    const bounds = u.wakeBounds.value;
    if (this.enabled) {
      this.trail.update({ x: stemX, z: stemZ, speed, amplitude, time: pose.t });
      const count = this.trail.pack(origin, u.wakeA.value, u.wakeB.value);
      u.wakeCount.value = count;
      if (count >= 2) {
        const a = u.wakeA.value;
        let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, maxArc = 0, maxSpeed = 0;
        for (let i = 0; i < count; i++) {
          minX = Math.min(minX, a[4 * i]!);
          maxX = Math.max(maxX, a[4 * i]!);
          minZ = Math.min(minZ, a[4 * i + 1]!);
          maxZ = Math.max(maxZ, a[4 * i + 1]!);
          maxArc = Math.max(maxArc, a[4 * i + 2]!);
          maxSpeed = Math.max(maxSpeed, a[4 * i + 3]!);
        }
        const margin = wakeBoundsMargin(maxArc, maxSpeed, this.model.cfg.hull.beam);
        bounds.set(minX - margin, minZ - margin, maxX + margin, maxZ + margin);
      } else {
        bounds.set(1, 1, -1, -1);
      }
    } else {
      this.trail.clear();
      u.wakeCount.value = 0;
      bounds.set(1, 1, -1, -1);
    }
    u.wakeStem.value.set(stemX - origin.x, stemZ - origin.z, fx, fz);

    // Only a new front follows the current wet contact; already-emitted fronts stay in world space.
    const inWater = speed > 0 && this.contact.update(pose, waves, hullY, pitch);
    const hull = u.wakeHull.value;
    hull.z = Math.min(Math.max((speed - WAKE.foamMinSpeed) / WAKE.foamSpeedRange, 0), 1);
    const emitter = this.bowEmitter;
    emitter.x = inWater ? pose.x + fx * this.contact.forward - fz * this.contact.starboard : pose.x;
    emitter.z = inWater ? pose.z + fz * this.contact.forward + fx * this.contact.starboard : pose.z;
    emitter.time = pose.t;
    emitter.height = inWater ? bowWaveHeight(speed) : 0;
    emitter.speed = speed;
    // Bow crest foam starts with bow emission; the higher stern-turbulence threshold stays separate.
    emitter.foam = Math.min(Math.max((speed - WAKE.minSpeed) / WAKE.foamSpeedRange, 0), 1);
    // The CPU update always runs (fronts are born on time); the GPU render is throttled.
    const changed = this.enabled ? this.bowField.update(emitter, pose) : (this.bowField.clear(), true);
    this.pending = this.pending || changed;
    if (this.fieldSupported && this.pending
      && !(pose.t >= this.renderedAt && pose.t - this.renderedAt < BOW_FIELD_INTERVAL)) {
      this.packetTexture.needsUpdate = true;
      this.gpu.begin('bow');
      const previous = this.renderer.getRenderTarget();
      this.renderer.setRenderTarget(this.fieldTarget);
      this.renderer.render(this.fieldScene, this.fieldCamera);
      this.renderer.setRenderTarget(previous);
      this.gpu.end();
      this.renderedAt = pose.t;
      this.renderedOriginX = this.bowField.originX;
      this.renderedOriginZ = this.bowField.originZ;
      this.pending = false;
    }
    u.bowFieldOrigin.value.set(this.renderedOriginX - origin.x, this.renderedOriginZ - origin.z);

    // Foam noise stays world-anchored: reduce the origin modulo its period in doubles.
    const period = WAKE.foamNoisePeriod;
    u.wakeFoam.value.set(mod(origin.x, period), mod(origin.z, period), 0, 0);
    const [r0, r1, r2] = WAKE.foamNoiseRates as [number, number, number];
    u.wakeFoamPhase.value.set(mod(r0 * pose.t, TWO_PI), mod(r1 * pose.t, TWO_PI), mod(r2 * pose.t, TWO_PI));
  }
}
