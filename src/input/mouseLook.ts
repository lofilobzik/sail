/** Pointer-lock mouse look: yaw/pitch relative to the boat. Click the canvas to lock, Esc releases. */
const SENSITIVITY = 0.0025; // TUNING GUESS: rad per pixel of mouse movement
const MAX_PITCH = (80 * Math.PI) / 180; // TUNING GUESS: pitch clamp +-80 deg

export class MouseLook {
  /** Rad, + = look left (Three.js rotation about up). Unrestricted. */
  yaw = 0;
  /** Rad, + = look up. */
  pitch = 0;
  /** Multiplier on the sensitivity; the binoculars set 1/zoom so a magnified view turns as slowly as it looks. */
  sensitivityScale = 1;

  constructor(private readonly canvas: HTMLElement) {
    canvas.addEventListener('click', () => requestLook(canvas));
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== this.canvas) return;
      const s = SENSITIVITY * this.sensitivityScale;
      this.yaw -= e.movementX * s;
      this.pitch = Math.min(MAX_PITCH, Math.max(-MAX_PITCH, this.pitch - e.movementY * s));
    });
  }
}

/** Captures the mouse for looking around. A refused request (browser cooldown after Esc) is harmless. */
export function requestLook(canvas: HTMLElement): void {
  if (document.pointerLockElement === canvas) return;
  try {
    const p = canvas.requestPointerLock() as unknown;
    if (p instanceof Promise) p.catch(() => {});
  } catch {
    // Older browsers throw synchronously; the next click tries again.
  }
}
