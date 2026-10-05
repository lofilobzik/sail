package sim

import (
	"math"
	"testing"
)

// Port of src/sim/wind.test.ts.

func gusty(over func(*GustConfig), wind func(*WindConfig)) *WindConfig {
	w := &WindConfig{SpeedKn: 7, FromDeg: 0, Gusts: GustConfig{Enabled: true, Seed: 1987, GustScale: 1, ShiftScale: 1}}
	if over != nil {
		over(&w.Gusts)
	}
	if wind != nil {
		wind(w)
	}
	return w
}

func windSpeed(w Vec2) float64 { return math.Hypot(w.X, w.Z) }

func TestWindIsMeanWhenGustsAbsentOrDisabled(t *testing.T) {
	mean := MeanWind(&WindConfig{SpeedKn: 7, FromDeg: 30})
	equal(t, "absent", GetWind(Vec2{X: 5, Z: -9}, 123, &WindConfig{SpeedKn: 7, FromDeg: 30}), mean)
	off := gusty(func(g *GustConfig) { g.Enabled = false }, func(w *WindConfig) { w.FromDeg = 30 })
	equal(t, "disabled", GetWind(Vec2{X: 5, Z: -9}, 123, off), mean)
	equal(t, "factor", WindSpeedFactor(Vec2{X: 5, Z: -9}, 123, off), 1)
	equal(t, "shift", WindShiftDeg(123, off), 0)
}

func TestWindIsDeterministic(t *testing.T) {
	a := GetWind(Vec2{X: 12, Z: 40}, 55, gusty(nil, nil))
	equal(t, "same seed", GetWind(Vec2{X: 12, Z: 40}, 55, gusty(nil, nil)), a)
	if GetWind(Vec2{X: 12, Z: 40}, 55, gusty(func(g *GustConfig) { g.Seed = 7 }, nil)) == a {
		t.Error("seed 7 gives the same wind")
	}
}

func TestGustPatternCarriedDownwind(t *testing.T) {
	// Wind from the north blows toward +z at the mean speed: the speed factor seen at p now is
	// seen at p + w*dt a time dt later.
	cfg := gusty(nil, func(w *WindConfig) { w.FromDeg = 0 })
	w := MeanWind(cfg)
	for _, c := range [][4]float64{{10, 20, 5, 30}, {-300, 80, 1000, 90}, {0, 0, 0, 12.5}} {
		x, z, tt, dt := c[0], c[1], c[2], c[3]
		before := WindSpeedFactor(Vec2{X: x, Z: z}, tt, cfg)
		after := WindSpeedFactor(Vec2{X: x + w.X*dt, Z: z + w.Z*dt}, tt+dt, cfg)
		closeTo(t, "after", after, before, 9)
	}
}

func TestGustsAndLullsAroundMean(t *testing.T) {
	cfg := gusty(nil, nil)
	sum := 0.0
	lo := math.Inf(1)
	hi := math.Inf(-1)
	const n = 4000
	for i := range n {
		f := WindSpeedFactor(Vec2{X: math.Mod(float64(i)*37.7, 2000), Z: math.Mod(float64(i)*91.3, 2000)}, float64(i)*3.1, cfg)
		sum += f
		lo = min(lo, f)
		hi = max(hi, f)
	}
	greater(t, "mean", sum/n, 0.93)
	less(t, "mean", sum/n, 1.07)
	greater(t, "max", hi, 1.25) // real gusts
	less(t, "min", lo, 0.8)     // real lulls
	greaterEq(t, "min", lo, WindParams.MinFactor)
	less(t, "max", hi, 1+WindParams.GustAmplitude+1e-9)
}

func TestGustStrengthScales(t *testing.T) {
	p := Vec2{X: 33, Z: -71}
	scale := func(s float64) *WindConfig { return gusty(func(g *GustConfig) { g.GustScale = s }, nil) }
	base := WindSpeedFactor(p, 20, scale(1)) - 1
	greater(t, "|base|", math.Abs(base), 0.02)
	equal(t, "zero strength", WindSpeedFactor(p, 20, scale(0)), 1)
	closeTo(t, "half strength", WindSpeedFactor(p, 20, scale(0.5))-1, base/2, 12)
}

func TestWindShiftsSlowlyAndBoundedly(t *testing.T) {
	cfg := gusty(func(g *GustConfig) { g.GustScale = 0 }, nil)
	bound := 0.0
	for _, c := range WindParams.Shifts {
		bound += c.AmplitudeDeg
	}
	swing := 0.0
	for tt := 0.0; tt <= 1200; tt += 5 {
		shift := WindShiftDeg(tt, cfg)
		lessEq(t, "|shift|", math.Abs(shift), bound+1e-9)
		swing = max(swing, math.Abs(shift))
		less(t, "shift rate", WindShiftDeg(tt+0.1, cfg)-shift, 0.1) // slow: well under 1 deg/s
	}
	greater(t, "swing", swing, 3)
	equal(t, "position independent", GetWind(Vec2{}, 400, cfg), GetWind(Vec2{X: 5000, Z: -3000}, 400, cfg))
	closeTo(t, "no shift at zero", WindShiftDeg(400, gusty(func(g *GustConfig) { g.ShiftScale = 0 }, nil)), 0, 12)
}

func TestWindTurnsAsTheShiftSays(t *testing.T) {
	cfg := gusty(func(g *GustConfig) { g.GustScale = 0 }, func(w *WindConfig) { w.FromDeg = 90 })
	const tt = 40
	w := GetWind(Vec2{}, tt, cfg)
	fromDeg := math.Mod((math.Atan2(-w.X, w.Z)*180)/math.Pi+360, 360) // bearing the wind comes FROM
	closeTo(t, "fromDeg", fromDeg, 90+WindShiftDeg(tt, cfg), 9)
	closeTo(t, "speed", windSpeed(w), 7*KNOT, 12)
}

func TestZeroSpeedWindIsCalm(t *testing.T) {
	equal(t, "speed", windSpeed(GetWind(Vec2{X: 1, Z: 2}, 3, gusty(nil, func(w *WindConfig) { w.SpeedKn = 0 }))), 0)
}
