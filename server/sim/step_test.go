package sim

import (
	"math"
	"strings"
	"testing"
)

// Port of src/sim/step.test.ts.

func runSteps(cfg *SimConfig, s BoatState, seconds, sheet float64) BoatState {
	n := int(jsRound(seconds / cfg.Dt))
	for range n {
		s = Step(s, Controls{Tiller: 0, Sheet: sheet, Hike: 0.3}, testBoat, cfg).State
	}
	return s
}

func speedOf(s BoatState) float64 { return math.Hypot(s.U, s.V) }

func TestSettlesAndStaysStillInZeroWind(t *testing.T) {
	cfg := DefaultConfigUnseeded()
	cfg.Wind = WindConfig{SpeedKn: 0, FromDeg: 0}
	// With the sail luffing in no wind the sailor sits at the centreline, so the boat should not
	// move at all; with luff-centring off the sailor's offset heeled and nudged it, and the
	// residual drift decayed slowly.
	settled := runSteps(&cfg, InitialState(0, 0), 120, 0.3)
	later := runSteps(&cfg, settled, 30, 0.3)
	less(t, "speed(settled)", speedOf(settled), 5e-3)
	lessEq(t, "speed(later)", speedOf(later), speedOf(settled))
	// Heeled by the sailor's weight, the hull's zero-lift drift turns the creeping boat very slowly.
	less(t, "|later.r|", math.Abs(later.R), 1e-4)
	less(t, "|later.p|", math.Abs(later.P), 1e-6)
	less(t, "|heel change|", math.Abs(later.Heel-settled.Heel), 1e-5)
}

func TestOnlyLosesEnergyWhenCoastingInCalmAir(t *testing.T) {
	// Heel off: the sailor shifting weight is an internal energy source, not a leak.
	cfg := mustDisable(t, DefaultConfigUnseeded(), "heel")
	cfg.Wind = WindConfig{SpeedKn: 0, FromDeg: 0}
	s := InitialState(0, 2)
	prev := math.Inf(1)
	for i := range 60 * 20 {
		s = Step(s, Controls{Tiller: 0, Sheet: 0, Hike: 0}, testBoat, &cfg).State
		ke := s.U*s.U + s.V*s.V
		if !(ke <= prev+1e-12) {
			t.Fatalf("step %d: kinetic energy rose from %g to %g", i, prev, ke)
		}
		prev = ke
	}
}

func TestSameSteadySpeedAtHalfTimestep(t *testing.T) {
	// Heading held (yaw off) on a beam reach so the comparison is not about steering.
	base := mustDisable(t, DefaultConfigUnseeded(), "yaw")
	start := InitialState(90*DEG, 1.5)
	start.BoomSide = 1
	start.CrewY = -0.55
	coarse := runSteps(&base, start, 120, 0.3)
	half := base
	half.Dt = base.Dt / 2
	fine := runSteps(&half, start, 120, 0.3)
	greater(t, "coarse.u", coarse.U, 1*KNOT)
	less(t, "relative speed difference", math.Abs(coarse.U-fine.U)/fine.U, 0.01)
	less(t, "heel difference", math.Abs(coarse.Heel-fine.Heel), 0.2*DEG)
}

func TestDoesNotPropelItselfWithSailOff(t *testing.T) {
	// Regression: the boom flicking across the centreline used to send the sailor from
	// side to side, and the resulting roll pumping drove the boat at ~3 kn forever.
	cfg := mustDisable(t, DefaultConfigUnseeded(), "sail", "apparentWind")
	s := InitialState(0, 3*KNOT)
	for range 60 * 60 {
		s = Step(s, Controls{Tiller: 0, Sheet: 0.5, Hike: 0}, testBoat, &cfg).State
	}
	less(t, "speed", math.Hypot(s.U, s.V), 1*KNOT)
}

func TestRejectsUnknownLayerNames(t *testing.T) {
	_, err := WithDisabledLayers(DefaultConfigUnseeded(), []string{"sails"})
	if err == nil || !strings.Contains(err.Error(), "unknown layer") {
		t.Fatalf("got error %v, want unknown layer", err)
	}
}

func TestGetWindBlowsFromConfiguredDirection(t *testing.T) {
	w := GetWind(Vec2{}, 0, &WindConfig{SpeedKn: 10, FromDeg: 0})
	closeTo(t, "w.x", w.X, 0, 12)
	closeTo(t, "w.z", w.Z, 10*KNOT, 12) // from the north toward +z (south)
}
