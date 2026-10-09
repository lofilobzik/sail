package netsim

import "sail/server/sim"

// track sets b.near from the server's own boat state: per buoy of sim.BuoyData, whether b is within
// its proximity radius. Every boat is tracked, with or without a sailor code; consumers (the buoy
// tour in challenges.go) read b.near after it. Recomputed in full on every call, so a respawn,
// resume or takeover never leaves it stale.
func (r *Room) track(b *roomBoat) {
	buoys := sim.BuoyData.Buoys
	if b.near == nil {
		b.near = make([]bool, len(buoys))
	}
	r2 := sim.BuoyData.ProximityRadius * sim.BuoyData.ProximityRadius
	for i, buoy := range buoys {
		dx, dz := buoy.X-b.state.X, buoy.Z-b.state.Z
		b.near[i] = dx*dx+dz*dz <= r2
	}
}
