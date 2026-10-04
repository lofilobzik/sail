/**
 * Simulation configuration. Every physics layer (PHYSICS.md L1-L6) has its own
 * toggle so a wrong result can be bisected layer by layer. Sub-toggles switch
 * individual terms inside a layer.
 */
import { defaultWaves, type WaveConfig } from './waves';

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

export function defaultConfig(waveSeed?: number): SimConfig {
  return {
    layers: { apparentWind: true, sail: true, foils: true, hull: true, heel: true, yaw: true },
    terms: {
      windage: true,
      sailInducedDrag: true,
      // Day 2017 p6 lambda0, read with the result in degrees (models.lambda0Unit). Read in
      // radians it gives 9.9 deg at 5 deg heel and 158 deg at 20 deg heel and collapses the
      // polar; in degrees the polar no longer collapses (milestone 2), so it is on.
      zeroLiftDrift: true,
      downwash: true,
      heelResistance: true,
      crossflowDrag: true,
      munkMoment: true,
      crewCentresWhenLuffing: true, // polar: only TWA 30-35 at 6-7 kn change (+0.05-0.08 kn); upwind VMG, reaches and runs identical
    },
    models: {
      liftSlope: 'standard',
      lambda0Unit: 'deg',
      lambda0Sign: 1,
      uprightResistance: 'delft',
    },
    // DESIGN.md: default 7 kn; light-wind sailing range 6-8 kn, debug 0-16 kn is exploratory.
    // Gusts are off here so headless runs and the polar stay constant-wind; the browser enables them.
    wind: { speedKn: 7, fromDeg: 0, gusts: { enabled: false, seed: waveSeed ?? 1, gustScale: 1, shiftScale: 1 } },
    waves: defaultWaves(waveSeed),
    // Headless runs and the polar sail in open water; the browser sails in the bay.
    land: false,
    env: {
      rhoAir: 1.225, // PHYSICS.md section 3, standard
      rhoWater: 1025, // PHYSICS.md section 3, sea water (1000 fresh)
      // Larsson & Eliasson p64 (PDF p80), Fig 5.8: salt water at 20 C, approx 1.0e-6 m^2/s (scan).
      nuWater: 1.0e-6,
    },
    dt: 1 / 60, // DESIGN.md: start at 60 Hz
    substeps: 4,
  };
}

/** Returns a config with the named layers switched off. Unknown names throw. */
export function withDisabledLayers(base: SimConfig, disabled: readonly string[]): SimConfig {
  const layers = { ...base.layers };
  for (const name of disabled) {
    if (!(LAYER_IDS as readonly string[]).includes(name)) {
      throw new Error(`unknown layer "${name}", expected one of ${LAYER_IDS.join(', ')}`);
    }
    layers[name as LayerId] = false;
  }
  return { ...base, layers };
}
