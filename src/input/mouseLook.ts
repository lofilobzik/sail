/** Pointer-lock mouse look: yaw/pitch relative to the boat. Click the canvas to lock, Esc releases. */
const SENSITIVITY = 0.0025; // TUNING GUESS: rad per pixel of mouse movement
const MAX_PITCH = (80 * Math.PI) / 180; // TUNING GUESS: pitch clamp +-80 deg

export class MouseLook {
  /** Rad, + = look left (Three.js rotation about up). Unrestricted. */
  yaw = 0;
  /** Rad, + = look up. */
  pitch = 0;
  /** Chart interaction releases the pointer; clicking the paper must not lock it again. */
  enabled = true;

  constructor(private readonly canvas: HTMLElement) {
    canvas.addEventListener('click', () => {
      if (this.enabled && document.pointerLockElement !== canvas) void canvas.requestPointerLock();
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.enabled || document.pointerLockElement !== this.canvas) return;
      this.yaw -= e.movementX * SENSITIVITY;
      this.pitch = Math.min(MAX_PITCH, Math.max(-MAX_PITCH, this.pitch - e.movementY * SENSITIVITY));
    });
  }
}
