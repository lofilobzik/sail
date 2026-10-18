import type { Vec2 } from '../sim/frames';
/** Normalized, already rate-limited control values (produced by input/). */
export interface Controls {
  /** Tiller position -1..1, + = tiller to starboard (boat turns to port). */
  tiller: number;
  /** Mainsheet 0..1, 0 = sheeted hard in, 1 = fully eased. */
  sheet: number;
  /** Hiking 0..1, 0 = sitting in, 1 = fully hiked. */
  hike: number;
}

export interface BoatState {
  /** Sim time, s. */
  t: number;
  /** World position, m. */
  x: number;
  z: number;
  /** Compass heading, rad. */
  heading: number;
  /** Body velocity relative to mean still water, m/s (+u forward, +v starboard). */
  u: number;
  v: number;
  /** Yaw rate, rad/s (+ = bow to starboard). */
  r: number;
  /** Heel, rad (+ = starboard rail down), and heel rate. */
  heel: number;
  p: number;
  /** Wave-driven pitch, rad (+ = bow up), and pitch rate, rad/s. */
  pitch: number;
  pitchRate: number;
  /** Boom angle from the centreline, rad (+ = boom to starboard). */
  boom: number;
  /** Side the boom is on: +1 starboard, -1 port. Changes on tacks and gybes. */
  boomSide: 1 | -1;
  /** Crew CG offset from the centreline, m (+ = starboard). */
  crewY: number;
  /** Held at a berth: position, heading and velocities stay fixed; heel, pitch, boom and crew still move. */
  moored: boolean;
}
export const LAYER_IDS = ['apparentWind', 'sail', 'foils', 'hull', 'heel', 'yaw'] as const;
export type LayerId = (typeof LAYER_IDS)[number];

export interface LayerToggles {
  /** L1: apparent wind = true wind - boat velocity. Off: the sail sees the true wind. */
  apparentWind: boolean;
  /** L2: sail foil forces from the best-trim envelope. Off: no sail force. */
  sail: boolean;
  /** L3: daggerboard and rudder lift / drag. Off: no foil forces. */
  foils: boolean;
  /** L4: hull resistance (upright, heel, crossflow). Off: no hull resistance. */
  hull: boolean;
  /** L5: heel dynamics and righting moment. Off: boat held upright. */
  heel: boolean;
  /** L6: yaw dynamics. Off: heading held fixed, no yaw rate. */
  yaw: boolean;
}

export interface TermToggles {
  /** L2: parasitic windage of crew, bare mast and topsides (Day 2017 section 2.5). */
  windage: boolean;
  /** L2: induced + separation drag of the sail (Day 2017 Eq. 1 last term). */
  sailInducedDrag: boolean;
  /** L3: heel-induced zero-lift drift angle lambda0 (Day 2017 p6). */
  zeroLiftDrift: boolean;
  /** L3: daggerboard downwash on the rudder (Day 2017 p6). */
  downwash: boolean;
  /** L4: heel resistance (Larsson & Eliasson Fig 5.26). */
  heelResistance: boolean;
  /** L4: hull crossflow drag when sliding sideways. */
  crossflowDrag: boolean;
  /** L6: hull Munk moment (Day 2017 Eq. 14). */
  munkMoment: boolean;
  /**
   * L5: the sailor moves toward the centreline as luffAmount rises (reach scaled by 1 - luffAmount),
   * as a real sailor sits in when the sail stops pulling. Off: the crew keeps the full windward offset.
   */
  crewCentresWhenLuffing: boolean;
}

/**
 * Model choices where the source is ambiguous. Not layers: each picks between two
 * readings of the same equation so they can be compared in the polar.
 */
export interface ModelOptions {
  /**
   * Day 2017 p6 lift slope dCL/da = 5.7 AR_E / (1.8 + cos(L) sqrt(X + 4)).
   * 'standard': X = AR_E^2 / cos^4(L) (default; matches lifting-line magnitude).
   * 'printed':  X = (AR_E^2 / cos^4(L))^2, the outer square as printed (probable misprint).
   */
  liftSlope: 'standard' | 'printed';
  /**
   * Unit of the result of Day p6 lambda0 = (0.405 (Bwl/Tc) phi)^2, phi in radians.
   * The page states no unit. 'deg': hypothesis in docs/DAY-EQUATIONS.md (default). 'rad': literal reading.
   */
  lambda0Unit: 'deg' | 'rad';
  /**
   * The printed lambda0 is a square and carries no sign. ASSUMPTION: +1 applies it with sign(phi),
   * i.e. the heeled hull needs extra leeway toward the side it is heeled to. -1 is the opposite.
   */
  lambda0Sign: 1 | -1;
  /**
   * Upright bare-hull resistance. 'delft': ITTC-1957 friction + Keuning & Katgert residuary
   * polynomial (default). 'tank': Day 2017 Fig. 2 tank drag area.
   */
  uprightResistance: 'delft' | 'tank';
}

/** Seeded gusts and slow direction shifts layered on the mean wind (data/wind.json). */
export interface GustConfig {
  enabled: boolean;
  seed: number;
  /** Multiplier on gust speed variation and veer; 0 removes gusts. */
  gustScale: number;
  /** Multiplier on the slow direction oscillation; 0 removes shifts. */
  shiftScale: number;
}

export interface WindConfig {
  /** Mean wind speed, knots. */
  speedKn: number;
  /** Mean compass direction the wind blows FROM, degrees. */
  fromDeg: number;
  /** Absent or disabled: constant wind. */
  gusts?: GustConfig;
}

