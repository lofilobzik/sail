/** World-anchored Gerstner water; CPU samples and this shader share waves.ts. */
import * as THREE from 'three';
import { gerstnerGLSL, waveAmplitude, wavePhaseAt, WAVE_PARAMETERS, type WaveConfig } from '../sim/waves';
import type { Vec2 } from '../sim/frames';
import type { WakeView } from './wake';
import { WAKE, wakeFrameGLSL, wakeShadeGLSL } from './wake/kelvin';
import { skyGLSL, type SkyView } from './sky';
import { SKY } from './skyModel';

const WATER_COLOR = 0x1f4f6e; // TUNING GUESS: deep-water body colour
const WATER_REFRACTIVE_INDEX = 1.333; // Water/air index; https://en.wikipedia.org/wiki/Refractive_index
const WATER_F0 = ((WATER_REFRACTIVE_INDEX - 1) / (WATER_REFRACTIVE_INDEX + 1)) ** 2;
const SUN_SHININESS = 96; // TUNING GUESS: broad water glint, no measured roughness
const FOAM_ALBEDO = 0.85; // TUNING GUESS: whitewater diffuse reflectance

export interface WaterView {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  /** The patch is centred at render-local zero; origin stays in logical world coordinates. */
  update(origin: Readonly<Vec2>, t: number): void;
}

