/** Hold B: raise the binoculars. The zoom itself eases in render/binoculars.ts. */
import { isTypingTarget } from './controls';

export class BinocularInput {
  private keyHeld = false;

  constructor(private readonly cockpit: () => boolean) {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyB' && !isTypingTarget(e.target)) this.keyHeld = true;
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'KeyB') this.keyHeld = false;
    });
    window.addEventListener('blur', () => this.cancel());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.cancel(); });
  }

  /** The key is down in the cockpit. */
  get held(): boolean {
    return this.keyHeld && this.cockpit();
  }

  cancel(): void {
    this.keyHeld = false;
  }
}
