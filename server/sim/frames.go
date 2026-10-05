// Package sim is the Go port of the authoritative sailing simulation in src/sim (TypeScript).
// The TypeScript files are the reference: each Go file names its source and keeps its comments and
// sources (Day 2017 equations, TUNING GUESS notes). Go and TypeScript agree within the golden-trace
// tolerances in golden_test.go; they are not bit-identical (sin/exp/atan2/pow differ in the last ulps
// between V8 and Go).
package sim

import "math"

// Frame conventions (src/sim/frames.ts). The single place where compass angles map to world axes.
//
// World: right-handed, Three.js-compatible, y up. Horizontal plane is x-z.
//
//	North = -z, East = +x.
//	A compass bearing theta (radians, clockwise from north) points along
//	(sin theta, 0, -cos theta).
//
// Body (horizontal plane, heel ignored):
//
//	+x forward (surge u), +y to starboard (sway v), +z up.
//	Yaw rate r > 0 turns the bow to starboard (clockwise seen from above).
//	Heel phi > 0 puts the starboard rail down.
//
// Angles relative to the bow (e.g. apparent wind angle) are measured from the
// bow, positive to starboard, in (-pi, pi].

// Constant expressions in Go are exact; JavaScript rounds every operation. DEG is written so the
// constant equals the double Math.PI / 180 (one division of the rounded pi, rounded once).
const (
	pi   = float64(math.Pi)
	DEG  = pi / 180
	KNOT = 1852.0 / 3600 // m/s per knot
	G    = 9.81          // m/s^2, standard gravity
)

// Vec2 is a vector in the world x-z plane.
type Vec2 struct {
	X float64 `json:"x"`
	Z float64 `json:"z"`
}

// BearingToWorld is the unit vector in the world x-z plane for a compass bearing (radians).
func BearingToWorld(bearing float64) Vec2 {
	return Vec2{X: math.Sin(bearing), Z: -math.Cos(bearing)}
}

// WorldToBearing is the compass bearing (radians, [0, 2pi)) of a world x-z vector.
func WorldToBearing(x, z float64) float64 {
	return Wrap2Pi(math.Atan2(x, -z))
}

// StarboardWorld is the body starboard unit vector in world coordinates (the forward vector is
// BearingToWorld(heading)).
func StarboardWorld(heading float64) Vec2 {
	return Vec2{X: math.Cos(heading), Z: math.Sin(heading)}
}

// WorldToBody converts a world x-z vector to body (forward, starboard) components.
func WorldToBody(heading, x, z float64) (u, v float64) {
	f := BearingToWorld(heading)
	s := StarboardWorld(heading)
	return x*f.X + z*f.Z, x*s.X + z*s.Z
}

// BodyToWorld converts body (forward, starboard) components to a world x-z vector.
func BodyToWorld(heading, u, v float64) Vec2 {
	f := BearingToWorld(heading)
	s := StarboardWorld(heading)
	return Vec2{X: u*f.X + v*s.X, Z: u*f.Z + v*s.Z}
}

// WrapPi wraps an angle to (-pi, pi].
func WrapPi(a float64) float64 {
	t := math.Mod(a+math.Pi, 2*math.Pi)
	if t <= 0 {
		t += 2 * math.Pi
	}
	return t - math.Pi
}

// Wrap2Pi wraps an angle to [0, 2pi).
func Wrap2Pi(a float64) float64 {
	t := math.Mod(a, 2*math.Pi)
	if t < 0 {
		return t + 2*math.Pi
	}
	return t
}

// Clamp limits x to [lo, hi].
func Clamp(x, lo, hi float64) float64 {
	if x < lo {
		return lo
	}
	if x > hi {
		return hi
	}
	return x
}
