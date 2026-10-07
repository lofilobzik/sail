import { beforeAll, describe, expect, it, vi } from 'vitest';
import { FlyCamera } from './flyCamera';

/** A window stand-in that lets a test press and release keys. */
function rig(): { fly: FlyCamera; down: (code: string) => void; up: (code: string) => void } {
  const handlers = new Map<string, (e: never) => void>();
  const target = { addEventListener: (type: string, h: (e: never) => void) => handlers.set(type, h) } as unknown as Pick<Window, 'addEventListener'>;
  const fly = new FlyCamera(target);
  fly.x = fly.z = 0;
  fly.y = 10;
  const event = (code: string) => ({ code, target: null }) as never;
  return { fly, down: (c) => handlers.get('keydown')!(event(c)), up: (c) => handlers.get('keyup')!(event(c)) };
}

describe('FlyCamera', () => {
  // isTypingTarget names DOM classes the node test environment lacks.
  beforeAll(() => {
    for (const name of ['HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement']) vi.stubGlobal(name, class {});
  });

  it('flies north (-z) at yaw 0 and west (-x) after turning left a quarter turn', () => {
    const { fly, down } = rig();
    down('KeyW');
    fly.update(1, 0, 0);
    expect(fly.x).toBeCloseTo(0, 9);
    expect(fly.z).toBeLessThan(-29);
    fly.x = fly.z = 0;
    fly.update(1, Math.PI / 2, 0);
    expect(fly.x).toBeLessThan(-29);
    expect(fly.z).toBeCloseTo(0, 6);
  });

  it('strafes right with D, climbs with E, sinks with Q, and follows the pitch when flying forward', () => {
    const { fly, down, up } = rig();
    down('KeyD');
    fly.update(1, 0, 0);
    expect(fly.x).toBeGreaterThan(29);
    up('KeyD');
    fly.x = 0;
    down('KeyE');
    fly.update(1, 0, 0);
    expect(fly.y).toBeCloseTo(40, 6);
    up('KeyE');
    down('KeyQ');
    fly.update(1, 0, 0);
    expect(fly.y).toBeCloseTo(10, 6);
    up('KeyQ');
    down('KeyW');
    fly.update(1, 0, Math.PI / 4);
    expect(fly.y).toBeGreaterThan(10 + 20);
  });

  it('flies faster with Shift and stops when keys are released', () => {
    const { fly, down, up } = rig();
    down('KeyW');
    down('ShiftLeft');
    fly.update(1, 0, 0);
    expect(fly.z).toBeLessThan(-150);
    up('KeyW');
    const z = fly.z;
    fly.update(1, 0, 0);
    expect(fly.z).toBe(z);
  });
});
