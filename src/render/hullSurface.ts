/** Owned, mipmapped moulded gelcoat relief; no extra coplanar deck geometry. */
import * as THREE from 'three';
import details from '../../data/hull-details.json';
import type { BoatLayout } from './boatLayout';

interface Bounds { aft: number; fore: number; halfWidth: number }

/** Positive inside the rounded cockpit outline, negative outside. */
function cockpitDistance(layout: BoatLayout, x: number, y: number): number {
  const c = layout.cockpit;
  const qx = Math.abs(x - (c.aft + c.fore) / 2) - ((c.fore - c.aft) / 2 - c.radius);
  const qy = Math.abs(y) - (c.halfWidth - c.radius);
  return c.radius - Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - Math.min(Math.max(qx, qy), 0);
}

function surfaceBounds(layout: BoatLayout, floor: boolean): Bounds {
  return floor
    ? { aft: layout.cockpit.aft, fore: layout.cockpit.fore, halfWidth: layout.cockpit.halfWidth }
    : { aft: layout.transomX, fore: layout.bowX, halfWidth: layout.model.cfg.hull.beam / 2 };
}

export function gelcoatSurface(layout: BoatLayout, geometry: THREE.BufferGeometry, floor: boolean): THREE.MeshStandardMaterial {
  const s = details.surface;
  const bounds = surfaceBounds(layout, floor);
  const length = bounds.fore - bounds.aft;
  const width = 2 * bounds.halfWidth;
  const positions = geometry.getAttribute('position');
  const uv = new Float32Array(positions.count * 2);
  for (let i = 0; i < positions.count; i++) {
    uv[2 * i] = (-positions.getZ(i) - bounds.aft) / length;
    uv[2 * i + 1] = (positions.getX(i) + bounds.halfWidth) / width;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));

  const textureWidth = floor ? s.floorTextureWidth : s.deckTextureWidth;
  const textureHeight = floor ? s.floorTextureHeight : s.deckTextureHeight;
  const pixels = new Uint8Array(textureWidth * textureHeight * 4);
  const xPositions = new Float64Array(textureWidth);
  const halfBeams = new Float64Array(textureWidth);
  const xRelief = new Float64Array(textureWidth);
  const frequency = Math.PI * 2 / s.mouldPitch;
  for (let column = 0; column < textureWidth; column++) {
    const x = bounds.aft + (column + 0.5) / textureWidth * length;
    xPositions[column] = x;
    halfBeams[column] = floor ? 0 : layout.halfBeamAt(x);
    xRelief[column] = Math.cos(x * frequency);
  }
  for (let row = 0; row < textureHeight; row++) {
    const y = ((row + 0.5) / textureHeight - 0.5) * width;
    const yRelief = Math.cos(y * frequency);
    for (let column = 0; column < textureWidth; column++) {
      const x = xPositions[column]!;
      const cockpit = cockpitDistance(layout, x, y);
      const distance = floor ? cockpit - s.floorMargin : Math.min(
        halfBeams[column]! - Math.abs(y) - s.deckMargin,
        x - bounds.aft - s.deckMargin,
        bounds.fore - x - s.deckMargin,
        -cockpit - details.coaming.width - s.deckMargin,
      );
      const t = THREE.MathUtils.clamp(distance / s.maskFeather, 0, 1);
      const mask = t * t * (3 - 2 * t);
      // VISUAL ESTIMATE: softly rounded, crossed moulded diamonds, not dirt/noise flecks.
      const diamond = xRelief[column]! * yRelief * 0.5;
      const index = (row * textureWidth + column) * 4;
      pixels[index] = Math.round(128 + diamond * 96 * mask);
      pixels[index + 1] = Math.round(255 * (s.smoothRoughness + mask * (s.nonSlipRoughness - s.smoothRoughness)));
      // Tiny linear-light tonal relief makes grip regions legible without relying
      // on a specular highlight; smooth margins retain the original gelcoat colour.
      pixels[index + 2] = Math.round(255 * (1 + mask * (s.nonSlipTone - 1 + diamond * 2 * s.mouldToneContrast)));
      pixels[index + 3] = 255;
    }
  }
  // Red is relief, green roughness, blue subtle diffuse tone. This texture is
  // owned only by this boat/material and stays in the standard texture properties.
  const texture = new THREE.DataTexture(pixels, textureWidth, textureHeight, THREE.RGBAFormat);
  texture.name = floor ? 'cockpit-moulded-gelcoat' : 'deck-moulded-gelcoat';
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = s.anisotropy;
  texture.needsUpdate = true;
  const material = new THREE.MeshStandardMaterial({
    color: floor ? details.colours.floor : details.colours.deck,
    roughness: 1,
    metalness: 0,
    bumpMap: texture,
    bumpScale: s.bumpScale,
    roughnessMap: texture,
    side: THREE.DoubleSide,
  });
  // Reuse the existing roughness-map fetch. Tonal relief is mipmapped together
  // with bump/roughness, so distant diamonds resolve to their restrained mean.
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
      #ifdef USE_ROUGHNESSMAP
        diffuseColor.rgb *= texelRoughness.b;
      #endif`);
  };
  material.customProgramCacheKey = () => 'moulded-gelcoat-tone';
  return material;
}
