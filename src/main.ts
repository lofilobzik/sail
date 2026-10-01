/** Entry: fixed-step sim loop + interpolated rendering. render/ and debug/ only read sim state. */
import { DebugOverlay } from './debug/overlay';
import { ControlInput } from './input/controls';
import { MouseLook } from './input/mouseLook';
import { SceneView } from './render/scene';
import { ForceVectors } from './render/vectors';
import { DEG, FixedStep, buildBoat, defaultConfig, evaluate, initialState, step, wrapPi, type BoatState, type Diagnostics } from './sim';

const START_HEADING_DEG = 90; // TUNING GUESS: beam reach for the default wind from 0°
const START_SPEED = 1; // TUNING GUESS: initial boat speed, m/s

const boat = buildBoat();
const cfg = defaultConfig();
const fixed = new FixedStep(cfg.dt);

const view = new SceneView(boat);
const input = new ControlInput(view.renderer.domElement);
const look = new MouseLook(view.renderer.domElement);
const vectors = new ForceVectors(boat, view.scene, view.boat.yaw, view.boat.heel);

let prev: BoatState;
let curr: BoatState;
let diagnostics: Diagnostics;

function resetBoat(): void {
  curr = prev = initialState(START_HEADING_DEG * DEG, START_SPEED);
  input.reset();
  diagnostics = evaluate(curr, input.update(0), boat, cfg);
}
resetBoat();

const overlay = new DebugOverlay(cfg, resetBoat);

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

let last = performance.now();
function frame(now: number): void {
  const frameSeconds = (now - last) / 1000;
  last = now;

  const steps = fixed.advance(frameSeconds);
  for (let i = 0; i < steps; i++) {
    const result = step(curr, input.update(cfg.dt), boat, cfg);
    prev = curr;
    curr = result.state;
    diagnostics = result.diagnostics;
  }

  const a = fixed.alpha;
  const x = lerp(prev.x, curr.x, a);
  const z = lerp(prev.z, curr.z, a);
  view.render({
    x,
    z,
    heading: prev.heading + wrapPi(curr.heading - prev.heading) * a,
    heel: lerp(prev.heel, curr.heel, a),
    boom: lerp(prev.boom, curr.boom, a),
    crewY: lerp(prev.crewY, curr.crewY, a),
    lookYaw: look.yaw,
    lookPitch: look.pitch,
  });

  if (overlay.visible) vectors.update(diagnostics, x, z, overlay.arrows);
  else vectors.hideAll();
  overlay.update(diagnostics, curr);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
