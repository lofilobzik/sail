/**
 * Simulation configuration. Every physics layer (PHYSICS.md L1-L6) has its own
 * toggle so a wrong result can be bisected layer by layer. Sub-toggles switch
 * individual terms inside a layer.
 */

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
}

export interface WindConfig {
  speedKn: number;
  /** Compass direction the wind blows FROM, degrees. */
  fromDeg: number;
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
  wind: WindConfig;
  env: EnvironmentConfig;
  /** Fixed timestep, s. */
  dt: number;
  /** Integration substeps per fixed step. */
  substeps: number;
}

export function defaultConfig(): SimConfig {
  return {
    layers: { apparentWind: true, sail: true, foils: true, hull: true, heel: true, yaw: true },
    terms: {
      windage: true,
      sailInducedDrag: true,
      // Off by default: Day 2017 p6 as printed, lambda0 = (0.405 (Bwl/Tc) phi)^2 with the
      // Laser's Bwl/Tc = 11.755 gives 13 deg of zero-lift drift at 5 deg heel and more than
      // 90 deg at 20 deg heel, which is not physical. Kept switchable for comparison.
      zeroLiftDrift: false,
      downwash: true,
      heelResistance: true,
      crossflowDrag: true,
      munkMoment: true,
    },
    // DESIGN.md: fixed 6-8 kn; direction configurable.
    wind: { speedKn: 7, fromDeg: 0 },
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
