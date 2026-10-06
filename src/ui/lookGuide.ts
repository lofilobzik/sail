/**
 * First-time guidance that shows where to look, never what to think: a "click to look" mouse glyph
 * while the pointer is free, and one guide at a time pointing at a part of the boat that tells the
 * sailor something. Off screen it is a chevron at the edge toward the part; on screen a faint ring
 * around it. Holding the part near the middle of the view for a moment completes that guide for
 * good (remembered in Prefs). Guides appear when they become relevant:
 *   windex     shortly after the first look around (wind direction)
 *   tiller     after the tiller is first moved off centre (what A/D move)
 *   telltales  when the sail first luffs or stalls for a while (how the trim is going)
 * Reads only the camera and the boat's look targets; it never changes the sim.
 */
import * as THREE from 'three';
import type { LookTargets } from '../render/boatMesh';
import { savePrefs, type Prefs } from './prefs';

type GuideId = keyof LookTargets;

const WINDEX_DELAY = 3; // s of looking around before the first guide; TUNING GUESS
const TROUBLE_SECONDS = 1.5; // s of a luffing or stalled sail before the telltales guide; TUNING GUESS
const TROUBLE_LEVEL = 0.5; // luffAmount or stallAmount counted as trouble (the HUD's "luffing"/"stalled")
const TILLER_MOVED = 0.15; // tiller fraction counted as the first steering; TUNING GUESS
const HOLD_SECONDS = 1; // s with the target near the middle of the view to complete a guide; TUNING GUESS
const CENTRE_NDC = 0.45; // half-size of the middle region, normalised device coordinates
const ON_SCREEN_NDC = 0.88; // beyond this the target is pointed at from the edge instead of ringed
const GAP_SECONDS = 1.5; // s between one guide finishing and the next appearing
const EDGE_FRAC = 0.4; // chevron distance from the centre as a fraction of the viewport size
const RING_PX = 46;
const CHEVRON_PX = 40;

const STYLE = `
@keyframes lg-pulse{0%,100%{opacity:0.35}50%{opacity:1}}
@keyframes lg-ring{0%,100%{transform:translate(-50%,-50%) scale(1)}50%{transform:translate(-50%,-50%) scale(1.15)}}
.lg-click{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);display:none;flex-direction:column;align-items:center;gap:10px;
  pointer-events:none;user-select:none;z-index:6;color:rgba(255,255,255,0.9);
  font:500 12px system-ui,-apple-system,'Segoe UI',sans-serif;letter-spacing:0.04em;filter:drop-shadow(0 0 3px rgba(0,0,0,0.5));}
.lg-click .lg-button{animation:lg-pulse 1.4s ease-in-out infinite;}
.lg-mark{position:fixed;left:0;top:0;pointer-events:none;z-index:6;opacity:0;transition:opacity 0.6s;filter:drop-shadow(0 0 3px rgba(0,20,30,0.9));}
.lg-ring{width:${RING_PX}px;height:${RING_PX}px;border:2px solid rgba(255,255,255,0.9);border-radius:50%;box-sizing:border-box;
  box-shadow:0 0 0 1.5px rgba(0,20,30,0.45),inset 0 0 0 1.5px rgba(0,20,30,0.45);
  animation:lg-ring 1.6s ease-in-out infinite;}
`;

const MOUSE_SVG = `<svg width="34" height="50" viewBox="0 0 34 50" fill="none" stroke="currentColor" stroke-width="2">
<rect x="2" y="2" width="30" height="46" rx="15"/><line x1="17" y1="2" x2="17" y2="20"/>
<path class="lg-button" d="M3 17 A15 15 0 0 1 17 2 L17 20 L3 20 Z" fill="currentColor" stroke="none"/></svg>`;

// A dark stroke under the white one keeps the chevron readable against sail, deck and sky alike.
const CHEVRON_SVG = `<svg width="${CHEVRON_PX}" height="${CHEVRON_PX}" viewBox="0 0 28 28" fill="none" stroke-linecap="round"
stroke-linejoin="round"><polyline points="9,5 19,14 9,23" stroke="rgba(0,20,30,0.5)" stroke-width="5.5"/>
<polyline points="9,5 19,14 9,23" stroke="rgba(255,255,255,0.95)" stroke-width="3"/></svg>`;

export interface GuideInput {
  /** Real seconds since the last frame. */
  dt: number;
  /** The first-person camera, already positioned for this frame. */
  camera: THREE.PerspectiveCamera;
  /** Mouse captured for looking. */
  looking: boolean;
  /** Guides wait while the menu, another view, the binoculars or a reading has the player's attention. */
  busy: boolean;
  tiller: number;
  luffAmount: number;
  stallAmount: number;
}

