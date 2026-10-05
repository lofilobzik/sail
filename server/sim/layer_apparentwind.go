package sim

import "math"

// L1 Apparent wind (PHYSICS.md L1), src/sim/layers/apparentWind.ts.
//
//	apparentWind = trueWind(position, time) - boatVelocity   (world frame)
//
// then expressed in the body frame as apparent wind speed (AWS) and angle (AWA).

// ApparentWind is the air relative to the boat.
type ApparentWind struct {
	// Air velocity relative to the boat, body frame (where the air moves TO), m/s.
	U float64 `json:"u"`
	V float64 `json:"v"`
	// Apparent wind speed, m/s.
	Speed float64 `json:"speed"`
	// Apparent wind angle, rad, direction the wind comes FROM relative to the bow, + = starboard.
	Angle float64 `json:"angle"`
}

// apparentWind with enabled = false returns the true wind in the body frame (boat velocity
// ignored).
func apparentWind(state *BoatState, trueWind Vec2, enabled bool) ApparentWind {
	wx := trueWind.X
	wz := trueWind.Z
	if enabled {
		boatVel := BodyToWorld(state.Heading, state.U, state.V)
		wx -= boatVel.X
		wz -= boatVel.Z
	}
	u, v := WorldToBody(state.Heading, wx, wz)
	return ApparentWind{U: u, V: v, Speed: jsHypot(u, v), Angle: math.Atan2(-v, -u)}
}
