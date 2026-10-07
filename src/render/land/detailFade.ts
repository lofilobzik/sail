/**
 * Small house details (windows, doors and their trim) melt into their wall once a metre spans only a
 * few pixels on screen. Drawn smaller than that, a dark pane in a pale frame cannot be sampled cleanly,
 * so it crawls and breaks up into jagged shapes as the camera moves. The fade follows on-screen size,
 * not distance, so the binoculars bring the detail back. Geometry carries a `baseColor` per vertex:
 * the wall colour for a detail, its own colour for everything else (houseModels.ts).
 */
import * as THREE from 'three';

/** x: pixels a metre spans at 1 m (set every frame from the camera); y, z: sizes in pixels where a
 * one-metre detail is fully faded and fully drawn (VISUAL ESTIMATE). */
export const DETAIL_FADE = { value: new THREE.Vector3(1000, 2.5, 6) };
const FADED_PX = 2.5;
const DRAWN_PX = 6;

/** Updates the on-screen scale for the camera about to draw: `bufferHeight` pixels across `fovDeg`. */
export function setDetailScale(bufferHeight: number, fovDeg: number): void {
  DETAIL_FADE.value.x = bufferHeight / (2 * Math.tan((fovDeg * Math.PI) / 360));
}

/** Checking aid (?detailfade=0): draw details at every size. */
export function setDetailFade(on: boolean): void {
  DETAIL_FADE.value.y = on ? FADED_PX : 0;
  DETAIL_FADE.value.z = on ? DRAWN_PX : 0;
}

/** Adds the fade to a vertex-coloured lit material, after any shader patch it already has. */
export function fadeDetailBySize<T extends THREE.Material>(material: T): T {
  const previous = material.onBeforeCompile.bind(material);
  const previousKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    shader.uniforms.detailFade = DETAIL_FADE;
    shader.vertexShader = shader.vertexShader
      .replace('#include <color_pars_vertex>', '#include <color_pars_vertex>\nattribute vec3 baseColor;\nuniform vec3 detailFade;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        float detailPixels = detailFade.x / max(-mvPosition.z, 1e-3);
        vColor.rgb = mix(baseColor, vColor.rgb, detailFade.z > 0.0 ? smoothstep(detailFade.y, detailFade.z, detailPixels) : 1.0);`);
  };
  material.customProgramCacheKey = () => `${previousKey()}+detail-fade`;
  return material;
}
