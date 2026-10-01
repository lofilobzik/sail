/**
 * L6 Yaw dynamics (PHYSICS.md L6).
 *
 * Yaw moment balance: sail CE (L2) vs foil centres of pressure (L3) plus rudder,
 * as in Day 2017 section 3.3 (PDF pp6-7). This file adds the hull Munk moment and
 * the yaw inertia / damping.
 *
 * Munk moment, Day 2017 Eq. 14 (PDF p7), fitted from Eq. 13:
 *   N  = N0 (1 + 0.00966 phi_deg + 0.00134 phi_deg^2)
 *   N0 = 0.0002164 Delta - 0.014572        (Delta = displacement in kg)
 * [INFERENCE] N0 has the magnitude of the integral in Eq. 13 (int h^2 C dx, m^3),
 * so the moment applied is N = (pi/2) rho V^2 lambda * N0 (1 + ...). With small
 * leeway V^2 lambda ~ u v. The Munk moment is destabilizing: it turns the hull
 * further across the flow.
 *
 * Added inertia and linear yaw damping: TUNING GUESS (laser.json dynamics).
 */
import type { BoatModel } from '../boat';
import type { EnvironmentConfig } from '../config';
import type { BoatState } from '../state';

export function munkMoment(state: BoatState, boat: BoatModel, env: EnvironmentConfig): number {
  const heelDeg = Math.abs(state.heel) * (180 / Math.PI);
  const n0 = 0.0002164 * boat.mass - 0.014572;
  const heelFactor = 1 + 0.00966 * heelDeg + 0.00134 * heelDeg * heelDeg;
  return -(Math.PI / 2) * env.rhoWater * n0 * heelFactor * state.u * state.v;
}