export class LookGuide {
  private readonly click = document.createElement('div');
  private readonly chevron = document.createElement('div');
  private readonly ring = document.createElement('div');
  private readonly seen: Set<string>;
  /** Guides that have become relevant and wait their turn, oldest first. */
  private readonly queue: GuideId[] = [];
  private current: GuideId | null = null;
  private held = 0;
  private lookedAround = 0;
  private trouble = 0;
  private gap = 0;
  private readonly world = new THREE.Vector3();
  private readonly cam = new THREE.Vector3();

  constructor(
    private readonly targets: LookTargets,
    private readonly prefs: Prefs,
  ) {
    this.seen = new Set(prefs.guidesSeen);
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    this.click.className = 'lg-click';
    this.click.innerHTML = `${MOUSE_SVG}<span>click to look</span>`;
    this.chevron.className = 'lg-mark';
    this.chevron.innerHTML = CHEVRON_SVG;
    this.ring.className = 'lg-mark';
    this.ring.innerHTML = '<div class="lg-ring"></div>';
    document.body.append(this.click, this.chevron, this.ring);
  }

  /** Forgets every completed guide, so they appear again as they become relevant. */
  reset(): void {
    this.seen.clear();
    this.queue.length = 0;
    this.current = null;
    this.held = this.lookedAround = this.trouble = this.gap = 0;
    this.prefs.guidesSeen = [];
    savePrefs(this.prefs);
  }

  update(input: GuideInput, menuOpen: boolean): void {
    this.click.style.display = !input.looking && !menuOpen ? 'flex' : 'none';

    // Triggers: each guide becomes relevant once, unless already completed.
    if (input.looking) {
      this.lookedAround += input.dt;
      if (this.lookedAround >= WINDEX_DELAY) this.want('windex');
    }
    if (Math.abs(input.tiller) >= TILLER_MOVED) this.want('tiller');
    this.trouble = Math.max(input.luffAmount, input.stallAmount) >= TROUBLE_LEVEL ? this.trouble + input.dt : 0;
    if (this.trouble >= TROUBLE_SECONDS) this.want('telltales');

    const active = input.looking && !input.busy;
    if (!this.current) {
      this.gap = Math.max(this.gap - input.dt, 0);
      if (active && this.gap === 0 && this.queue.length) {
        this.current = this.queue.shift()!;
        this.held = 0;
      }
    }
    if (this.current && active) this.track(this.current, input);
    else this.place(null, 0, 0, 0);
  }

  private want(id: GuideId): void {
    if (!this.seen.has(id) && this.current !== id && !this.queue.includes(id)) this.queue.push(id);
  }

  private track(id: GuideId, input: GuideInput): void {
    const camera = input.camera;
    this.targets[id].getWorldPosition(this.world);
    this.cam.copy(this.world).applyMatrix4(camera.matrixWorldInverse);
    const inFront = this.cam.z < 0;
    const ndc = this.world.project(camera);
    const w = window.innerWidth;
    const h = window.innerHeight;

    if (inFront && Math.abs(ndc.x) < CENTRE_NDC && Math.abs(ndc.y) < CENTRE_NDC) this.held += input.dt;
    if (this.held >= HOLD_SECONDS) {
      this.seen.add(id);
      this.prefs.guidesSeen = [...this.seen];
      savePrefs(this.prefs);
      this.current = null;
      this.gap = GAP_SECONDS;
      this.place(null, 0, 0, 0);
      return;
    }

    if (inFront && Math.abs(ndc.x) < ON_SCREEN_NDC && Math.abs(ndc.y) < ON_SCREEN_NDC) {
      this.place('ring', ((ndc.x + 1) / 2) * w, ((1 - ndc.y) / 2) * h, 0);
      return;
    }
    // Off screen or behind: point from the middle toward the target's direction in the view plane.
    // A target straight behind has no direction on screen, so it is pointed at from below.
    const dx = this.cam.x;
    let dy = this.cam.y;
    if (Math.hypot(dx, dy) < 1e-3) dy = -1;
    const angle = Math.atan2(-dy, dx);
    this.place('chevron', w / 2 + Math.cos(angle) * w * EDGE_FRAC, h / 2 + Math.sin(angle) * h * EDGE_FRAC, angle);
  }

  private place(which: 'ring' | 'chevron' | null, x: number, y: number, angle: number): void {
    const ring = which === 'ring';
    const chevron = which === 'chevron';
    this.ring.style.opacity = ring ? '1' : '0';
    this.chevron.style.opacity = chevron ? '1' : '0';
    if (ring) this.ring.style.transform = `translate(${x}px, ${y}px)`;
    if (chevron) this.chevron.style.transform = `translate(${x - CHEVRON_PX / 2}px, ${y - CHEVRON_PX / 2}px) rotate(${angle}rad)`;
  }
}