/** Uniform near-boat cells; smoothly growing outer cells cover the fog horizon. */
function createWaterGrid(): THREE.BufferGeometry {
  const { waterSize, waterSegments: segments, waterInnerSize, waterInnerSegments } = WAVE_PARAMETERS;
  const side = segments + 1;
  const half = segments / 2;
  const innerHalf = waterInnerSegments / 2;
  const cell = waterInnerSize / waterInnerSegments;
  const outerCells = half - innerHalf;
  const outerLength = (waterSize - waterInnerSize) / 2;
  // Solve the geometric progression for the requested extent, keeping the first
  // outer cell close to the uniform patch's cell size. Setup only, never per frame.
  let lo = 1, hi = 2;
  for (let i = 0; i < 40; i++) {
    const ratio = (lo + hi) / 2;
    const length = cell * ratio * (ratio ** outerCells - 1) / (ratio - 1);
    if (length < outerLength) lo = ratio;
    else hi = ratio;
  }
  const ratio = (lo + hi) / 2;
  const axis = new Float32Array(side);
  let distance = 0;
  let spacing = cell;
  for (let i = 1; i <= half; i++) {
    if (i > innerHalf) spacing *= ratio;
    distance += spacing;
    axis[half + i] = distance;
    axis[half - i] = -distance;
  }
  const positions = new Float32Array(side * side * 3);
  const footprints = new Float32Array(side * side * 2);
  const indices = new Uint32Array(segments * segments * 6);
  for (let row = 0; row <= segments; row++) {
    const z = axis[row]!;
    const dz = Math.max(z - axis[Math.max(0, row - 1)]!, axis[Math.min(segments, row + 1)]! - z);
    for (let col = 0; col <= segments; col++) {
      const x = axis[col]!;
      const offset = (row * side + col) * 3;
      positions[offset] = x;
      positions[offset + 2] = z;
      const f = (row * side + col) * 2;
      footprints[f] = Math.max(x - axis[Math.max(0, col - 1)]!, axis[Math.min(segments, col + 1)]! - x);
      footprints[f + 1] = dz;
    }
  }
  let offset = 0;
  for (let row = 0; row < segments; row++) {
    for (let col = 0; col < segments; col++) {
      const a = row * side + col, b = a + 1, c = a + side, d = c + 1;
      indices[offset++] = a; indices[offset++] = c; indices[offset++] = b;
      indices[offset++] = b; indices[offset++] = c; indices[offset++] = d;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('cellFootprint', new THREE.BufferAttribute(footprints, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

export function createWater(
  cfg: WaveConfig, sky: SkyView, sun: THREE.DirectionalLight,
  hemisphere: THREE.HemisphereLight, wake: WakeView,
): WaterView {
  let components = cfg.components;
  const waveCode = gerstnerGLSL(components);
  const wakeShade = wakeShadeGLSL();
  const material = new THREE.ShaderMaterial({
    fog: true,
    // Wake uniforms are attached by reference after the merge (merge clones values).
    uniforms: Object.assign(THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        waveScale: { value: waveAmplitude(cfg) },
        waveShape: { value: components.map((w) => new THREE.Vector4(w.dx, w.dz, w.k, w.amplitude)) },
        waveMotion: { value: components.map((w) => new THREE.Vector2(w.phase, w.choppiness)) },
        waterColour: { value: new THREE.Color(WATER_COLOR) },
        sunDirection: { value: sun.position.clone().sub(sun.target.position).normalize() },
        sunColour: { value: sun.color.clone().multiplyScalar(sun.intensity) },
        hemisphereSky: { value: hemisphere.color.clone().multiplyScalar(hemisphere.intensity) },
        hemisphereGround: { value: hemisphere.groundColor.clone().multiplyScalar(hemisphere.intensity) },
      },
    ]), wake.uniforms, sky.uniforms),
    vertexShader: `
      uniform float waveScale;
      attribute vec2 cellFootprint;
      varying vec3 waterPosition;
      varying vec2 waterLabel;
      varying vec4 wakeSN;
      varying vec4 wakeProps;
      #include <fog_pars_vertex>
      ${waveCode}
      ${wakeShade}
      ${wakeFrameGLSL()}
      void main() {
        // Only small render-local coordinates enter the GPU; uniforms restore world phase.
        waterLabel = position.xz + modelMatrix[3].xz;
        vec3 unusedNormal;
        gerstnerWave(waterLabel, waveScale, cellFootprint, waterPosition, unusedNormal);
        // Boat wake and bow wave add height on top of the shared Gerstner sea (visual only).
        // Evaluate the wake at the displaced surface point (where the boat really is), not the
        // undisplaced label: big waves move water horizontally and would detach the bow wave.
        vec2 wakePos = waterPosition.xz;
        wakeFrame(wakePos, wakeSN, wakeProps);
        float cell = max(cellFootprint.x, cellFootprint.y);
        vec4 bowSample = wakeBowSample(wakePos);
        waterPosition.y += kelvinWake(wakeSN, wakeProps, cell).x * wakeHullMask(wakePos)
          + bowSample.r * wakeBowFilter(bowSample, cell);
        vec4 mvPosition = viewMatrix * vec4(waterPosition, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: `
      uniform vec3 waterColour;
      uniform vec3 sunDirection;
      uniform vec3 sunColour;
      uniform vec3 hemisphereSky;
      uniform vec3 hemisphereGround;
      uniform float waveScale;
      varying vec3 waterPosition;
      varying vec2 waterLabel;
      varying vec4 wakeSN;
      varying vec4 wakeProps;
      #include <fog_pars_fragment>
      ${waveCode}
      ${wakeShade}
      ${skyGLSL()}
      void main() {
        // Fragment normals retain detail that the distant geometry cannot resolve.
        // Pixel-footprint filtering prevents that detail aliasing at grazing angles.
        vec2 footprint = max(abs(dFdx(waterLabel)), abs(dFdy(waterLabel)));
        vec3 surfacePosition, normal;
        gerstnerWave(waterLabel, waveScale, footprint, surfacePosition, normal);
        vec2 wakePos = surfacePosition.xz;

        // Wake: add its height gradient to the sea's surface gradient.
        float pixel = max(footprint.x, footprint.y);
        float hullMask = wakeHullMask(wakePos);
        vec3 kelvin = kelvinWake(wakeSN, wakeProps, pixel) * hullMask;
        vec2 tangent = wakeSN.zw / max(length(wakeSN.zw), 1e-6);
        vec2 slope = -normal.xz / normal.y
          + kelvin.y * tangent + kelvin.z * vec2(-tangent.y, tangent.x);
        vec4 bowSample = wakeBowSample(wakePos);
        float bow = bowSample.r * wakeBowFilter(bowSample, pixel);
        // Invert the screen-to-horizontal Jacobian, not just a directional derivative.
        // All derivatives are evaluated unconditionally, before the determinant guard.
        vec2 bowDx = dFdx(wakePos), bowDy = dFdy(wakePos);
        float heightDx = dFdx(bow), heightDy = dFdy(bow);
        float determinant = bowDx.x * bowDy.y - bowDx.y * bowDy.x;
        vec2 bowGradient = vec2(0.0);
        if (abs(determinant) > max(1e-12, 1e-5 * length(bowDx) * length(bowDy))) {
          bowGradient = vec2(
            heightDx * bowDy.y - heightDy * bowDx.y,
            heightDy * bowDx.x - heightDx * bowDy.x) / determinant;
        }
        slope += bowGradient;
        normal = normalize(vec3(-slope.x, 1.0, -slope.y));

        vec3 view = normalize(cameraPosition - waterPosition);
        vec3 reflection = reflect(-view, normal);
        // Schlick Fresnel: water/air normal-incidence reflectance from their indices.
        float fresnel = ${WATER_F0.toExponential(16)} + (1.0 - ${WATER_F0.toExponential(16)})
          * pow(1.0 - max(dot(normal, view), 0.0), 5.0);
        // The same sky function as the dome. Clouds fade in with the reflectance (TUNING GUESS,
        // data/sky.json) so steep, weakly reflecting views skip the cloud noise.
        vec3 reflectedSky = skyRadiance(reflection, ${SKY.waterCloudOctaves}, 0.0,
          smoothstep(${SKY.waterCloudFresnelFrom}, ${SKY.waterCloudFresnelFull}, fresnel));
        vec3 ambient = mix(hemisphereGround, hemisphereSky, normal.y * 0.5 + 0.5);
        vec3 diffuse = waterColour * (ambient + sunColour * max(dot(normal, sunDirection), 0.0));
        // TUNING GUESS: broaden the specular lobe by the pixel's normal variance;
        // preserve the cosine-power lobe's integrated energy instead of flashing
        // a narrow highlight on/off as it crosses a pixel.
        vec3 normalDx = dFdx(normal), normalDy = dFdy(normal);
        float variance = dot(normalDx, normalDx) + dot(normalDy, normalDy);
        float glintPower = ${SUN_SHININESS.toFixed(1)} / (1.0 + ${SUN_SHININESS.toFixed(1)} * variance);
        float glint = pow(max(dot(reflection, sunDirection), 0.0), glintPower)
          * (glintPower + 1.0) / ${(SUN_SHININESS + 1).toFixed(1)};
        vec3 colour = mix(diffuse, reflectedSky + sunColour * glint, fresnel);
        // Whitewater: diffuse, unpolished, so it replaces the reflective water colour.
        float foam = wakeFoamAmount(wakePos, wakeSN, wakeProps, bow, bowSample.g, bowSample.b, pixel);
        vec3 foamColour = ${FOAM_ALBEDO.toFixed(3)} * (ambient + sunColour * max(dot(normal, sunDirection), 0.0));
        colour = mix(colour, foamColour, foam * ${WAKE.foamOpacity.toFixed(3)});
        // Fog toward the clear sky in this direction, in linear light like the dome, so the
        // water meets the horizon without a seam.
        float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
        if (fogFactor > 0.0) {
          vec2 away = -view.xz;
          vec3 horizonDirection = vec3(away.x, 0.0, away.y) / max(length(away), 1e-4);
          colour = mix(colour, skyRadiance(horizonDirection, 0, 0.0, 0.0), fogFactor);
        }
        gl_FragColor = vec4(colour, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(createWaterGrid(), material);
  // Shader displacement and a recentered horizon invalidate CPU frustum bounds.
  mesh.frustumCulled = false;
  return {
    mesh,
    update(origin, t) {
      const u = material.uniforms;
      (u.sunDirection!.value as THREE.Vector3).copy(sun.position).sub(sun.target.position).normalize();
      (u.sunColour!.value as THREE.Color).copy(sun.color).multiplyScalar(sun.intensity);
      (u.hemisphereSky!.value as THREE.Color).copy(hemisphere.color).multiplyScalar(hemisphere.intensity);
      (u.hemisphereGround!.value as THREE.Color).copy(hemisphere.groundColor).multiplyScalar(hemisphere.intensity);
      if (components !== cfg.components) {
        components = cfg.components;
        const shapes = material.uniforms.waveShape!.value as THREE.Vector4[];
        for (let i = 0; i < components.length; i++) {
          const w = components[i]!;
          shapes[i]!.set(w.dx, w.dz, w.k, w.amplitude);
        }
      }
      const motions = material.uniforms.waveMotion!.value as THREE.Vector2[];
      for (let i = 0; i < components.length; i++) {
        const w = components[i]!;
        motions[i]!.set(wavePhaseAt(w, origin.x, origin.z, t), w.choppiness);
      }
      material.uniforms.waveScale!.value = waveAmplitude(cfg);
    },
  };
}
