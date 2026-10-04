import { describe, expect, it } from 'vitest';
import { buildBoat } from '../boat';
import { defaultConfig, withDisabledLayers } from '../config';
import { DEG, bodyToWorld } from '../frames';
import { initialState, type BoatState } from '../state';
import { step } from '../step';
import { terrainHeight } from '../terrain';

const boat = buildBoat();
const boardTip = boat.tc + boat.board.span;

describe('grounding in the bay', () => {
  // Heading held (yaw off) on a beam reach straight at the east shore of the bay.
  const cfg = { ...withDisabledLayers(defaultConfig(), ['yaw']), land: true };
  const drive = (s: BoatState, seconds: number, sheet: number): BoatState => {
    for (let i = 0; i < Math.round(seconds / cfg.dt); i++) s = step(s, { tiller: 0, sheet, hike: 0.5 }, boat, cfg).state;
    return s;
  };

  it('stops a boat sailing into the shallows within a few metres, afloat, and lets it slide off when eased', () => {
    let s: BoatState = { ...initialState(90 * DEG, 1.5), x: 1700, z: 0, boomSide: 1, crewY: -0.55 };
    let touch: number | null = null;
    let shallowest = Infinity;
    for (let i = 0; i < Math.round(150 / cfg.dt); i++) {
      s = step(s, { tiller: 0, sheet: 0.3, hike: 0.5 }, boat, cfg).state;
      const depth = -terrainHeight(s.x, s.z);
      shallowest = Math.min(shallowest, depth);
      if (touch === null && depth < boardTip) touch = s.x;
    }
    expect(touch).not.toBeNull();
    // The shore runs north-south here: the boat may slide along it, but no longer makes way east.
    expect(bodyToWorld(s.heading, s.u, s.v).x).toBeLessThan(0.05);
    expect(s.x - touch!).toBeLessThan(5);
    expect(shallowest).toBeGreaterThan(boat.tc); // the hull itself never reaches the beach

    const eased = drive(s, 30, 1);
    expect(-terrainHeight(eased.x, eased.z)).toBeGreaterThan(boardTip - 0.02);
  });
});
