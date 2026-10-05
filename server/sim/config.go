package sim

import (
	"fmt"
	"strings"
)

// Simulation configuration (src/sim/config.ts). Every physics layer (PHYSICS.md L1-L6) has its own
// toggle so a wrong result can be bisected layer by layer. Sub-toggles switch individual terms
// inside a layer. JSON tags match the TS field names so configs round-trip between TS and Go.

// LayerIDs is TS LAYER_IDS.
var LayerIDs = []string{"apparentWind", "sail", "foils", "hull", "heel", "yaw"}

// LayerToggles switches the physics layers.
type LayerToggles struct {
	// L1: apparent wind = true wind - boat velocity. Off: the sail sees the true wind.
	ApparentWind bool `json:"apparentWind"`
	// L2: sail foil forces from the best-trim envelope. Off: no sail force.
	Sail bool `json:"sail"`
	// L3: daggerboard and rudder lift / drag. Off: no foil forces.
	Foils bool `json:"foils"`
	// L4: hull resistance (upright, heel, crossflow). Off: no hull resistance.
	Hull bool `json:"hull"`
	// L5: heel dynamics and righting moment. Off: boat held upright.
	Heel bool `json:"heel"`
	// L6: yaw dynamics. Off: heading held fixed, no yaw rate.
	Yaw bool `json:"yaw"`
}

// TermToggles switches individual terms inside layers.
type TermToggles struct {
	// L2: parasitic windage of crew, bare mast and topsides (Day 2017 section 2.5).
	Windage bool `json:"windage"`
	// L2: induced + separation drag of the sail (Day 2017 Eq. 1 last term).
	SailInducedDrag bool `json:"sailInducedDrag"`
	// L3: heel-induced zero-lift drift angle lambda0 (Day 2017 p6).
	ZeroLiftDrift bool `json:"zeroLiftDrift"`
	// L3: daggerboard downwash on the rudder (Day 2017 p6).
	Downwash bool `json:"downwash"`
	// L4: heel resistance (Larsson & Eliasson Fig 5.26).
	HeelResistance bool `json:"heelResistance"`
	// L4: hull crossflow drag when sliding sideways.
	CrossflowDrag bool `json:"crossflowDrag"`
	// L6: hull Munk moment (Day 2017 Eq. 14).
	MunkMoment bool `json:"munkMoment"`
	// L5: the sailor moves toward the centreline as luffAmount rises (reach scaled by
	// 1 - luffAmount), as a real sailor sits in when the sail stops pulling. Off: the crew keeps
	// the full windward offset.
	CrewCentresWhenLuffing bool `json:"crewCentresWhenLuffing"`
}

// ModelOptions are model choices where the source is ambiguous. Not layers: each picks between
// two readings of the same equation so they can be compared in the polar.
type ModelOptions struct {
	// Day 2017 p6 lift slope dCL/da = 5.7 AR_E / (1.8 + cos(L) sqrt(X + 4)).
	// "standard": X = AR_E^2 / cos^4(L) (default; matches lifting-line magnitude).
	// "printed":  X = (AR_E^2 / cos^4(L))^2, the outer square as printed (probable misprint).
	LiftSlope string `json:"liftSlope"`
	// Unit of the result of Day p6 lambda0 = (0.405 (Bwl/Tc) phi)^2, phi in radians.
	// The page states no unit. "deg": hypothesis in docs/DAY-EQUATIONS.md (default). "rad":
	// literal reading.
	Lambda0Unit string `json:"lambda0Unit"`
	// The printed lambda0 is a square and carries no sign. ASSUMPTION: +1 applies it with
	// sign(phi), i.e. the heeled hull needs extra leeway toward the side it is heeled to. -1 is
	// the opposite.
	Lambda0Sign int `json:"lambda0Sign"`
	// Upright bare-hull resistance. "delft": ITTC-1957 friction + Keuning & Katgert residuary
	// polynomial (default). "tank": Day 2017 Fig. 2 tank drag area.
	UprightResistance string `json:"uprightResistance"`
}

// GustConfig is seeded gusts and slow direction shifts layered on the mean wind (data/wind.json).
type GustConfig struct {
	Enabled bool   `json:"enabled"`
	Seed    uint32 `json:"seed"`
	// Multiplier on gust speed variation and veer; 0 removes gusts.
	GustScale float64 `json:"gustScale"`
	// Multiplier on the slow direction oscillation; 0 removes shifts.
	ShiftScale float64 `json:"shiftScale"`
}

// WindConfig is the true wind.
type WindConfig struct {
	// Mean wind speed, knots.
	SpeedKn float64 `json:"speedKn"`
	// Mean compass direction the wind blows FROM, degrees.
	FromDeg float64 `json:"fromDeg"`
	// TS `gusts?`: optional there. Here a value (absent JSON = zero value = disabled, which is
	// what TS does for an absent field), so copies of a config never share gust settings.
	Gusts GustConfig `json:"gusts"`
}

