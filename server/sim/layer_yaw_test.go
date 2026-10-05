package sim

import (
	"math"
	"testing"
)

// Port of src/sim/layers/yaw.test.ts.

func TestMunkMomentEq14Destabilizing(t *testing.T) {
	cfg := DefaultConfigUnseeded()
	state := InitialState(0, 2)
	state.V = 0.1
	state.Heel = 10 * DEG
	n0 := 0.0002164*testBoat.Mass - 0.014572
	expected := -(math.Pi / 2) * cfg.Env.RhoWater * n0 * (1 + 0.0966 + 0.134) * 2 * 0.1
	closeTo(t, "munk", munkMoment(&state, testBoat, &cfg.Env), expected, 9)
	// Sliding to starboard: the moment turns the bow to port, increasing the drift angle.
	less(t, "munk sign", munkMoment(&state, testBoat, &cfg.Env), 0)
}

func TestTillerTurnsBoatAndYawOffHoldsHeading(t *testing.T) {
	calm := DefaultConfigUnseeded()
	calm.Wind = WindConfig{SpeedKn: 0, FromDeg: 0}
	s := InitialState(0, 2)
	for range 120 {
		s = Step(s, Controls{Tiller: 1}, testBoat, &calm).State
	}
	less(t, "heading", s.Heading, -5*DEG) // tiller to starboard -> turns to port

	off := calm
	off.Layers.Yaw = false
	f := InitialState(0, 2)
	for range 120 {
		f = Step(f, Controls{Tiller: 1}, testBoat, &off).State
	}
	equal(t, "heading held", f.Heading, 0)
	equal(t, "r", f.R, 0)
}

func TestWeatherHelmOnReach(t *testing.T) {
	// Wind from the north, boat heading east (port beam), sheet trimmed, tiller free.
	cfg := DefaultConfigUnseeded()
	s := InitialState(90*DEG, 2)
	s.BoomSide, s.Boom, s.CrewY = 1, 40*DEG, -0.55
	for range 60 * 10 {
		s = Step(s, Controls{Tiller: 0, Sheet: 0.4, Hike: 0.3}, testBoat, &cfg).State
	}
	less(t, "heading", s.Heading, 80*DEG) // turned toward the wind (north)
}
