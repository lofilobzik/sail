/** World-anchored Gerstner water, tinted over baked shallows; CPU samples and this shader share waves.ts. */
import * as THREE from 'three';
import { gerstnerGLSL, waveAmplitude, wavePhaseAt, WAVE_PARAMETERS, type WaveConfig } from '../sim/waves';
import type { Vec2 } from '../sim/frames';
import { terrainGrid } from '../sim/terrain';
import type { WakeView } from './wake';
import { WAKE, wakeFrameGLSL, wakeShadeGLSL } from './wake/kelvin';
import { skyGLSL, type SkyView } from './sky';
import { gustGLSL, type GustMap } from './gustMap';
import { SKY } from './skyModel';

const WATER_COLOR = 0x1f4f6e; // TUNING GUESS: deep-water body colour
const WATER_REFRACTIVE_INDEX = 1.333; // Water/air index; https://en.wikipedia.org/wiki/Refractive_index
const WATER_F0 = ((WATER_REFRACTIVE_INDEX - 1) / (WATER_REFRACTIVE_INDEX + 1)) ** 2;
const SUN_SHININESS = 96; // TUNING GUESS: broad water glint, no measured roughness
const FOAM_ALBEDO = 0.85; // TUNING GUESS: whitewater diffuse reflectance
// Shallows, VISUAL ESTIMATE from aerial photos of sandy bays: sand shows through the first metre,
// turquoise to a few metres, then the deep body colour. The bed colour replaces the body colour
// under the Fresnel reflection (partly, see SHALLOW_GLANCE).
const SHALLOW_SAND = 0xa3ae8a; // wet sand under a few centimetres of water
const SHALLOW_TURQUOISE = 0x22706e;
const SHALLOW_TURQUOISE_DEPTH = 1.2; // m: sand to turquoise
const SHALLOW_DEPTH = 5; // m: turquoise to the deep body colour
const SHALLOW_DEPTH_RANGE = 32; // m: the baked depth is clamped to +/- this (half-float texture)
// Fraction of the Fresnel reflection the bed replaces over the shallowest water. Physically the
// bed vanishes at grazing angles; seen from a dinghy that hides every shoal, so this VISUAL
// ESTIMATE keeps shoals and beaches readable from a sitting eye height.
const SHALLOW_GLANCE = 0.5;
// At grazing angles the sky's brightness changes so fast with elevation that a degree of ripple
// tilt streaks the reflection with white scratches. Real water averages that tilt over the
// surface a pixel covers, so the sea's slope is damped toward flat as the view gets shallower
// (VISUAL ESTIMATE): full slope above GRAZING_FULL (sine of elevation), GRAZING_FLOOR of it at the horizon.
const GRAZING_FLOOR = 0.4;
const GRAZING_FULL = 0.3;
// Surf and whitecaps, all VISUAL ESTIMATE. Shore foam rides on the seabed depth the shader already
// fetches (no extra texture reads): a swash line that breathes in and out along every beach, wall
// and shoal, with thinner lines of foam trailing it out to SHORE_LINES_DEPTH.
const SHORE_SWASH_DEPTH = 0.4; // m: mean depth of the swash line
const SHORE_SWASH_RANGE = 0.3; // m: how far the line runs up and down the beach
const SHORE_SWASH_RATE = 0.8; // rad/s
const SHORE_LINES_DEPTH = 2.2; // m: trailing lines of foam fade out by this depth
const SHORE_FOAM_OPACITY = 0.9;
// Whitecaps break off the highest crests once the sea is up: amplitude scale 1 is the 7 kn
// reference (data/waves.json), so they start near 8 kn and are widespread by 12 kn.
const CAPS_FROM = 1.25;
const CAPS_FULL = 2.0;
const CAPS_OPACITY = 0.7;
const CAPS_COVERAGE = 0.85; // fraction of the highest crests that break at full sea
// Light scattered through thin crests toward a viewer looking at the sun.
const SCATTER_COLOUR = 0x2a9a86;
const SCATTER_GAIN = 0.45;

/**
 * Seabed elevation baked once from terrainGrid() into a single-channel half-float texture in
 * logical world coordinates (texel centres on the grid samples), sampled with hardware filtering.
 */
