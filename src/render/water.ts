/** World-anchored Gerstner water; CPU samples and this shader share waves.ts. */
import * as THREE from 'three';
import { gerstnerGLSL, waveAmplitude, WAVE_PARAMETERS, type WaveConfig } from '../sim/waves';

const WATER_COLOR = 0x1f4f6e; // TUNING GUESS: deep-water body colour
const WATER_REFRACTIVE_INDEX = 1.333; // Water/air index; https://en.wikipedia.org/wiki/Refractive_index
const WATER_F0 = ((WATER_REFRACTIVE_INDEX - 1) / (WATER_REFRACTIVE_INDEX + 1)) ** 2;
const SUN_SHININESS = 96; // TUNING GUESS: broad water glint, no measured roughness

export interface WaterView {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  update(x: number, z: number, t: number): void;
}

/** Signed-power spacing concentrates vertices near the boat, not at the horizon. */
function createWaterGrid(): THREE.BufferGeometry {
  const { waterSize, waterSegments: segments, waterGridPower: power } = WAVE_PARAMETERS;
  const side = segments + 1;
  const positions = new Float32Array(side * side * 3);
  const indices = new Uint32Array(segments * segments * 6);
  for (let row = 0; row <= segments; row++) {
    const rz = 2 * row / segments - 1;
    const z = Math.sign(rz) * Math.abs(rz) ** power * waterSize / 2;
    for (let col = 0; col <= segments; col++) {
      const rx = 2 * col / segments - 1;
      const offset = (row * side + col) * 3;
      positions[offset] = Math.sign(rx) * Math.abs(rx) ** power * waterSize / 2;
      positions[offset + 2] = z;
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
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/** Read the existing dome's endpoint colours rather than introducing another sky. */
function skyColours(sky: THREE.Mesh): { horizon: THREE.Color; zenith: THREE.Color } {
  const positions = sky.geometry.getAttribute('position');
  const colours = sky.geometry.getAttribute('color');
  let highest = 0, lowest = 0;
  for (let i = 1; i < positions.count; i++) {
    if (positions.getY(i) > positions.getY(highest)) highest = i;
    if (positions.getY(i) < positions.getY(lowest)) lowest = i;
  }
  return {
    horizon: new THREE.Color().fromBufferAttribute(colours, lowest),
    zenith: new THREE.Color().fromBufferAttribute(colours, highest),
  };
}

export function createWater(
  cfg: WaveConfig, sky: THREE.Mesh, sun: THREE.DirectionalLight,
  hemisphere: THREE.HemisphereLight, snapSize: number,
): WaterView {
  const colours = skyColours(sky);
  let components = cfg.components;
  const material = new THREE.ShaderMaterial({
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        waveTime: { value: 0 },
        waveScale: { value: waveAmplitude(cfg) },
        waveShape: { value: components.map((w) => new THREE.Vector4(w.dx, w.dz, w.k, w.amplitude)) },
        waveMotion: { value: components.map((w) => new THREE.Vector3(w.omega, w.phase, w.choppiness)) },
        waterColour: { value: new THREE.Color(WATER_COLOR) },
        skyHorizon: { value: colours.horizon },
        skyZenith: { value: colours.zenith },
        sunDirection: { value: sun.position.clone().sub(sun.target.position).normalize() },
        sunColour: { value: sun.color.clone().multiplyScalar(sun.intensity) },
        hemisphereSky: { value: hemisphere.color.clone().multiplyScalar(hemisphere.intensity) },
        hemisphereGround: { value: hemisphere.groundColor.clone().multiplyScalar(hemisphere.intensity) },
      },
    ]),
    vertexShader: `
      uniform float waveTime;
      uniform float waveScale;
      varying vec3 waterPosition;
      varying vec3 waterNormal;
      #include <fog_pars_vertex>
      ${gerstnerGLSL(cfg.components)}
      void main() {
        // Snapping changes tessellation only. Phase is always evaluated in world x/z.
        vec2 label = position.xz + modelMatrix[3].xz;
        gerstnerWave(label, waveTime, waveScale, waterPosition, waterNormal);
        vec4 mvPosition = viewMatrix * vec4(waterPosition, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: `
      uniform vec3 waterColour;
      uniform vec3 skyHorizon;
      uniform vec3 skyZenith;
      uniform vec3 sunDirection;
      uniform vec3 sunColour;
      uniform vec3 hemisphereSky;
      uniform vec3 hemisphereGround;
      varying vec3 waterPosition;
      varying vec3 waterNormal;
      #include <fog_pars_fragment>
      void main() {
        vec3 normal = normalize(waterNormal);
        vec3 view = normalize(cameraPosition - waterPosition);
        vec3 reflection = reflect(-view, normal);
        // Same square-root horizon-to-zenith gradient as createSky's current dome.
        vec3 reflectedSky = mix(skyHorizon, skyZenith, sqrt(max(reflection.y, 0.0)));
        // Schlick Fresnel: water/air normal-incidence reflectance from their indices.
        float fresnel = ${WATER_F0.toExponential(16)} + (1.0 - ${WATER_F0.toExponential(16)})
          * pow(1.0 - max(dot(normal, view), 0.0), 5.0);
        vec3 ambient = mix(hemisphereGround, hemisphereSky, normal.y * 0.5 + 0.5);
        vec3 diffuse = waterColour * (ambient + sunColour * max(dot(normal, sunDirection), 0.0));
        float glint = pow(max(dot(reflection, sunDirection), 0.0), ${SUN_SHININESS.toFixed(1)});
        vec3 colour = mix(diffuse, reflectedSky + sunColour * glint, fresnel);
        gl_FragColor = vec4(colour, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(createWaterGrid(), material);
  // Shader displacement and a recentered horizon invalidate CPU frustum bounds.
  mesh.frustumCulled = false;
  return {
    mesh,
    update(x, z, t) {
      if (components !== cfg.components) {
        components = cfg.components;
        const shapes = material.uniforms.waveShape!.value as THREE.Vector4[];
        const motions = material.uniforms.waveMotion!.value as THREE.Vector3[];
        for (let i = 0; i < components.length; i++) {
          const w = components[i]!;
          shapes[i]!.set(w.dx, w.dz, w.k, w.amplitude);
          motions[i]!.set(w.omega, w.phase, w.choppiness);
        }
      }
      mesh.position.set(Math.round(x / snapSize) * snapSize, 0, Math.round(z / snapSize) * snapSize);
      material.uniforms.waveTime!.value = t;
      material.uniforms.waveScale!.value = waveAmplitude(cfg);
    },
  };
}
