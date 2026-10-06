/**
 * Keyboard + wheel -> normalized, rate-limited Controls (DESIGN.md Controls).
 *   A / D        tiller toward port (-1) / starboard (+1), holds when released
 *   C            centre the tiller (same rate)
 *   W / S        ease (toward 1) / sheet in (toward 0), holds when released
 *   Wheel        up sheets in, down eases
 *   Shift (hold) hike out, release to sit in
 */
import { clamp, type Controls } from '../sim';
import { rateLimit } from './rateLimit';

const TILLER_RATE = 2.0; // TUNING GUESS: tiller travel per second while A/D held
const SHEET_RATE = 0.4; // TUNING GUESS: sheet travel per second while W/S held (and follow rate)
const SHEET_WHEEL_STEP = 0.03; // TUNING GUESS: sheet target change per wheel notch
const HIKE_RATE = 1.5; // TUNING GUESS: hike travel per second
const INITIAL_SHEET = 0.25; // best trim on the default beam reach: polar sheet 0.25-0.27 at TWA 90, 6-9 kn (milestone 2)
// The Laser carries weather helm: hands off at tiller 0 the spawn reach rounds up into irons within
// about 40 s and then slides astern. A sailor already holds a little helm against it, so the tiller
// starts where it balances the spawn reach (headless sweep, 7 kn: -0.05 still rounds up, -0.06 holds
// 90 +/- 30 degrees for two minutes with gusts, -0.07 bears away). TUNING GUESS.
const INITIAL_TILLER = -0.06;

/** True when a key event comes from a form field (overlay inputs must not drive the boat). */
export function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

export class ControlInput {
  private readonly down = new Set<string>();
  private tiller = INITIAL_TILLER;
  private sheet = INITIAL_SHEET;
  private sheetTarget = INITIAL_SHEET;
  private hike = 0;
  /**
   * Total sheet-target travel the player has made with W/S or the wheel, ever. Resets and respawns
   * set the sheet directly and never add to it, so it measures deliberate trimming only.
   */
  get trimTravel(): number {
    return this.trimmed;
  }
  private trimmed = 0;

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
        const before = this.sheetTarget;
        this.sheetTarget = clamp(this.sheetTarget + Math.sign(e.deltaY) * SHEET_WHEEL_STEP, 0, 1);
        this.trimmed += Math.abs(this.sheetTarget - before);
      },
      { passive: false },
    );
  }

  reset(): void {
    this.tiller = INITIAL_TILLER;
    this.sheet = this.sheetTarget = INITIAL_SHEET;
    this.hike = 0;
  }

  update(dt: number): Controls {
    const k = this.down;
    const left = k.has('KeyA');
    const right = k.has('KeyD');
    if (left !== right) this.tiller = rateLimit(this.tiller, right ? 1 : -1, TILLER_RATE, dt);
    else if (k.has('KeyC')) this.tiller = rateLimit(this.tiller, 0, TILLER_RATE, dt);

    const sheetIn = k.has('KeyS');
    const ease = k.has('KeyW');
    if (sheetIn !== ease) {
      const before = this.sheetTarget;
      this.sheetTarget = rateLimit(this.sheetTarget, ease ? 1 : 0, SHEET_RATE, dt);
      this.trimmed += Math.abs(this.sheetTarget - before);
    }
    this.sheet = rateLimit(this.sheet, this.sheetTarget, SHEET_RATE, dt);

    const hiking = k.has('ShiftLeft') || k.has('ShiftRight');
    this.hike = rateLimit(this.hike, hiking ? 1 : 0, HIKE_RATE, dt);

    return { tiller: this.tiller, sheet: this.sheet, hike: this.hike };
  }
}
