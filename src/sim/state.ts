import type { BoatState, Controls } from '../physics/types';

export function initialState(heading = 0, speed = 0): BoatState {
  return {
    t: 0,
    x: 0,
    z: 0,
    heading,
    u: speed,
    v: 0,
    r: 0,
    heel: 0,
    p: 0,
    pitch: 0,
    pitchRate: 0,
    boom: 0,
    boomSide: 1,
    crewY: 0,
    moored: false,
  };
}

export const NEUTRAL_CONTROLS: Readonly<Controls> = { tiller: 0, sheet: 0.5, hike: 0 };
