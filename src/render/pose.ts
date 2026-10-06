/** Blends the last two simulation states into the pose drawn this frame. */
import type { BoatModel } from '../sim/boat';
import { DEG, wrapPi } from '../sim/frames';
import type { Diagnostics } from '../sim/step';
import type { BoatState } from '../sim/state';
import type { RenderPose } from './scene';

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * `alpha` is how far the frame lies from `prev` toward `curr`. Controls and diagnostics come from the
 * latest step; `dt` is the real frame time and `look` the sailor's head direction, rad.
 */
export function interpolatePose(
  prev: BoatState,
  curr: BoatState,
  alpha: number,
  diagnostics: Diagnostics,
  boat: BoatModel,
  dt: number,
  look: { yaw: number; pitch: number },
): RenderPose {
  const c = diagnostics.controls;
  return {
    t: lerp(prev.t, curr.t, alpha),
    x: lerp(prev.x, curr.x, alpha),
    z: lerp(prev.z, curr.z, alpha),
    heading: prev.heading + wrapPi(curr.heading - prev.heading) * alpha,
    surge: lerp(prev.u, curr.u, alpha),
    heel: lerp(prev.heel, curr.heel, alpha),
    pitch: lerp(prev.pitch, curr.pitch, alpha),
    boom: lerp(prev.boom, curr.boom, alpha),
    crewY: lerp(prev.crewY, curr.crewY, alpha),
    rudderAngle: c.tiller * boat.cfg.rudder.maxAngleDeg * DEG,
    sheet: c.sheet,
    apparentU: diagnostics.apparent.u,
    apparentV: diagnostics.apparent.v,
    luffAmount: diagnostics.sail?.luffAmount ?? 0,
    stallAmount: diagnostics.sail?.stallAmount ?? 0,
    dt,
    lookYaw: look.yaw,
    lookPitch: look.pitch,
  };
}
