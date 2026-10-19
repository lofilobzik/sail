package sim

import "math"

// Wind (src/sim/wind.ts): mean wind plus seeded gust puffs and slow shifts (data/wind.json).

// WindParameters mirrors data/wind.json (TS WIND_PARAMETERS); only the fields the sim reads.
type WindParameters struct {
	Puffs struct {
		CellM        float64    `json:"cellM"`
		SlotS        float64    `json:"slotS"`
		Probability  float64    `json:"probability"`
		LifeS        [2]float64 `json:"lifeS"`
		RiseFraction float64    `json:"riseFraction"`
		RadiusM      [2]float64 `json:"radiusM"`
		Elongation   float64    `json:"elongation"`
		Strength     [2]float64 `json:"strength"`
		Cap          float64    `json:"cap"`
		VeerDeg      float64    `json:"veerDeg"`
		Drift        float64    `json:"drift"`
	} `json:"puffs"`
	SteadyZone struct {
		X      float64 `json:"x"`
		Z      float64 `json:"z"`
		InnerM float64 `json:"innerM"`
		OuterM float64 `json:"outerM"`
	} `json:"steadyZone"`
	Shifts []struct {
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

// puffRandom is the n-th uniform [0, 1) draw of the puff in drift-frame cell (ix, iz), time slot k,
// where cell = toUint32(ix)*0x27d4eb2d ^ toUint32(iz)*0x165667b1 ^ toUint32(k)*0x2c1b3c6d (hashed
// once per cell by activePuffs).
func puffRandom(cell, seed, n uint32) float64 {
	h := cell ^ (seed+n*0x9e3779b9)*0x9e3779b1
	h = (h ^ (h >> 15)) * 0x85ebca6b
	h ^= h >> 13
	h *= 0xc2b2ae35
	h ^= h >> 16
	return float64(h) / 4294967296
}

// windSmooth is smoothstep on [0, 1].
func windSmooth(x float64) float64 {
	x = Clamp(x, 0, 1)
	return x * x * (3 - 2*x)
}

// MeanWind is the mean wind velocity (where the air moves TO), m/s. Gust puffs drift along a
// multiple of this vector, and slow consumers (cloud drift) use it directly.
func MeanWind(cfg *WindConfig) Vec2 {
	from := BearingToWorld(cfg.FromDeg * DEG)
	speed := cfg.SpeedKn * KNOT
	return Vec2{X: -from.X * speed, Z: -from.Z * speed}
}

// gustDrift is the velocity of the frame the gust puffs sit still in, m/s.
func gustDrift(w *WindConfig) Vec2 {
	m := MeanWind(w)
	d := WindParams.Puffs.Drift
	return Vec2{X: m.X * d, Z: m.Z * d}
}

// gustPuff is one live puff at the time it was collected for.
type gustPuff struct {
	qx, qz        float64 // centre in the drift frame (world minus drift × t), m
	ax, az        float64 // unit downwind axis: -BearingToWorld(FromDeg)
	along, across float64 // semi-axes, m
	env           float64 // life envelope at the collection time, 0..1
	strength      float64 // peak speed excess × GustScale
	veerDeg       float64 // direction shift × GustScale, degrees clockwise
}

// puffEnvelope is a puff's strength over its life: a smooth rise over RiseFraction of it, then a
// smooth fade to zero at the end.
func puffEnvelope(age, life float64) float64 {
	rise := WindParams.Puffs.RiseFraction * life
	if age < rise {
		return windSmooth(age / rise)
	}
	return 1 - windSmooth((age-rise)/(life-rise))
}

// activePuffs appends the puffs alive at t that can reach the drift-frame box [qMinX, qMaxX] × [qMinZ, qMaxZ].
// The order (slot, then z cell, then x cell) is part of the contract with TS activePuffs.
func activePuffs(qMinX, qMinZ, qMaxX, qMaxZ, t float64, w *WindConfig, out []gustPuff) []gustPuff {
	p := &WindParams.Puffs
	reach := p.Elongation * p.RadiusM[1]
	from := BearingToWorld(w.FromDeg * DEG)
	seed := w.Gusts.Seed
	scale := w.Gusts.GustScale
	kMax := math.Floor(t / p.SlotS)
	izMax := math.Floor((qMaxZ + reach) / p.CellM)
	ixMax := math.Floor((qMaxX + reach) / p.CellM)
	for k := math.Floor((t - p.LifeS[1]) / p.SlotS); k <= kMax; k++ {
		kHash := toUint32(k) * 0x2c1b3c6d
		for iz := math.Floor((qMinZ - reach) / p.CellM); iz <= izMax; iz++ {
			zHash := toUint32(iz)*0x165667b1 ^ kHash
			for ix := math.Floor((qMinX - reach) / p.CellM); ix <= ixMax; ix++ {
				cell := toUint32(ix)*0x27d4eb2d ^ zHash
				if puffRandom(cell, seed, 0) >= p.Probability {
					continue
				}
				birth := (k + puffRandom(cell, seed, 1)) * p.SlotS
				life := p.LifeS[0] + (p.LifeS[1]-p.LifeS[0])*puffRandom(cell, seed, 2)
				age := t - birth
				if !(age > 0 && age < life) {
					continue
				}
				r := p.RadiusM[0] + (p.RadiusM[1]-p.RadiusM[0])*puffRandom(cell, seed, 5)
				s := puffRandom(cell, seed, 6)
				out = append(out, gustPuff{
					qx:       (ix + puffRandom(cell, seed, 3)) * p.CellM,
					qz:       (iz + puffRandom(cell, seed, 4)) * p.CellM,
					ax:       -from.X,
					az:       -from.Z,
					along:    r * p.Elongation,
					across:   r,
					env:      puffEnvelope(age, life),
					strength: (p.Strength[0] + (p.Strength[1]-p.Strength[0])*s*s*s) * scale,
					veerDeg:  (2*puffRandom(cell, seed, 7) - 1) * p.VeerDeg * scale,
				})
			}
		}
	}
	return out
}

// puffShape is the puff's falloff at drift-frame point (qx, qz): (1 - d²)³ inside the ellipse, 0 outside.
func puffShape(f *gustPuff, qx, qz float64) float64 {
	dx, dz := qx-f.qx, qz-f.qz
	a := (dx*f.ax + dz*f.az) / f.along
	c := (dz*f.ax - dx*f.az) / f.across
	d2 := a*a + c*c
	if d2 >= 1 {
		return 0
	}
	m := 1 - d2
	return m * m * m
}

// puffsAt combines puffs at drift-frame (qx, qz): speed excess capped at Cap × GustScale, and the
// shape-weighted mean veer (scaled down where puffs are weak).
func puffsAt(qx, qz float64, puffs []gustPuff, gustScale float64) (excess, veerDeg float64) {
	limit := WindParams.Puffs.Cap * gustScale
	prod, sumW, sumWV := 1.0, 0.0, 0.0
	for i := range puffs {
		m := puffShape(&puffs[i], qx, qz)
		if m == 0 {
			continue
		}
		wgt := puffs[i].env * m
		prod *= 1 - puffs[i].strength*wgt/limit
		sumW += wgt
		sumWV += wgt * puffs[i].veerDeg
	}
	return limit * (1 - prod), sumWV / max(1, sumW)
}

// steadyWeight is how much gusts and shifts apply at a world position: 0 in the Westcove steady
// zone, 1 in open water.
func steadyWeight(x, z float64) float64 {
	zone := &WindParams.SteadyZone
	dx, dz := x-zone.X, z-zone.Z
	d := math.Sqrt(dx*dx + dz*dz)
	return windSmooth((d - zone.InnerM) / (zone.OuterM - zone.InnerM))
}

// localGust is the puffs' speed excess and veer at a world position and time, before the steady zone.
func localGust(p Vec2, t float64, w *WindConfig) (excess, veerDeg float64) {
	if !w.Gusts.Enabled || w.Gusts.GustScale <= 0 {
		return 0, 0
	}
	v := gustDrift(w)
	qx, qz := p.X-v.X*t, p.Z-v.Z*t
	var buf [32]gustPuff
	puffs := activePuffs(qx, qz, qx, qz, t, w, buf[:0])
	return puffsAt(qx, qz, puffs, w.Gusts.GustScale)
}

// WindSpeedFactor is the wind speed multiplier at a position and time (1 when gusts are off).
// The sim, the debug readouts and the water's gust patches all read this one function.
func WindSpeedFactor(position Vec2, time float64, cfg *WindConfig) float64 {
	if !cfg.Gusts.Enabled {
		return 1
	}
	e, _ := localGust(position, time, cfg)
	return 1 + steadyWeight(position.X, position.Z)*e
}

// WindShiftDeg is the slow position-independent oscillation of the wind direction, degrees
// (clockwise positive), before the steady zone.
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
// mean wind exactly. With them enabled, the direction shifts slowly with time, gust puffs add
// speed and a small veer, and both fade out in the Westcove steady zone.
func GetWind(p Vec2, t float64, w *WindConfig) Vec2 {
	if !w.Gusts.Enabled {
		return MeanWind(w)
	}
	// Layers: base (the mean wind; a baked base map would replace this speed and direction later),
	// then the bay-wide slow shifts, then local gust puffs; shifts and gusts fade out in the steady zone.
	e, veer := localGust(p, t, w)
	zone := steadyWeight(p.X, p.Z)
	fromDeg := w.FromDeg + zone*(WindShiftDeg(t, w)+veer)
	from := BearingToWorld(fromDeg * DEG)
	speed := w.SpeedKn * KNOT * (1 + zone*e)
	return Vec2{X: -from.X * speed, Z: -from.Z * speed}
}
