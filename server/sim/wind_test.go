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

// openWaterSample is the i-th of the open-water samples (far outside the steady zone).
func openWaterSample(i int) (Vec2, float64) {
	return Vec2{X: -200 + math.Mod(float64(i)*37.7, 2000), Z: -1800 + math.Mod(float64(i)*91.3, 2000)}, 300 + float64(i)*0.37
}

const openWaterSamples = 4000

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

func TestPuffEnvelope(t *testing.T) {
	const life = 100 // riseFraction 0.2: peak at age 20
	equal(t, "birth", puffEnvelope(0, life), 0)
	rising := puffEnvelope(10, life)
	greater(t, "rising", rising, 0)
	less(t, "rising", rising, 1)
	equal(t, "peak", puffEnvelope(20, life), 1)
	fading := puffEnvelope(60, life)
	greater(t, "fading", fading, 0)
	less(t, "fading", fading, puffEnvelope(40, life))
	equal(t, "death", puffEnvelope(100, life), 0)
	for age := 0.5; age <= life; age += 0.5 {
		less(t, "step", math.Abs(puffEnvelope(age, life)-puffEnvelope(age-0.5, life)), 0.05)
	}
}

func TestPuffsAreStaticInTheDriftFrame(t *testing.T) {
	w := gusty(nil, nil)
	before := activePuffs(-2000, -2000, 2000, 2000, 500, w, nil)
	after := activePuffs(-2000, -2000, 2000, 2000, 505, w, nil)
	matches := 0
	for _, a := range before {
		for _, b := range after {
			if a.qx != b.qx || a.qz != b.qz {
				continue
			}
			matches++
			equal(t, "along", b.along, a.along)
			equal(t, "across", b.across, a.across)
			equal(t, "strength", b.strength, a.strength)
			equal(t, "veer", b.veerDeg, a.veerDeg)
		}
	}
	greaterEq(t, "matched puffs", float64(matches), 5)
	drift, mean := gustDrift(w), MeanWind(w)
	closeTo(t, "drift x", drift.X, 1.2*mean.X, 12)
	closeTo(t, "drift z", drift.Z, 1.2*mean.Z, 12)
}

func TestPuffsOnlyStrengthen(t *testing.T) {
	cfg := gusty(nil, nil)
	hi := math.Inf(-1)
	for i := range openWaterSamples {
		p, tt := openWaterSample(i)
		f := WindSpeedFactor(p, tt, cfg)
		greaterEq(t, "factor", f, 1)
		lessEq(t, "factor", f, 1+WindParams.Puffs.Cap+1e-12)
		hi = max(hi, f)
	}
	greater(t, "max", hi, 1.25) // real gusts
}

func TestGustStrengthScales(t *testing.T) {
	scale := func(s float64) *WindConfig { return gusty(func(g *GustConfig) { g.GustScale = s }, nil) }
	const tt = 300
	var p Vec2
	found := false
	for x := -200.0; x <= 1800 && !found; x += 25 {
		for z := -1800.0; z <= 200 && !found; z += 25 {
			p = Vec2{X: x, Z: z}
			found = WindSpeedFactor(p, tt, scale(1)) > 1.02
		}
	}
	if !found {
		t.Fatal("no gust above 2 % on the grid")
	}
	base := WindSpeedFactor(p, tt, scale(1)) - 1
	equal(t, "zero strength", WindSpeedFactor(p, tt, scale(0)), 1)
	closeTo(t, "half strength", WindSpeedFactor(p, tt, scale(0.5))-1, base/2, 12)
}

func TestSteadyZoneIsCalm(t *testing.T) {
	points := []Vec2{{X: -1811, Z: 741.25}, {X: -1740, Z: 760}, {X: -1713, Z: 753}, {X: -1713, Z: 813}} // berth 0, departure, H1, H2
	for _, seed := range []uint32{1, 0x9e3779b9} {
		cfg := gusty(func(g *GustConfig) { g.Seed = seed }, nil)
		mean := MeanWind(cfg)
		for tt := 0.0; tt <= 600; tt += 7.5 {
			for _, p := range points {
				equal(t, "wind", GetWind(p, tt, cfg), mean)
				equal(t, "factor", WindSpeedFactor(p, tt, cfg), 1)
			}
		}
	}
	zone := &WindParams.SteadyZone
	equal(t, "inside", steadyWeight(zone.X+zone.InnerM-1, zone.Z), 0)
	equal(t, "outside", steadyWeight(zone.X, zone.Z+zone.OuterM+1), 1)
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
	equal(t, "position independent", GetWind(Vec2{}, 400, cfg), GetWind(Vec2{X: 2000, Z: -1500}, 400, cfg))
	closeTo(t, "no shift at zero", WindShiftDeg(400, gusty(func(g *GustConfig) { g.ShiftScale = 0 }, nil)), 0, 12)
}

func TestVeerStaysSmall(t *testing.T) {
	cfg := gusty(nil, nil)
	for i := range openWaterSamples {
		p, tt := openWaterSample(i)
		w := GetWind(p, tt, cfg)
		fromDeg := math.Atan2(-w.X, w.Z) * 180 / math.Pi // bearing the wind comes FROM
		veer := math.Mod(fromDeg-(cfg.FromDeg+WindShiftDeg(tt, cfg))+540, 360) - 180
		lessEq(t, "|veer|", math.Abs(veer), WindParams.Puffs.VeerDeg+1e-9)
	}
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