function createShallowsTexture(): { texture: THREE.DataTexture; bounds: THREE.Vector4 } {
  const grid = terrainGrid();
  const data = new Uint16Array(grid.heights.length);
  for (let i = 0; i < data.length; i++) {
    const h = Math.min(Math.max(grid.heights[i]!, -SHALLOW_DEPTH_RANGE), SHALLOW_DEPTH_RANGE);
    data[i] = THREE.DataUtils.toHalfFloat(h);
  }
  const texture = new THREE.DataTexture(data, grid.columns, grid.rows, THREE.RedFormat, THREE.HalfFloatType);
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  const width = grid.columns * grid.cell, height = grid.rows * grid.cell;
  return {
    texture,
    // uv = (world - corner) * scale; the corner is half a cell outside the first sample.
    bounds: new THREE.Vector4(grid.minX - grid.cell / 2, grid.minZ - grid.cell / 2, 1 / width, 1 / height),
  };
}

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
  cfg: WaveConfig, sky: SkyView, gusts: GustMap, sun: THREE.DirectionalLight,
  hemisphere: THREE.HemisphereLight, wake: WakeView,
): WaterView {
  let components = cfg.components;
  const waveCode = gerstnerGLSL(components);
  const wakeShade = wakeShadeGLSL();
  const shallows = createShallowsTexture();
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
        shallowSand: { value: new THREE.Color(SHALLOW_SAND) },
        shallowTurquoise: { value: new THREE.Color(SHALLOW_TURQUOISE) },
        waterTime: { value: 0 },
        // Highest crest above the mean surface, m: the sum of the component amplitudes at this scale.
        waveHeight: { value: 0 },
        scatterColour: { value: new THREE.Color(SCATTER_COLOUR) },
        sunDirection: { value: sun.position.clone().sub(sun.target.position).normalize() },
        sunColour: { value: sun.color.clone().multiplyScalar(sun.intensity) },
        hemisphereSky: { value: hemisphere.color.clone().multiplyScalar(hemisphere.intensity) },
        hemisphereGround: { value: hemisphere.groundColor.clone().multiplyScalar(hemisphere.intensity) },
      },
    ]), wake.uniforms, sky.uniforms, gusts.uniforms, {
      // By reference: merge would clone the texture and upload it twice.
      shallowsTexture: { value: shallows.texture },
      shallowsBounds: { value: shallows.bounds },
      // Logical world position of render-local zero, for the world-anchored seabed lookup.
      renderOrigin: { value: new THREE.Vector2() },
    }),
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
        waterPosition.y += wakeLayers.x * kelvinWake(wakeSN, wakeProps, cell).x * wakeHullMask(wakePos)
          + wakeLayers.y * bowSample.r * wakeBowFilter(bowSample, cell);
        vec4 mvPosition = viewMatrix * vec4(waterPosition, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: `
      uniform vec3 waterColour;
      uniform vec3 shallowSand;
      uniform vec3 shallowTurquoise;
      uniform vec3 scatterColour;
      uniform float waterTime;
      uniform float waveHeight;
      uniform sampler2D shallowsTexture;
      uniform vec4 shallowsBounds; // world corner x, z; 1 / world width, 1 / world depth
      uniform vec2 renderOrigin;
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
      ${gustGLSL()}
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
        vec3 kelvin = wakeLayers.x * kelvinWake(wakeSN, wakeProps, pixel) * hullMask;
        vec2 tangent = wakeSN.zw / max(length(wakeSN.zw), 1e-6);
        vec3 view = normalize(cameraPosition - waterPosition);
        float grazing = mix(${GRAZING_FLOOR.toFixed(2)}, 1.0, smoothstep(0.0, ${GRAZING_FULL.toFixed(2)}, view.y));
        vec2 slope = grazing * (-normal.xz / normal.y)
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
        slope += wakeLayers.y * bowGradient;
        normal = normalize(vec3(-slope.x, 1.0, -slope.y));

        vec3 reflection = reflect(-view, normal);
        // Schlick Fresnel: water/air normal-incidence reflectance from their indices.
        float fresnel = ${WATER_F0.toExponential(16)} + (1.0 - ${WATER_F0.toExponential(16)})
          * pow(1.0 - max(dot(normal, view), 0.0), 5.0);
        // The same sky function as the dome. Clouds fade in with the reflectance (TUNING GUESS,
        // data/sky.json) so steep, weakly reflecting views skip the cloud noise.
        vec3 reflectedSky = skyRadiance(reflection, ${SKY.waterCloudOctaves}, 0.0,
          smoothstep(${SKY.waterCloudFresnelFrom}, ${SKY.waterCloudFresnelFull}, fresnel));
        vec3 ambient = mix(hemisphereGround, hemisphereSky, normal.y * 0.5 + 0.5);
        // Shallows: one filtered fetch of the baked seabed, in logical world coordinates. Outside
        // the bake the sea is deep.
        vec2 seabedUV = (waterPosition.xz + renderOrigin - shallowsBounds.xy) * shallowsBounds.zw;
        float baked = all(equal(seabedUV, clamp(seabedUV, 0.0, 1.0))) ? 1.0 : 0.0;
        float depth = -texture2D(shallowsTexture, seabedUV).r;
        vec3 bed = mix(shallowSand, shallowTurquoise, smoothstep(0.0, ${SHALLOW_TURQUOISE_DEPTH.toFixed(2)}, depth));
        float shallow = baked * (1.0 - smoothstep(0.0, ${SHALLOW_DEPTH.toFixed(2)}, depth));
        vec3 body = mix(waterColour, bed, shallow);
        vec3 diffuse = body * (ambient + sunColour * max(dot(normal, sunDirection), 0.0));
        // Crest height, -1 trough to +1 crest, from the same wave sum the surface uses.
        float crestHeight = clamp(surfacePosition.y / max(waveHeight, 1e-3), -1.0, 1.0);
        // Light scattered through the thin crest, strongest looking toward the sun.
        float towardSun = max(dot(-view, sunDirection), 0.0);
        diffuse += scatterColour * sunColour * ${SCATTER_GAIN.toFixed(2)}
          * smoothstep(-0.3, 1.0, crestHeight) * (0.2 + 0.8 * towardSun * towardSun) * (1.0 - shallow);
        // TUNING GUESS: broaden the specular lobe by the pixel's normal variance;
        // preserve the cosine-power lobe's integrated energy instead of flashing
        // a narrow highlight on/off as it crosses a pixel.
        vec3 normalDx = dFdx(normal), normalDy = dFdy(normal);
        float variance = dot(normalDx, normalDx) + dot(normalDy, normalDy);
        float glintPower = ${SUN_SHININESS.toFixed(1)} / (1.0 + ${SUN_SHININESS.toFixed(1)} * variance);
        float glint = pow(max(dot(reflection, sunDirection), 0.0), glintPower)
          * (glintPower + 1.0) / ${(SUN_SHININESS + 1).toFixed(1)};
        // Over the shallows the bright bed keeps part of its colour even at grazing angles,
        // so shoals and beaches still read from a sitting eye height.
        vec3 colour = mix(diffuse, reflectedSky + sunColour * glint, fresnel * (1.0 - ${SHALLOW_GLANCE.toFixed(2)} * shallow));
        // Gust patches (cat's paws): wind ruffles the surface, which scatters light, so the water
        // darkens where the sim's wind is stronger; lulls are slightly smoother and brighter.
        float gust = gustAmount(waterPosition.xz);
        colour *= 1.0 - gustMapInfo.z * max(gust, 0.0) + gustMapInfo.w * max(-gust, 0.0);
        // Whitewater: diffuse, unpolished, so it replaces the reflective water colour.
        float foam = wakeLayers.z * wakeFoamAmount(wakePos, wakeSN, wakeProps, bow, bowSample.g, bowSample.b, pixel);
        vec3 foamColour = ${FOAM_ALBEDO.toFixed(3)} * (ambient + sunColour * max(dot(normal, sunDirection), 0.0));
        float foamOpacity = foam * ${WAKE.foamOpacity.toFixed(3)};
        // Whitecaps: the highest crests break once the sea is up, in patches that share the wake's
        // foam grain. Skipped (a uniform branch) at the reference wind and below.
        if (waveScale > ${CAPS_FROM.toFixed(2)}) {
          float capCover = ${CAPS_COVERAGE.toFixed(2)} * smoothstep(${CAPS_FROM.toFixed(2)}, ${CAPS_FULL.toFixed(2)}, waveScale)
            * smoothstep(0.5, 0.9, crestHeight);
          if (capCover > 0.0) {
            float grain = wakeNoise(wakePos, pixel);
            // A second sample at another scale and offset breaks up the first one's regular lattice.
            float ragged = wakeNoise(wakePos * 1.9 + vec2(41.0, 17.0), pixel * 1.9);
            float capGrain = clamp(0.5 + 1.4 * (0.5 * (grain + ragged) - 0.5), 0.0, 1.0);
            foamOpacity = max(foamOpacity, ${CAPS_OPACITY.toFixed(2)}
              * smoothstep(1.0 - capCover, 1.0 - capCover + 0.25, capGrain) * capCover);
          }
        }
        // Surf: a swash line that breathes up and down the beach with lines of foam trailing it.
        // Only the few pixels over shallows pay for it.
        float shoreDepth = max(depth, 0.0);
        if (baked > 0.5 && shoreDepth < ${SHORE_LINES_DEPTH.toFixed(2)}) {
          float grain = wakeNoise(wakePos, pixel);
          float shorePhase = waterTime * ${SHORE_SWASH_RATE.toFixed(2)} + 6.0 * grain;
          float swash = ${SHORE_SWASH_DEPTH.toFixed(2)} + ${SHORE_SWASH_RANGE.toFixed(2)} * sin(shorePhase);
          float edge = 1.0 - smoothstep(0.0, 0.3, shoreDepth - swash);
          float lines = smoothstep(0.75, 1.0, 0.5 + 0.5 * sin(shoreDepth * 5.5 - waterTime * 1.1 + 4.0 * grain))
            * (1.0 - smoothstep(${SHORE_SWASH_DEPTH.toFixed(2)}, ${SHORE_LINES_DEPTH.toFixed(2)}, shoreDepth));
          float surf = max(edge, 0.55 * lines) * smoothstep(0.3, 0.6, grain);
          foamOpacity = max(foamOpacity, ${SHORE_FOAM_OPACITY.toFixed(2)} * surf);
        }
        colour = mix(colour, foamColour, foamOpacity);
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
      (u.renderOrigin!.value as THREE.Vector2).set(origin.x, origin.z);
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
      const scale = waveAmplitude(cfg);
      material.uniforms.waveScale!.value = scale;
      material.uniforms.waterTime!.value = t;
      material.uniforms.waveHeight!.value = scale * components.reduce((sum, w) => sum + w.amplitude, 0);
    },
  };
}