// EnvironmentConfig holds fluid properties.
type EnvironmentConfig struct {
	RhoAir   float64 `json:"rhoAir"`
	RhoWater float64 `json:"rhoWater"`
	// Kinematic viscosity of water, m^2/s.
	NuWater float64 `json:"nuWater"`
}

// SimConfig is the full simulation configuration.
type SimConfig struct {
	Layers LayerToggles      `json:"layers"`
	Terms  TermToggles       `json:"terms"`
	Models ModelOptions      `json:"models"`
	Wind   WindConfig        `json:"wind"`
	Env    EnvironmentConfig `json:"env"`
	Waves  WaveConfig        `json:"waves"`
	// The bay's seabed and shores (data/bay.json): grounding in the shallows. Off: endless deep
	// water.
	Land bool `json:"land"`
	// Fixed timestep, s.
	Dt float64 `json:"dt"`
	// Integration substeps per fixed step.
	Substeps int `json:"substeps"`
}

// DefaultConfig is TS defaultConfig(waveSeed) with a seed: waves and gusts both use waveSeed.
func DefaultConfig(waveSeed uint32) SimConfig {
	return defaultConfig(waveSeed, waveSeed)
}

// DefaultConfigUnseeded is TS defaultConfig() with the seed omitted: the waves keep the
// data/waves.json variation seed (1987) and the gusts use seed 1.
func DefaultConfigUnseeded() SimConfig {
	return defaultConfig(WaveParams.Variation.Seed, 1)
}

func defaultConfig(waveSeed, gustSeed uint32) SimConfig {
	return SimConfig{
		Layers: LayerToggles{ApparentWind: true, Sail: true, Foils: true, Hull: true, Heel: true, Yaw: true},
		Terms: TermToggles{
			Windage:         true,
			SailInducedDrag: true,
			// Day 2017 p6 lambda0, read with the result in degrees (models.lambda0Unit). Read in
			// radians it gives 9.9 deg at 5 deg heel and 158 deg at 20 deg heel and collapses the
			// polar; in degrees the polar no longer collapses (milestone 2), so it is on.
			ZeroLiftDrift:          true,
			Downwash:               true,
			HeelResistance:         true,
			CrossflowDrag:          true,
			MunkMoment:             true,
			CrewCentresWhenLuffing: true, // polar: only TWA 30-35 at 6-7 kn change (+0.05-0.08 kn); upwind VMG, reaches and runs identical
		},
		Models: ModelOptions{
			LiftSlope:         "standard",
			Lambda0Unit:       "deg",
			Lambda0Sign:       1,
			UprightResistance: "delft",
		},
		// DESIGN.md: default 7 kn; light-wind sailing range 6-8 kn, debug 0-16 kn is exploratory.
		// Gusts are off here so headless runs and the polar stay constant-wind; the browser
		// enables them.
		Wind:  WindConfig{SpeedKn: 7, FromDeg: 0, Gusts: GustConfig{Enabled: false, Seed: gustSeed, GustScale: 1, ShiftScale: 1}},
		Waves: DefaultWaves(waveSeed),
		// Headless runs and the polar sail in open water; the browser sails in the bay.
		Land: false,
		Env: EnvironmentConfig{
			RhoAir:   1.225, // PHYSICS.md section 3, standard
			RhoWater: 1025,  // PHYSICS.md section 3, sea water (1000 fresh)
			// Larsson & Eliasson p64 (PDF p80), Fig 5.8: salt water at 20 C, approx 1.0e-6 m^2/s
			// (scan).
			NuWater: 1.0e-6,
		},
		Dt:       1.0 / 60, // DESIGN.md: start at 60 Hz
		Substeps: 4,
	}
}

// BrowserConfig is the sailing world as played: waves on and sized by the wind, gusts and shifts,
// the bay's seabed. The browser (offline) and the Go server both start here; only the seed differs
// between sessions. (TS browserConfig in src/sim/config.ts.)
func BrowserConfig(seed uint32) SimConfig {
	cfg := DefaultConfig(seed)
	cfg.Waves.Enabled = true
	cfg.Land = true
	cfg.Wind.Gusts.Enabled = true
	SetWaveWind(&cfg.Waves, cfg.Wind.SpeedKn)
	return cfg
}

// WithDisabledLayers returns a config with the named layers switched off. Unknown names are an
// error.
func WithDisabledLayers(base SimConfig, names []string) (SimConfig, error) {
	for _, name := range names {
		switch name {
		case "apparentWind":
			base.Layers.ApparentWind = false
		case "sail":
			base.Layers.Sail = false
		case "foils":
			base.Layers.Foils = false
		case "hull":
			base.Layers.Hull = false
		case "heel":
			base.Layers.Heel = false
		case "yaw":
			base.Layers.Yaw = false
		default:
			return SimConfig{}, fmt.Errorf("unknown layer %q, expected one of %s", name, strings.Join(LayerIDs, ", "))
		}
	}
	return base, nil
}
