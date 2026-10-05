package sim

import (
	"math"
	"testing"
)

// Port of src/sim/layers/ground.test.ts.

func TestGroundingStopsBoatAndLetsItSlideOff(t *testing.T) {
	boardTip := testBoat.Tc + testBoat.Board.Span
	// Heading held (yaw off) on a beam reach straight at the east shore of the bay.
	cfg := mustDisable(t, DefaultConfigUnseeded(), "yaw")
	cfg.Land = true
	drive := func(s BoatState, seconds, sheet float64) BoatState {
		for range int(jsRound(seconds / cfg.Dt)) {
			s = Step(s, Controls{Tiller: 0, Sheet: sheet, Hike: 0.5}, testBoat, &cfg).State
		}
		return s
	}

	s := InitialState(90*DEG, 1.5)
	s.X, s.Z, s.BoomSide, s.CrewY = 1700, 0, 1, -0.55
	touched := false
	touch := 0.0
	shallowest := math.Inf(1)
	for range int(jsRound(150 / cfg.Dt)) {
		s = Step(s, Controls{Tiller: 0, Sheet: 0.3, Hike: 0.5}, testBoat, &cfg).State
		depth := -TerrainHeight(s.X, s.Z)
		shallowest = min(shallowest, depth)
		if !touched && depth < boardTip {
			touched, touch = true, s.X
		}
	}
	if !touched {
		t.Fatal("never touched the seabed")
	}
	// The shore runs north-south here: the boat may slide along it, but no longer makes way east.
	less(t, "eastward speed", BodyToWorld(s.Heading, s.U, s.V).X, 0.05)
	less(t, "overrun", s.X-touch, 5)
	greater(t, "shallowest", shallowest, testBoat.Tc) // the hull itself never reaches the beach

	eased := drive(s, 30, 1)
	greater(t, "depth after easing", -TerrainHeight(eased.X, eased.Z), boardTip-0.02)
}
