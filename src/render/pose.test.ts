import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Physics } from '../physics/bridge';
import { loadPhysics } from '../physics/load';
import { buildBoat, DEG, NEUTRAL_CONTROLS } from '../sim';
import { interpolatePose } from './pose';

describe('render-pose reconciliation offset', () => {
  let physics: Physics;
  beforeAll(async () => {
    physics = await loadPhysics(await readFile(new URL('../../public/wasm/sim.wasm', import.meta.url)));
    physics.setConfig(physics.browserConfig(1));
  });

  it('offsets only the drawn position and heading without changing the simulation timeline', () => {
    const prev = { ...physics.mooredAt(0, 0), x: 10, z: 20, heading: 179 * DEG };
    const curr = { ...prev, x: 14, z: 28, heading: -179 * DEG, t: 1 };
    const savedPrev = { ...prev };
    const savedCurr = { ...curr };
    const diagnostics = physics.evaluate(curr, NEUTRAL_CONTROLS);
    const pose = interpolatePose(prev, curr, 0.5, diagnostics, buildBoat(), 1 / 60, { yaw: 0, pitch: 0 },
      { dx: 1, dz: -2, dHeading: 0.1 });
    expect(pose.x).toBe(13);
    expect(pose.z).toBe(22);
    expect(pose.heading).toBeCloseTo(Math.PI + 0.1, 14);
    expect(pose.t).toBe(0.5);
    expect(pose.moored).toBe(true);
    expect(prev).toEqual(savedPrev);
    expect(curr).toEqual(savedCurr);
  });
});
