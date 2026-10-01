/**
 * Keyboard + wheel -> normalized, rate-limited Controls (DESIGN.md Controls).
 *   A / D        tiller toward port (-1) / starboard (+1), holds when released
 *   C            centre the tiller (same rate)
 *   W / S, wheel sheet in (toward 0) / ease (toward 1), holds when released
 *   Shift (hold) hike out, release to sit in
 */
import { clamp, type Controls } from '../sim';
import { rateLimit } from './rateLimit';

const TILLER_RATE = 2.0; // TUNING GUESS: tiller travel per second while A/D held
const SHEET_RATE = 0.4; // TUNING GUESS: sheet travel per second while W/S held (and follow rate)
const SHEET_WHEEL_STEP = 0.03; // TUNING GUESS: sheet target change per wheel notch
const HIKE_RATE = 1.5; // TUNING GUESS: hike travel per second
const INITIAL_SHEET = 0.5;

/** True when a key event comes from a form field (overlay inputs must not drive the boat). */
export function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

export class ControlInput {
  private readonly down = new Set<string>();
  private tiller = 0;
  private sheet = INITIAL_SHEET;
  private sheetTarget = INITIAL_SHEET;
  private hike = 0;

  constructor(wheelTarget: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (isTypingTarget(e.target)) return;
      this.down.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
    wheelTarget.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (e.deltaY === 0) return;
        // Wheel down (toward the user) eases, wheel up sheets in.
        this.sheetTarget = clamp(this.sheetTarget + Math.sign(e.deltaY) * SHEET_WHEEL_STEP, 0, 1);
      },
      { passive: false },
    );
  }

  reset(): void {
    this.tiller = 0;
    this.sheet = this.sheetTarget = INITIAL_SHEET;
    this.hike = 0;
  }

  update(dt: number): Controls {
    const k = this.down;
    const left = k.has('KeyA');
    const right = k.has('KeyD');
    if (left !== right) this.tiller = rateLimit(this.tiller, right ? 1 : -1, TILLER_RATE, dt);
    else if (k.has('KeyC')) this.tiller = rateLimit(this.tiller, 0, TILLER_RATE, dt);

    const sheetIn = k.has('KeyW');
    const ease = k.has('KeyS');
    if (sheetIn !== ease) this.sheetTarget = rateLimit(this.sheetTarget, ease ? 1 : 0, SHEET_RATE, dt);
    this.sheet = rateLimit(this.sheet, this.sheetTarget, SHEET_RATE, dt);

    const hiking = k.has('ShiftLeft') || k.has('ShiftRight');
    this.hike = rateLimit(this.hike, hiking ? 1 : 0, HIKE_RATE, dt);

    return { tiller: this.tiller, sheet: this.sheet, hike: this.hike };
  }
}
