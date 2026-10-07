/**
 * Debug free-fly camera (G): WASD fly along the view direction, E up, Q down, Shift fast. The mouse
 * look is the normal pointer-locked one. Position is logical world metres (x east, z south, y up).
 */
import { isTypingTarget } from './controls';

const SPEED = 30; // m/s, TUNING GUESS: crossing the bay in a minute or two
const FAST = 6; // Shift multiplier

export class FlyCamera {
  x = 0;
  y = 3;
  z = 0;
  private readonly held = new Set<string>();

  constructor(target: Pick<Window, 'addEventListener'> = window) {
    target.addEventListener('keydown', (e) => {
      if (!isTypingTarget(e.target)) this.held.add(e.code);
    });
    target.addEventListener('keyup', (e) => this.held.delete(e.code));
    target.addEventListener('blur', () => this.held.clear());
  }

  /** Moves for `dt` seconds along the view given by `yaw` (+ = left, rad) and `pitch` (+ = up, rad). */
  update(dt: number, yaw: number, pitch: number): void {
    const key = (code: string): number => (this.held.has(code) ? 1 : 0);
    const forward = key('KeyW') - key('KeyS');
    const right = key('KeyD') - key('KeyA');
    const up = key('KeyE') - key('KeyQ');
    const step = SPEED * (this.held.has('ShiftLeft') || this.held.has('ShiftRight') ? FAST : 1) * dt;
    const cosPitch = Math.cos(pitch);
    // Render-local axes: the view looks down -z at yaw 0 and a positive yaw turns it toward -x.
    this.x += step * (forward * -Math.sin(yaw) * cosPitch + right * Math.cos(yaw));
    this.y += step * (forward * Math.sin(pitch) + up);
    this.z += step * (forward * -Math.cos(yaw) * cosPitch - right * Math.sin(yaw));
  }
}
