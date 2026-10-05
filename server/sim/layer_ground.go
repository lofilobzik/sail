package sim

// Grounding on the bay's seabed (data/bay.json `grounding`, all TUNING GUESS),
// src/sim/layers/ground.ts.
//
// The boat touches when the seabed under it is shallower than the daggerboard tip
// (canoe-body draft Tc plus board span). Penetration p (m, capped) then
//   - pushes the boat toward deeper water: F = k p, down the seabed gradient,
//   - damps its motion through the water: F = -c p V, and yaw: N = -c_r p r.
//
// There is no board kick-up, heel-on-the-bottom or keel contact geometry: this is a playable
// soft stop, so the boat comes to rest in the shallows where the sail's drive balances the push
// and slides back off when the sheet is eased or it is turned away. Waves are ignored.

// GroundResult is the grounding output.
type GroundResult struct {
	// Water depth under the boat, m (negative on dry land).
	Depth float64 `json:"depth"`
	// How far the board tip would be below the seabed, m; 0 when afloat.
	Penetration float64 `json:"penetration"`
	// Body-frame force, N, and yaw moment, N m.
	Fx        float64 `json:"fx"`
	Fy        float64 `json:"fy"`
	YawMoment float64 `json:"yawMoment"`
}

func groundForces(state *BoatState, boat *BoatModel) GroundResult {
	g := &Bay.Grounding
	depth := -TerrainHeight(state.X, state.Z)
	penetration := min(max(boat.Tc+boat.Board.Span-depth, 0), g.MaxPenetration)
	if penetration == 0 {
		return GroundResult{Depth: depth, Penetration: penetration}
	}
	slope := TerrainGradient(state.X, state.Z)
	length := jsHypot(slope.X, slope.Z)
	// Down the slope is toward deeper water; flat ground gives no direction to push.
	push := 0.0
	if length > 1e-6 {
		push = g.PushStiffness * penetration / length
	}
	velocity := BodyToWorld(state.Heading, state.U, state.V)
	damping := g.Damping * penetration
	u, v := WorldToBody(state.Heading, -slope.X*push-velocity.X*damping, -slope.Z*push-velocity.Z*damping)
	return GroundResult{Depth: depth, Penetration: penetration, Fx: u, Fy: v, YawMoment: -g.YawDamping * penetration * state.R}
}
