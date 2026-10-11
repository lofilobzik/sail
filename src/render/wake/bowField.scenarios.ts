/**
 * Replayable bow-field scenarios with a recorded reference (bowField.golden.json, sampled from the
 * original CPU rasterizer on a 33 x 33 grid at 1 m spacing spanning +-16 m around each scenario's
 * last center; the fronts are narrow, so a coarser grid would miss most of them).
 */
import type { BowEmitter } from './bowField';
import { WAKE } from './kelvin';

export interface BowScenario {
  name: string;
  steps: { emitter: BowEmitter; center: { x: number; z: number } }[];
}

const BASE = { height: 0.04, speed: 2, foam: 0.8 };
const DRY = { height: 0 };
const ORIGIN = { x: 0, z: 0 };

function isolated(dx: number, dz: number, name: string): BowScenario {
  const at = { x: dx, z: dz };
  return {
    name,
    steps: [0, 0.5, 1, 3].map((time) => ({ emitter: { ...BASE, ...at, time, ...(time > 0 ? DRY : {}) }, center: at })),
  };
}

function moving(name: string, speed: number, seconds: number): BowScenario {
  const steps: BowScenario['steps'] = [];
  for (let frame = 0; frame <= seconds * 60; frame++) {
    const time = frame / 60;
    const at = { x: speed * time, z: 0 };
    steps.push({ emitter: { ...BASE, speed, ...at, time }, center: at });
  }
  return { name, steps };
}

const edgeX = -WAKE.bowFieldSize / 2 + WAKE.bowOffset + 0.5;

export const BOW_SCENARIOS: BowScenario[] = [
  isolated(0, 0, 'isolated'),
  moving('moving', 2, 2),
  moving('slow-overlap', WAKE.minSpeed + 0.01, 4),
  {
    name: 'edge',
    steps: [
      { emitter: { ...BASE, x: edgeX, z: 0, time: 0 }, center: ORIGIN },
      { emitter: { ...BASE, ...DRY, x: edgeX, z: 0, time: 2 }, center: ORIGIN },
    ],
  },
  isolated(1e9, -3e8, 'distant'),
];

/** The 33 x 33 reference grid around `center`, row-major (z outer, x inner). */
export function scenarioGrid(center: { x: number; z: number }): [number, number][] {
  const points: [number, number][] = [];
  for (let j = 0; j < 33; j++) {
    for (let i = 0; i < 33; i++) points.push([center.x - 16 + i, center.z - 16 + j]);
  }
  return points;
}
