package sim

import "math"

// Wind (src/sim/wind.ts): mean wind plus seeded gusts and slow shifts (data/wind.json).

// WindParameters mirrors data/wind.json (TS WIND_PARAMETERS); only the fields the sim reads.
type WindParameters struct {
	GustAmplitude float64 `json:"gustAmplitude"`
	MinFactor     float64 `json:"minFactor"`
	GustLengthM   float64 `json:"gustLengthM"`
	FineLengthM   float64 `json:"fineLengthM"`
	FineWeight    float64 `json:"fineWeight"`
	GustVeerDeg   float64 `json:"gustVeerDeg"`
	Shifts        []struct {
		AmplitudeDeg float64 `json:"amplitudeDeg"`
		PeriodS      float64 `json:"periodS"`
	} `json:"shifts"`
}

// WindParams is data/wind.json. Read-only.
var WindParams = load[WindParameters]("wind.json")

// windLattice is a deterministic lattice value in [0, 1) for an integer cell and seed (integer
// hash). TS: Math.imul / `>>>` on int32, reproduced bit for bit in uint32.
func windLattice(ix, iy float64, seed uint32) float64 {
	h := toUint32(ix)*0x27d4eb2d ^ toUint32(iy)*0x165667b1 ^ seed*0x9e3779b1
	h = (h ^ (h >> 15)) * 0x85ebca6b
	h ^= h >> 13
	h *= 0xc2b2ae35
	h ^= h >> 16
	return float64(h) / 4294967296
}

// windValueNoise is smoothed value noise in [-1, 1] with a quintic fade.
func windValueNoise(x, y float64, seed uint32) float64 {
	ix := math.Floor(x)
	iy := math.Floor(y)
	fx := x - ix
	fy := y - iy
	ux := fx * fx * fx * (fx*(fx*6-15) + 10)
	uy := fy * fy * fy * (fy*(fy*6-15) + 10)
	a := windLattice(ix, iy, seed)
	b := windLattice(ix+1, iy, seed)
	c := windLattice(ix, iy+1, seed)
	d := windLattice(ix+1, iy+1, seed)
	bottom := a + (b-a)*ux
	return (bottom+(c+(d-c)*ux-bottom)*uy)*2 - 1
}

// MeanWind is the mean wind velocity (where the air moves TO), m/s. The gust field is carried
// along this vector, and slow consumers (cloud drift) use it directly.
func MeanWind(cfg *WindConfig) Vec2 {
	from := BearingToWorld(cfg.FromDeg * DEG)
	speed := cfg.SpeedKn * KNOT
	return Vec2{X: -from.X * speed, Z: -from.Z * speed}
}

// gustNoise is the gust field value n in about [-1, 1] at a world position and time, carried
// downwind.
func gustNoise(x, z, t float64, cfg *WindConfig, seed uint32) float64 {
	mean := MeanWind(cfg)
	px := x - mean.X*t
	pz := z - mean.Z*t
	p := &WindParams
	coarse := windValueNoise(px/p.GustLengthM, pz/p.GustLengthM, seed)
	fine := windValueNoise(px/p.FineLengthM+17.3, pz/p.FineLengthM-9.1, seed+1)
	return (coarse + p.FineWeight*fine) / (1 + p.FineWeight)
}

// WindSpeedFactor is the wind speed multiplier at a position and time (1 when gusts are off).
// The sim, the debug readouts and the water's gust patches all read this one function.
func WindSpeedFactor(position Vec2, time float64, cfg *WindConfig) float64 {
	gusts := &cfg.Gusts
	if !gusts.Enabled {
		return 1
	}
	n := gustNoise(position.X, position.Z, time, cfg, gusts.Seed)
	return max(WindParams.MinFactor, 1+WindParams.GustAmplitude*gusts.GustScale*n)
}

// WindShiftDeg is the slow position-independent oscillation of the wind direction, degrees
// (clockwise positive).
func WindShiftDeg(time float64, cfg *WindConfig) float64 {
	gusts := &cfg.Gusts
	if !gusts.Enabled {
		return 0
	}
	shift := 0.0
	for k, s := range WindParams.Shifts {
		phase := 2 * math.Pi * windLattice(float64(k), 0, gusts.Seed+99)
		shift += s.AmplitudeDeg * math.Sin((2*math.Pi*time)/s.PeriodS+phase)
	}
	return shift * gusts.ShiftScale
}

// GetWind is the true wind velocity (where the air moves TO) at a world position and time, m/s.
// The only source of wind in the sim (PHYSICS.md L1). With gusts disabled this is the constant
// mean wind exactly. With them enabled, speed follows the downwind-carried gust field, the
// direction veers with gust strength and shifts slowly with time.
func GetWind(p Vec2, t float64, w *WindConfig) Vec2 {
	gusts := &w.Gusts
	if !gusts.Enabled {
		return MeanWind(w)
	}
	n := gustNoise(p.X, p.Z, t, w, gusts.Seed)
	factor := max(WindParams.MinFactor, 1+WindParams.GustAmplitude*gusts.GustScale*n)
	fromDeg := w.FromDeg + WindShiftDeg(t, w) + WindParams.GustVeerDeg*gusts.GustScale*n
	from := BearingToWorld(fromDeg * DEG)
	speed := w.SpeedKn * KNOT * factor
	return Vec2{X: -from.X * speed, Z: -from.Z * speed}
}
