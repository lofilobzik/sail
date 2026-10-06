/**
 * Hold F: take a reading. Where you look decides which: looking astern at the wake (no mark under
 * the crosshair) judges speed, anything else raises the hand-bearing compass for a bearing.
 * R: reckon, i.e. plot on the chart. The mouse is only for looking around and the debug panel.
 */
import type { Navigation, ReadingKind } from '../nav/navigation';
import type { NavigationView } from '../render/navigation';
import { isTypingTarget } from './controls';

export class NavigationInput {
  private readHeld = false;
  private reckonKey = false;
  private current: ReadingKind | null = null;

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

  /** The reading under way, fixed for the whole key press. */
  get reading(): ReadingKind | null {
    return this.current;
  }

  /**
   * Once per frame: F starts one reading when pressed, the wake if the sailor is looking astern with no
   * mark under the crosshair, otherwise a compass bearing (a mark astern is still a bearing). It is not
   * repeated until the key is released. R starts the auto-plot if the chart is in view.
   */
  update(navigation: Navigation, view: NavigationView, glassesUp: boolean): void {
    if (!this.held || glassesUp) {
      if (this.current) navigation.cancelReading();
      this.current = null;
    } else if (!this.current) {
      this.current = view.lookingAstern && !view.aimedMark ? 'speed' : 'bearing';
      navigation.beginReading(this.current);
    }
    const bearing = this.current === 'bearing';
    navigation.setAim(bearing ? view.bearing : null);
    navigation.setAimedMark(bearing ? view.aimedMark : null);
    navigation.setAimedBow(bearing && view.aimedBow);
    navigation.setAstern(view.lookingAstern);
    navigation.setLooking(view.chartInView);
    if (this.takeReckon()) {
      if (view.chartInView) navigation.beginAutoPlot();
      else navigation.message = 'Look down at the chart to reckon.';
    }
  }

  /** Whether R was pressed since the last call. */
  private takeReckon(): boolean {
    const pressed = this.reckonKey;
    this.reckonKey = false;
    return pressed;
  }

  cancel(): void {
    this.readHeld = false;
  }
}
