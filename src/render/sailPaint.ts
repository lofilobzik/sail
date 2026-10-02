/**
 * Procedural sail textures: each design in data/sail-designs.json is drawn once onto a canvas the
 * first time it is selected, then cached as a Three.js texture. Nothing is loaded from an image.
 */
import * as THREE from 'three';
import designFile from '../data/sail-designs.json';
import { drawSailDesign, parseDesignFile, type DesignInfo } from './sailDesign';

/** Parsed and validated at startup, so a typo in the JSON fails loudly and names the design. */
export const SAIL_DESIGNS = parseDesignFile(designFile);

const ANISOTROPY = 4; // visual estimate: keeps stripes crisp at the grazing angles of the cockpit view

export class SailPaint {
  readonly designs: readonly DesignInfo[] = SAIL_DESIGNS.designs.map(
    ({ id, name, opacity, glow }): DesignInfo => ({ id, name, opacity, glow }),
  );
  private readonly cache = new Map<string, THREE.CanvasTexture>();
  private readonly width = SAIL_DESIGNS.textureWidth;
  private readonly height: number;

  /** `aspect` is the cloth's physical width / height, so the canvas has the sail's proportions. */
  constructor(aspect: number) {
    this.height = Math.round(this.width / aspect);
  }

  texture(id: string): THREE.CanvasTexture {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const design = SAIL_DESIGNS.designs.find((d) => d.id === id);
    if (!design) throw new Error(`unknown sail design "${id}"; known: ${this.designs.map((d) => d.id).join(', ')}`);
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is not available, so sail designs cannot be drawn');
    drawSailDesign(ctx, design, SAIL_DESIGNS.finish, this.width, this.height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = ANISOTROPY;
    this.cache.set(id, texture);
    return texture;
  }
}
