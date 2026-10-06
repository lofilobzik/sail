import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlInput } from './controls';

type Listener = (e: Record<string, unknown>) => void;

describe('ControlInput trim travel', () => {
  let keys: Record<string, Listener>;
  let wheel: Listener;
  let input: ControlInput;
  const press = (code: string) => keys.keydown!({ code, target: null });
  const release = (code: string) => keys.keyup!({ code, target: null });
  const run = (seconds: number, fps: number) => {
    for (let i = 0; i < Math.round(seconds * fps); i++) input.update(1 / fps);
  };

  beforeEach(() => {
    keys = {};
    vi.stubGlobal('window', { addEventListener: (type: string, fn: Listener) => { keys[type] = fn; } });
    for (const name of ['HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement']) vi.stubGlobal(name, class {});
    input = new ControlInput({ addEventListener: (_: string, fn: Listener) => { wheel = fn; } } as unknown as HTMLElement);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('counts W/S trimming the same at any frame rate', () => {
    for (const fps of [60, 20]) {
      input = new ControlInput({ addEventListener: (_: string, fn: Listener) => { wheel = fn; } } as unknown as HTMLElement);
      press('KeyW');
      run(0.5, fps);
      release('KeyW');
      expect(input.trimTravel).toBeCloseTo(0.2, 6); // 0.4 per second for 0.5 s
    }
  });

  it('counts wheel notches, but not notches past the end of the sheet', () => {
    for (let i = 0; i < 3; i++) wheel({ deltaY: -1, preventDefault() {} });
    expect(input.trimTravel).toBeCloseTo(0.09, 9);
    press('KeyS');
    run(2, 60); // sheeted hard in: target at 0
    release('KeyS');
    const atLimit = input.trimTravel;
    wheel({ deltaY: -1, preventDefault() {} });
    expect(input.trimTravel).toBe(atLimit);
  });

  it('does not count respawns putting the sheet back', () => {
    press('KeyW');
    run(1, 60);
    release('KeyW');
    const trimmed = input.trimTravel;
    for (let i = 0; i < 20; i++) {
      input.reset();
      run(0.2, 60);
    }
    expect(input.trimTravel).toBe(trimmed);
  });
});
