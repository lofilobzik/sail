/**
 * Binoculars: while raised the cockpit camera's field of view narrows smoothly to 1/zoom of its
 * normal tangent, and a two-lens mask fades in. The line of sight (and so every bearing) is
 * untouched; only the projection changes. Numbers are in data/navigation.json `visual`.
 */
import * as THREE from 'three';
import { NAVIGATION } from '../nav/navigation';

const SVG_NS = 'http://www.w3.org/2000/svg';
const LENS_RADIUS = 0.47; // VISUAL ESTIMATE: lens radius as a fraction of the screen height
const LENS_OFFSET = 0.62; // VISUAL ESTIMATE: lens centre offset from the middle, in lens radii (they overlap)

export class Binoculars {
  /** Current magnification, 1 = naked eye. */
  zoom = 1;
  private readonly svg = document.createElementNS(SVG_NS, 'svg');
  private readonly lenses: SVGCircleElement[] = [];
  private lastFov = NaN;
  private lastOpacity = '';

  constructor(private readonly camera: THREE.PerspectiveCamera, private readonly baseFov: number) {
    this.svg.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:5;opacity:0;';
    const mask = document.createElementNS(SVG_NS, 'mask');
    mask.id = 'binocular-mask';
    const field = document.createElementNS(SVG_NS, 'rect');
    field.setAttribute('width', '100%'); field.setAttribute('height', '100%'); field.setAttribute('fill', 'white');
    mask.appendChild(field);
    for (let i = 0; i < 2; i++) {
      const lens = document.createElementNS(SVG_NS, 'circle');
      lens.setAttribute('fill', 'black');
      mask.appendChild(lens);
      this.lenses.push(lens);
    }
    const defs = document.createElementNS(SVG_NS, 'defs');
    defs.appendChild(mask);
    const cover = document.createElementNS(SVG_NS, 'rect');
    cover.setAttribute('width', '100%'); cover.setAttribute('height', '100%');
    cover.setAttribute('fill', '#050505'); cover.setAttribute('mask', 'url(#binocular-mask)');
    this.svg.append(defs, cover);
    document.body.appendChild(this.svg);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /** How far up the glasses are, 0 (down) to 1 (full zoom), on a log scale like the eye's sense of zoom. */
  get raisedAmount(): number {
    return Math.log(this.zoom) / Math.log(NAVIGATION.visual.binocularZoom);
  }

  /** Ease toward full zoom while raised and back to 1 otherwise; frame-rate independent. */
  update(dt: number, raised: boolean): void {
    const v = NAVIGATION.visual;
    const target = raised ? Math.log(v.binocularZoom) : 0;
    const k = 1 - Math.exp(-dt / v.binocularSeconds);
    const logZoom = Math.log(this.zoom);
    this.zoom = Math.exp(logZoom + (target - logZoom) * k);
    if (Math.abs(this.zoom - 1) < 1e-3 && !raised) this.zoom = 1;

    // tan(fov/2) shrinks by the zoom factor.
    const half = Math.tan((this.baseFov * Math.PI) / 360) / this.zoom;
    const fov = (2 * Math.atan(half) * 180) / Math.PI;
    if (fov !== this.lastFov) {
      this.lastFov = fov;
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    // The mask comes in over the first part of the zoom, so the view never pops.
    const t = Math.min(1, this.raisedAmount * 3);
    const opacity = (t * t * (3 - 2 * t)).toFixed(3);
    if (opacity !== this.lastOpacity) {
      this.lastOpacity = opacity;
      this.svg.style.opacity = opacity;
    }
  }

  private resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    const r = LENS_RADIUS * h;
    this.lenses.forEach((lens, i) => {
      lens.setAttribute('cx', String(w / 2 + (i === 0 ? -1 : 1) * LENS_OFFSET * r));
      lens.setAttribute('cy', String(h / 2));
      lens.setAttribute('r', String(r));
    });
  }
}