export interface EnvironmentConfig {
  rhoAir: number;
  rhoWater: number;
  /** Kinematic viscosity of water, m^2/s. */
  nuWater: number;
}

export interface SimConfig {
  layers: LayerToggles;
  terms: TermToggles;
  models: ModelOptions;
  wind: WindConfig;
  env: EnvironmentConfig;
  waves: WaveConfig;
  /** The bay's seabed and shores (data/bay.json): grounding in the shallows. Off: endless deep water. */
  land: boolean;
  /** Fixed timestep, s. */
  dt: number;
  /** Integration substeps per fixed step. */
  substeps: number;
}
export interface WaveComponent {
  readonly dx: number;
  readonly dz: number;
  readonly k: number;
  readonly omega: number;
  readonly amplitude: number;
  readonly phase: number;
  readonly choppiness: number;
}

export interface WaveConfig {
  enabled: boolean;
  amplitudeScale: number;
  bigScale: number;
  rippleScale: number;
  /** Fixed seed for strengths/phases; wind and sea controls never re-roll it. */
  seed: number;
  /** Wind driving the compiled sea, updated alongside the true wind by its owner. */
  windSpeedKn: number;
  /** Cached safe overall amplitude multiplier for the compiled components. */
  amplitudeLimit: number;
  /** Primary broad-wave period at reference wind, seconds. */
  periodSeconds: number;
  /** Primary wave propagation TO compass bearing, degrees. */
  directionDeg: number;
  components: readonly WaveComponent[];
}
export interface ApparentWind {
  /** Air velocity relative to the boat, body frame (where the air moves TO), m/s. */
  u: number;
  v: number;
  /** Apparent wind speed, m/s. */
  speed: number;
  /** Apparent wind angle, rad, direction the wind comes FROM relative to the bow, + = starboard. */
  angle: number;
}
export interface FoilForce {
  fx: number;
  fy: number;
  lift: number;
  drag: number;
  cl: number;
  /** Effective angle of attack, rad. */
  alpha: number;
  stalled: boolean;
}

export interface FoilsResult {
  fx: number;
  fy: number;
  heelMoment: number;
  yawMoment: number;
  board: FoilForce;
  rudder: FoilForce;
  /** Rudder angle, rad (+ = leading edge to starboard, i.e. tiller to starboard). */
  rudderAngle: number;
  /** Zero-lift drift angle applied, rad. */
  lambda0: number;
  downwash: number;
}

/** Local orbital flow projected onto each pitched/heeled foil's axes. */
export interface FoilAmbientFlow {
  boardU: number;
  boardV: number;
  rudderU: number;
  rudderV: number;
}
export interface GroundResult {
  /** Water depth under the boat, m (negative on dry land). */
  depth: number;
  /** How far the board tip would be below the seabed, m; 0 when afloat. */
  penetration: number;
  /** Body-frame force, N, and yaw moment, N m. */
  fx: number;
  fy: number;
  yawMoment: number;
}
export interface HullResult {
  fx: number;
  fy: number;
  yawMoment: number;
  heelMoment: number;
  upright: number;
  /** Parts of `upright` for the 'delft' model (0 for 'tank'). */
  friction: number;
  residuary: number;
  heelResistance: number;
  crossflow: number;
}
export interface Windage {
  fx: number;
  fy: number;
  heelMoment: number;
  yawMoment: number;
  drag: number;
}

export interface SailResult {
  fx: number;
  fy: number;
  /** Heeling moment, N m (+ = heels to starboard). */
  heelMoment: number;
  /** Yaw moment, N m (+ = bow to starboard). */
  yawMoment: number;
  lift: number;
  drag: number;
  cl: number;
  cd: number;
  cdv: number;
  cdi: number;
  alpha: number;
  luffAmount: number;
  stallAmount: number;
  trimError: number;
  /** Apparent wind in the heeled plane. */
  awsHeeled: number;
  awaHeeled: number;
  ce: { x: number; y: number; z: number };
  windage: Windage;
}
export interface WaveDiagnostics extends FoilAmbientFlow {
  height: number;
  rollTarget: number;
  pitchTarget: number;
  rollMoment: number;
}

export interface HeelDiagnostics {
  aeroMoment: number;
  hydroMoment: number;
  rightingMoment: number;
  crewY: number;
  crewTargetY: number;
  crewZ: number;
}

export interface YawDiagnostics {
  sail: number;
  foils: number;
  hull: number;
  munk: number;
  damping: number;
  /** Seabed contact damping, N m (0 afloat or with cfg.land off). */
  ground: number;
  total: number;
}

export interface Diagnostics {
  trueWind: Vec2;
  apparent: ApparentWind;
  /** null when the layer is disabled. */
  sail: SailResult | null;
  foils: FoilsResult | null;
  hull: HullResult | null;
  /** null on the exact flat-water path (disabled or zero amplitude). */
  waves: WaveDiagnostics | null;
  /** null when the bay is off (cfg.land). */
  ground: GroundResult | null;
  heel: HeelDiagnostics;
  yaw: YawDiagnostics;
  /** Total body-frame force, N, and moments, N m. */
  total: { fx: number; fy: number; yaw: number; heel: number };
  speed: number;
  /** Leeway angle, rad (+ = sliding to starboard). */
  leeway: number;
  /** Velocity made good toward the wind, m/s. */
  vmg: number;
  /** Signed target boom angle the boom is swinging to, rad. */
  boomTarget: number;
  boomSide: 1 | -1;
  controls: Controls;
}
export interface StepResult {
  state: BoatState;
  diagnostics: Diagnostics;
}
