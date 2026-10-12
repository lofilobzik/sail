package sim

import "math"

// Berth is one mooring of data/bay.json harbour.berths (world x east, z south, m).
type Berth struct {
	X          float64 `json:"x"`
	Z          float64 `json:"z"`
	HeadingDeg float64 `json:"headingDeg"`
	Pontoon    int     `json:"pontoon"`
	// Boat side facing the pontoon: "port" or "starboard".
	Side string `json:"side"`
}

// mooredControls has the sheet fully eased, as a moored boat starts (client MOORED_SHEET).
var mooredControls = Controls{Tiller: 0, Sheet: 1, Hike: 0}

// MooredAt is a boat held at berth b at sim time t (TS mooredAt): Moor of
// InitialState(b.HeadingDeg*DEG, 0) with T, X and Z set.
func MooredAt(b Berth, t float64, boat *BoatModel, cfg *SimConfig) BoatState {
	s := InitialState(b.HeadingDeg*DEG, 0)
	s.T, s.X, s.Z = t, b.X, b.Z
	return Moor(s, boat, cfg)
}

// Moor holds s where it is: Moored and at rest, with the boom already weathervaned where the eased
// sheet lets it go in cfg's wind, as on a boat that has lain at the berth a while (a boom swinging
// out from the centreline would kick the hull into a long roll).
func Moor(s BoatState, boat *BoatModel, cfg *SimConfig) BoatState {
	s.U, s.V, s.R, s.Moored = 0, 0, 0, true
	d := Evaluate(s, mooredControls, boat, cfg)
	s.Boom, s.BoomSide = d.BoomTarget, d.BoomSide
	return s
}

// CastOff releases a moored boat with a small shove (data/bay.json harbour.castOff; TS castOff):
// forward, and away from the pontoon when it lies at a berth (within 0.5 m, TS berthIndexAt).
func CastOff(s BoatState) BoatState {
	push := Bay.Harbour.CastOff
	s.Moored, s.U, s.V = false, push.Forward, 0
	for _, b := range Bay.Harbour.Berths {
		if math.Hypot(b.X-s.X, b.Z-s.Z) <= 0.5 {
			if b.Side == "port" {
				s.V = push.Away
			} else {
				s.V = -push.Away
			}
			break
		}
	}
	return s
}
