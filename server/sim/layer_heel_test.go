package sim

import (
	"math"
	"testing"
)

// Port of src/sim/layers/heel.test.ts.

func TestRightingMomentMatchesEq18FullyHiked(t *testing.T) {
	c := &testBoat.Cfg.Crew
	phi := 12 * DEG
	dY := c.HikeReachFrac * c.CgHeightFrac * c.Height // 95% of 55% of height
	dZ := c.HikedZAboveHullCg
	gz := testBoat.Gm * math.Sin(phi)
	eq18 := testBoat.HullMass*G*gz + testBoat.CrewMass*G*(gz+dY*math.Cos(phi)-dZ*math.Sin(phi))
	// Heeled to starboard with the crew hiking on the port side.
	closeTo(t, "righting", -rightingMoment(phi, -dY, dZ, testBoat), eq18, 9)
}

func TestCrewOppositeBoomFurtherOutWhenHiking(t *testing.T) {
	state := InitialState(0, 0)
	state.BoomSide = 1
	sitting := crewPosition(&state, &Controls{Hike: 0}, testBoat, 0)
	hiked := crewPosition(&state, &Controls{Hike: 1}, testBoat, 0)
	less(t, "sitting", sitting.TargetY, 0)
	less(t, "hiked", hiked.TargetY, sitting.TargetY)
	closeTo(t, "hiked reach", hiked.TargetY, -0.95*0.55*testBoat.Cfg.Crew.Height, 12)
}

func TestCrewCentresAsLuffRises(t *testing.T) {
	state := InitialState(0, 0)
	state.BoomSide = 1
	hiking := Controls{Hike: 0.5}
	full := crewPosition(&state, &hiking, testBoat, 0).TargetY
	equal(t, "luff 0", crewPosition(&state, &hiking, testBoat, 0).TargetY, full)
	closeTo(t, "luff 0.5", crewPosition(&state, &hiking, testBoat, 0.5).TargetY, full/2, 12)
	luffing := crewPosition(&state, &hiking, testBoat, 1).TargetY
	equal(t, "luff 1 side", math.Copysign(1, luffing), math.Copysign(1, full)) // centred, same side
	less(t, "luff 1 offset", math.Abs(luffing), 0.002)
	equal(t, "z", crewPosition(&state, &hiking, testBoat, 1).Z, crewPosition(&state, &hiking, testBoat, 0).Z)
}

// Regression: the sailor used to reach exactly CrewY = 0 when the sail luffed fully, then took the
// side from BoomSide, which flips with every apparent-wind crossing while pinching.
func TestCrewKeepsSideThroughFullLuff(t *testing.T) {
	sitting := Controls{}
	s := InitialState(0, 0)
	s.Boom, s.BoomSide, s.CrewY = 3*DEG, 1, -testBoat.Cfg.Crew.SitInOffset
	move := CrewCrossingSpeed / 60
	for range 120 {
		target := crewPosition(&s, &sitting, testBoat, 1).TargetY
		s.CrewY += min(max(target-s.CrewY, -move), move)
	}
	less(t, "crewY after luffing", s.CrewY, 0)
	s.Boom, s.BoomSide = -3*DEG, -1 // boom flicked across, not clearly
	less(t, "target after boomSide flip", crewPosition(&s, &sitting, testBoat, 0).TargetY, 0)
}

func heelOnlyConfig() SimConfig {
	// No sail, no foils, no hull: only the crew moment and hydrostatics act.
	cfg := DefaultConfigUnseeded()
	cfg.Layers.Sail, cfg.Layers.Foils, cfg.Layers.Hull, cfg.Layers.Yaw = false, false, false, false
	return cfg
}

func TestSettlesWhereRightingBalances(t *testing.T) {
	cfg := heelOnlyConfig()
	crew := &testBoat.Cfg.Crew
	settle := func(crewY float64) float64 {
		s := InitialState(0, 0)
		s.CrewY = crewY
		s.BoomSide = -1
		if crewY < 0 {
			s.BoomSide = 1
		}
		hike := 0.0
		if math.Abs(crewY) > crew.SitInOffset {
			hike = 1
		}
		for range 60 * 30 {
			s = Step(s, Controls{Hike: hike}, testBoat, &cfg).State
		}
		return s.Heel
	}
	sitting := settle(-crew.SitInOffset)
	less(t, "sitting heel", sitting, 0) // crew to port heels the boat to port
	less(t, "|righting|", math.Abs(rightingMoment(sitting, -crew.SitInOffset, crew.SitInZAboveHullCg, testBoat)), 1)
}

func TestClampsHeelAtLimit(t *testing.T) {
	cfg := heelOnlyConfig()
	light := *testBoat
	light.Gm = 0.01 // nearly no form stability: the crew alone tips it over
	s := InitialState(0, 0)
	s.CrewY = -1
	for range 60 * 20 {
		s = Step(s, Controls{Hike: 1}, &light, &cfg).State
	}
	closeTo(t, "heel", s.Heel, -testBoat.Cfg.Dynamics.HeelLimitDeg*DEG, 9)
}

func TestUprightWhenHeelLayerOff(t *testing.T) {
	cfg := DefaultConfigUnseeded()
	cfg.Layers.Heel = false
	s := InitialState(0, 0)
	s.CrewY = -0.9
	for range 120 {
		s = Step(s, Controls{Hike: 1}, testBoat, &cfg).State
	}
	equal(t, "heel", s.Heel, 0)
}
