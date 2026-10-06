/**
 * First-time guidance that shows where to look, never what to think: a "click to look" mouse glyph
 * while the pointer is free, and one guide at a time pointing at a part of the boat that tells the
 * sailor something. Off screen it is a chevron at the edge toward the part; on screen a faint ring
 * around it, with one word naming what the part is for. A guide completes for good once its ring has
 * been on screen for a moment (remembered in Prefs). Guides appear when they become relevant, and when
 * several are waiting the earlier in this list goes first:
 *   tiller     after the tiller is first moved well off centre (what A/D move)
 *   windex     shortly after the first look around (wind direction)
 *   telltales  when the boat is moving and the sail goes soft (the luff starts to flutter, the HUD's
 *              "soft") for a moment, or the player first trims the sail (W/S or wheel), so they see
 *              what the trim did. Not when stopped head to wind: then everything flogs and the Windex
 *              is the answer.
 * Reads only the camera and the boat's look targets; it never changes the sim.
 */
import * as THREE from 'three';
import type { LookTargets } from '../render/boatMesh';
import { savePrefs, type Prefs } from './prefs';

type GuideId = keyof LookTargets;
// Steering comes first: it answers "why did it turn that way?" while the boat is still turning, and
// it may interrupt a waiting wind guide. The wind comes before the trim.
const PRIORITY: readonly GuideId[] = ['tiller', 'windex', 'telltales'];
/** One plain word under the ring or chevron: what the part is for, never what it currently says. */
const LABELS: Record<GuideId, string> = { tiller: 'tiller', windex: 'wind', telltales: 'sail trim' };

const WINDEX_DELAY = 6; // s of looking around before the first guide, so the player explores first; TUNING GUESS
const SOFT_SECONDS = 2; // s of a soft sail before the telltales guide, so a passing gust does not trigger it; TUNING GUESS
const SOFT_LEVEL = 0.05; // luffAmount at which the luff starts to flutter (the HUD's "soft")
const SHEET_MOVED = 0.08; // trim travel counted as a deliberate trim (about 0.2 s of W/S, or 3 wheel notches); TUNING GUESS
const MOVING_SPEED = 0.8; // m/s (about 1.5 kn): slower than this the sail is not a trim question
const TILLER_MOVED = 0.3; // tiller fraction counted as deliberate steering (the spawn helm is -0.06); TUNING GUESS
// s with the ring on screen to complete a guide; long enough that a ring which merely flashed past the
// edge of attention is not marked seen. TUNING GUESS
const HOLD_SECONDS = 2;
// A guide the player keeps ignoring steps back for a while instead of nagging; it returns later.
const PATIENCE_SECONDS = 30;
const SNOOZE_SECONDS = 60;
// The ring takes over from the chevron well inside the screen and hands back only near the edge, so
// a target near the edge of a rocking view does not flicker between the two.
const RING_ENTER_NDC = 0.8;
const RING_EXIT_NDC = 0.95;
const GAP_SECONDS = 1.5; // s between one guide finishing and the next appearing
// Chevron distance from the centre as a fraction of the viewport; less vertically, so a chevron
// pointing down stays above the lap chart at the bottom of the view.
const EDGE_FRAC_X = 0.4;
const EDGE_FRAC_Y = 0.32;
const RING_PX = 46;
const CHEVRON_PX = 40;

