/** B: hold sighting compass. M: interact with the physical chart, without moving camera or chart. */
import { isTypingTarget } from './controls';
import type { PaperPoint } from '../nav/chart';

export interface NavigationActions {
  cockpit(): boolean;
  chartMode(active: boolean): void;
  record(): void;
  pick(x: number, y: number): PaperPoint | null;
  down(point: PaperPoint): void;
  move(point: PaperPoint): void;
  up(point: PaperPoint | null): void;
  zoom(point: PaperPoint, direction: number): void;
}

export class NavigationInput {
  chartInteraction = false;
  private bearingHeld = false;

  constructor(private readonly canvas: HTMLElement, private readonly actions: NavigationActions) {
    window.addEventListener('keydown', (e) => {
      if (isTypingTarget(e.target)) return;
      if (e.code === 'KeyM' && !e.repeat && actions.cockpit()) {
        e.preventDefault();
        this.setChartMode(!this.chartInteraction);
        if (this.chartInteraction) document.exitPointerLock();
        else void canvas.requestPointerLock()?.catch(() => undefined);
      } else if (e.code === 'Escape' && this.chartInteraction) {
        this.setChartMode(false);
      } else if (e.code === 'KeyB' && !this.chartInteraction) this.bearingHeld = true;
    });
    window.addEventListener('keyup', (e) => { if (e.code === 'KeyB') this.bearingHeld = false; });
    window.addEventListener('blur', () => this.cancel());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.cancel(); });
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement !== canvas) this.bearingHeld = false;
    });
    canvas.addEventListener('click', () => { if (this.sighting) actions.record(); });
    canvas.addEventListener('pointerdown', (e) => {
      if (!this.chartInteraction || e.button !== 0) return;
      const point = actions.pick(e.clientX, e.clientY);
      if (!point) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      actions.down(point);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.chartInteraction) return;
      const point = actions.pick(e.clientX, e.clientY);
      if (point) actions.move(point);
    });
    canvas.addEventListener('pointerup', (e) => {
      if (this.chartInteraction) actions.up(actions.pick(e.clientX, e.clientY));
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointercancel', () => actions.up(null));
    canvas.addEventListener('wheel', (e) => {
      if (!this.chartInteraction) return;
      e.preventDefault();
      const point = actions.pick(e.clientX, e.clientY);
      if (point && e.deltaY !== 0) actions.zoom(point, Math.sign(e.deltaY));
    }, { passive: false });
  }

  get sighting(): boolean {
    return this.bearingHeld && !this.chartInteraction && this.actions.cockpit() && document.pointerLockElement === this.canvas;
  }

  private setChartMode(active: boolean): void {
    this.chartInteraction = active;
    this.bearingHeld = false;
    this.canvas.style.cursor = active ? 'pointer' : '';
    this.actions.chartMode(active);
  }

  cancel(): void {
    this.bearingHeld = false;
    if (this.chartInteraction) this.setChartMode(false);
  }
}
