/**
 * Hold F: take a reading. Where you look decides which: looking astern at the wake (no mark under
 * the crosshair) judges speed, anything else raises the hand-bearing compass for a bearing.
 * R: reckon, i.e. plot on the chart. The mouse is only for looking around and the debug panel.
 */
import { isTypingTarget } from './controls';

export class NavigationInput {
  private readHeld = false;
  private reckonKey = false;

  constructor(private readonly cockpit: () => boolean) {
    window.addEventListener('keydown', (e) => {
      if (isTypingTarget(e.target)) return;
      if (e.code === 'KeyR' && !e.repeat) this.reckonKey = true;
      else if (e.code === 'KeyF') this.readHeld = true;
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'KeyF') this.readHeld = false;
    });
    window.addEventListener('blur', () => this.cancel());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.cancel(); });
  }

  /** The reading key is down in the cockpit. */
  get held(): boolean {
    return this.readHeld && this.cockpit();
  }

  /** Whether R was pressed since the last call. */
  takeReckon(): boolean {
    const pressed = this.reckonKey;
    this.reckonKey = false;
    return pressed;
  }

  cancel(): void {
    this.readHeld = false;
  }
}
