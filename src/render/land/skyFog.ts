/**
 * Land fog toward the sky's own horizon colour in each view direction, the same target the water
 * fogs toward (render/water.ts), so distant hills, the sea and the dome meet without a colour seam
 * whatever the sun bearing. Uses the scene's linear fog distances; costs one clear-sky evaluation.
 */
import type * as THREE from 'three';
import { skyGLSL, type SkyView } from '../sky';

const FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
  // View-space ray back to world space (transpose of the view rotation), flattened to the horizon.
  vec3 fogRay = (vec4(-vViewPosition, 0.0) * viewMatrix).xyz;
  vec3 fogHorizon = vec3(fogRay.x, 0.0, fogRay.z) / max(length(fogRay.xz), 1e-4);
  vec3 fogSky = linearToOutputTexel(vec4(skyRadiance(fogHorizon, 0, 0.0, 0.0), 1.0)).rgb;
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogSky, fogFactor);
#endif
`;

/** Patch a lit three material (it must declare `vViewPosition`) to fog toward the sky horizon. */
export function fogTowardSky<T extends THREE.Material>(material: T, sky: SkyView): T {
  material.onBeforeCompile = (shader) => {
    // Shared by reference: the sky updates its uniforms in place.
    Object.assign(shader.uniforms, sky.uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <fog_pars_fragment>', `#include <fog_pars_fragment>\n${skyGLSL()}`)
      .replace('#include <fog_fragment>', FOG_FRAGMENT);
  };
  material.customProgramCacheKey = () => 'land-sky-fog';
  return material;
}