const STYLE = `
@keyframes lg-pulse{0%,100%{opacity:0.35}50%{opacity:1}}
.lg-click{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);display:none;flex-direction:column;align-items:center;gap:10px;
  pointer-events:none;user-select:none;z-index:6;color:rgba(255,255,255,0.9);
  font:500 12px system-ui,-apple-system,'Segoe UI',sans-serif;letter-spacing:0.04em;filter:drop-shadow(0 0 3px rgba(0,0,0,0.5));}
.lg-click .lg-button{animation:lg-pulse 1.4s ease-in-out infinite;}
.lg-mark{position:fixed;left:0;top:0;pointer-events:none;z-index:6;opacity:0;filter:drop-shadow(0 0 3px rgba(0,20,30,0.9));}
.lg-mark.lg-fade{transition:opacity 0.6s;}
.lg-ring{width:${RING_PX}px;height:${RING_PX}px;border:2px solid rgba(255,255,255,0.9);border-radius:50%;box-sizing:border-box;
  transform:translate(-50%,-50%);box-shadow:0 0 0 1.5px rgba(0,20,30,0.45);}
.lg-chevron{transform:translate(-50%,-50%);}
.lg-label{position:absolute;left:0;top:${RING_PX / 2 + 6}px;transform:translateX(-50%);white-space:nowrap;
  color:rgba(255,255,255,0.9);font:500 12px system-ui,-apple-system,'Segoe UI',sans-serif;letter-spacing:0.04em;}
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
  /** Boat speed through the water, m/s. */
  speed: number;
  luffAmount: number;
  /** ControlInput.trimTravel: running total of the player's own sheet trimming. */
  trimTravel: number;
}

export class LookGuide {
  private readonly click = document.createElement('div');
  private readonly chevron = document.createElement('div');
  /** The arrow inside the chevron mark: it rotates toward the target while the label stays upright. */
  private readonly chevronArrow: HTMLElement;
  private readonly ring = document.createElement('div');
  private readonly seen: Set<string>;
  /** Guides that have become relevant and wait their turn (shown in PRIORITY order). */
  private readonly wanted = new Set<GuideId>();
  private current: GuideId | null = null;
  private held = 0;
  /** s the current guide has been offered while the player was looking. */
  private shown = 0;
  /** Guide clock (s while running) and when each ignored guide may come back. */
  private clock = 0;
  private readonly snoozedUntil: Partial<Record<GuideId, number>> = {};
  private lookedAround = 0;
  private soft = 0;
  /** Player trim travel made while moving, and ControlInput's running total last frame. */
  private sheetTravel = 0;
  private lastTrimTravel: number | null = null;
  private gap = 0;
  /** What is on screen for the current guide; the ring/chevron hysteresis depends on it. */
  private mode: 'ring' | 'chevron' | null = null;
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
    this.chevron.innerHTML = `<div class="lg-chevron">${CHEVRON_SVG}</div><div class="lg-label"></div>`;
    this.chevronArrow = this.chevron.firstElementChild as HTMLElement;
    this.ring.className = 'lg-mark';
    this.ring.innerHTML = '<div class="lg-ring"></div><div class="lg-label"></div>';
    document.body.append(this.click, this.chevron, this.ring);
  }

  /** Forgets every completed guide, so they appear again as they become relevant. */
  reset(): void {
    this.seen.clear();
    this.wanted.clear();
    this.current = null;
    this.held = this.shown = this.lookedAround = this.soft = this.gap = 0;
    this.sheetTravel = 0;
    this.lastTrimTravel = null;
    for (const id of PRIORITY) delete this.snoozedUntil[id];
    this.prefs.guidesSeen = [];
    savePrefs(this.prefs);
  }

  update(input: GuideInput, menuOpen: boolean): void {
    this.click.style.display = !input.looking && !menuOpen ? 'flex' : 'none';
    this.clock += input.dt;

    // Triggers: each guide becomes relevant once, unless already completed.
    if (input.looking) {
      this.lookedAround += input.dt;
      if (this.lookedAround >= WINDEX_DELAY) this.want('windex');
    }
    if (Math.abs(input.tiller) >= TILLER_MOVED) this.want('tiller');
    // Only the player's own W/S or wheel trimming counts (ControlInput.trimTravel); a respawn putting
    // the sheet back is not a trim.
    const trimmed = this.lastTrimTravel === null ? 0 : input.trimTravel - this.lastTrimTravel;
    this.lastTrimTravel = input.trimTravel;
    const moving = input.speed >= MOVING_SPEED;
    if (moving) this.sheetTravel += trimmed;
    if (this.sheetTravel >= SHEET_MOVED) this.want('telltales');
    this.soft = moving && input.luffAmount >= SOFT_LEVEL ? this.soft + input.dt : 0;
    if (this.soft >= SOFT_SECONDS) this.want('telltales');

    // Telltales only make sense while the boat moves: stopped, a waiting or showing trim guide defers.
    // An ignored guide sits out its snooze.
    const relevant = (id: GuideId): boolean => (id !== 'telltales' || moving) && this.clock >= (this.snoozedUntil[id] ?? 0);
    const next = PRIORITY.find((id) => this.wanted.has(id) && relevant(id));
    const outranked = this.current !== null && next !== undefined && PRIORITY.indexOf(next) < PRIORITY.indexOf(this.current);
    if (this.current && (!relevant(this.current) || outranked)) {
      this.wanted.add(this.current);
      this.current = null;
    }
    const active = input.looking && !input.busy;
    if (!this.current) {
      this.gap = Math.max(this.gap - input.dt, 0);
      if (active && this.gap === 0 && next) {
        this.wanted.delete(next);
        this.current = next;
        this.held = this.shown = 0;
        for (const label of document.querySelectorAll<HTMLElement>('.lg-label')) label.textContent = LABELS[next];
      }
    } else if (active) {
      this.shown += input.dt;
      if (this.shown >= PATIENCE_SECONDS) {
        this.snoozedUntil[this.current] = this.clock + SNOOZE_SECONDS;
        this.wanted.add(this.current);
        this.current = null;
      }
    }
    if (this.current && active) this.track(this.current, input);
    else this.place(null, 0, 0, 0);
  }

  private want(id: GuideId): void {
    if (!this.seen.has(id) && this.current !== id) this.wanted.add(id);
  }

  private track(id: GuideId, input: GuideInput): void {
    const camera = input.camera;
    this.targets[id].getWorldPosition(this.world);
    this.cam.copy(this.world).applyMatrix4(camera.matrixWorldInverse);
    const inFront = this.cam.z < 0;
    const ndc = this.world.project(camera);
    const w = window.innerWidth;
    const h = window.innerHeight;

    if (this.mode === 'ring') this.held += input.dt;
    if (this.held >= HOLD_SECONDS) {
      this.seen.add(id);
      this.prefs.guidesSeen = [...this.seen];
      savePrefs(this.prefs);
      this.current = null;
      this.gap = GAP_SECONDS;
      this.place(null, 0, 0, 0);
      return;
    }

    const edge = this.mode === 'ring' ? RING_EXIT_NDC : RING_ENTER_NDC;
    if (inFront && Math.abs(ndc.x) < edge && Math.abs(ndc.y) < edge) {
      this.place('ring', ((ndc.x + 1) / 2) * w, ((1 - ndc.y) / 2) * h, 0);
      return;
    }
    // Off screen or behind: point from the middle toward the target's direction in the view plane.
    // A target straight behind has no direction on screen, so it is pointed at from below.
    const dx = this.cam.x;
    let dy = this.cam.y;
    if (Math.hypot(dx, dy) < 1e-3) dy = -1;
    const angle = Math.atan2(-dy, dx);
    this.place('chevron', w / 2 + Math.cos(angle) * w * EDGE_FRAC_X, h / 2 + Math.sin(angle) * h * EDGE_FRAC_Y, angle);
  }

  /** Shows the ring or the chevron, swapping instantly; hiding both fades them out. */
  private place(which: 'ring' | 'chevron' | null, x: number, y: number, angle: number): void {
    this.mode = which;
    for (const [el, kind] of [[this.ring, 'ring'], [this.chevron, 'chevron']] as const) {
      el.classList.toggle('lg-fade', which === null);
      el.style.opacity = which === kind ? '1' : '0';
    }
    if (which === 'ring') this.ring.style.transform = `translate(${x}px, ${y}px)`;
    if (which === 'chevron') {
      this.chevron.style.transform = `translate(${x}px, ${y}px)`;
      this.chevronArrow.style.transform = `translate(-50%, -50%) rotate(${angle}rad)`;
    }
  }
}
