/** Pointer-lock mouse look: yaw/pitch relative to the boat. Click the canvas to lock, Esc releases. */
const SENSITIVITY = 0.0025; // TUNING GUESS: rad per pixel of mouse movement
const MAX_PITCH = (80 * Math.PI) / 180; // TUNING GUESS: pitch clamp +-80 deg

export class MouseLook {
  /** Rad, + = look left (Three.js rotation about up). Unrestricted. */
  yaw = 0;
  /** Rad, + = look up. */
  pitch = 0;
  /** The player's look speed (Esc menu); multiplies the sensitivity. */
  playerSensitivity = 1;
  /** Multiplier on the sensitivity; the binoculars set 1/zoom so a magnified view turns as slowly as it looks. */
  sensitivityScale = 1;

  constructor(private readonly canvas: HTMLElement) {
    canvas.addEventListener('click', () => requestLook(canvas));
    document.addEventListener('pointermove', (e) => {
      if (document.pointerLockElement !== this.canvas) return;
      // Safari sends one move per frame whose movementX/Y carry only the last of the moves it bundled
      // (WebKit bug 235116), several times too little; the coalesced events hold all of them. Chrome
      // and Firefox report the same total either way.
      const moves = e.getCoalescedEvents?.() ?? [];
      let dx = 0;
      let dy = 0;
      if (moves.length > 0) {
        for (const m of moves) {
          dx += m.movementX;
          dy += m.movementY;
        }
      } else {
        dx = e.movementX;
        dy = e.movementY;
      }
      const s = SENSITIVITY * this.playerSensitivity * this.sensitivityScale;
      this.yaw -= dx * s;
      this.pitch = Math.min(MAX_PITCH, Math.max(-MAX_PITCH, this.pitch - dy * s));
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
