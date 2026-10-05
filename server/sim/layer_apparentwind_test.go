package sim

import (
	"math"
	"testing"
)

// Port of src/sim/layers/apparentWind.test.ts.

func windFrom(fromDeg, speedKn float64) Vec2 {
	return GetWind(Vec2{}, 0, &WindConfig{FromDeg: fromDeg, SpeedKn: speedKn})
}

func TestApparentWindAtRestFromBow(t *testing.T) {
	state := InitialState(0, 0)                        // heading north
	aw := apparentWind(&state, windFrom(90, 10), true) // wind from the east = starboard beam
	closeTo(t, "angle", aw.Angle/DEG, 90, 9)
	closeTo(t, "speed", aw.Speed, 10*0.514444, 4)
	port := apparentWind(&state, windFrom(270, 10), true)
	closeTo(t, "port angle", port.Angle/DEG, -90, 9)
}

func TestApparentWindAddsBoatSpeedHeadToWind(t *testing.T) {
	trueWind := windFrom(0, 0)
	state := InitialState(0, 2)                                              // heading into a calm at 2 m/s
	aw := apparentWind(&state, Vec2{X: trueWind.X, Z: trueWind.Z + 3}, true) // 3 m/s from the north
	closeTo(t, "speed", aw.Speed, 5, 9)
	closeTo(t, "angle", aw.Angle, 0, 9)
}

func TestApparentWindMovesForwardOnBeamReach(t *testing.T) {
	state := InitialState(90*DEG, 2) // heading east, wind from the north (port beam)
	aw := apparentWind(&state, windFrom(0, 7), true)
	less(t, "angle", aw.Angle, 0)
	less(t, "|angle|", math.Abs(aw.Angle), 90*DEG)
	greater(t, "speed", aw.Speed, 7*0.514444)
}

func TestApparentWindIgnoresBoatWhenDisabled(t *testing.T) {
	state := InitialState(90*DEG, 2)
	aw := apparentWind(&state, windFrom(0, 7), false)
	closeTo(t, "angle", aw.Angle/DEG, -90, 9)
	closeTo(t, "speed", aw.Speed, 7*0.514444, 4)
}
