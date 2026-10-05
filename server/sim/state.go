package sim

// Controls are normalized, already rate-limited control values (src/sim/state.ts).
type Controls struct {
	// Tiller position -1..1, + = tiller to starboard (boat turns to port).
	Tiller float64 `json:"tiller"`
	// Mainsheet 0..1, 0 = sheeted hard in, 1 = fully eased.
	Sheet float64 `json:"sheet"`
	// Hiking 0..1, 0 = sitting in, 1 = fully hiked.
	Hike float64 `json:"hike"`
}

// BoatState is the integrated state of the boat (src/sim/state.ts).
type BoatState struct {
	// Sim time, s.
	T float64 `json:"t"`
	// World position, m.
	X float64 `json:"x"`
	Z float64 `json:"z"`
	// Compass heading, rad.
	Heading float64 `json:"heading"`
	// Body velocity relative to mean still water, m/s (+u forward, +v starboard).
	U float64 `json:"u"`
	V float64 `json:"v"`
	// Yaw rate, rad/s (+ = bow to starboard).
	R float64 `json:"r"`
	// Heel, rad (+ = starboard rail down), and heel rate.
	Heel float64 `json:"heel"`
	P    float64 `json:"p"`
	// Wave-driven pitch, rad (+ = bow up), and pitch rate, rad/s.
	Pitch     float64 `json:"pitch"`
	PitchRate float64 `json:"pitchRate"`
	// Boom angle from the centreline, rad (+ = boom to starboard).
	Boom float64 `json:"boom"`
	// Side the boom is on: +1 starboard, -1 port. Changes on tacks and gybes.
	BoomSide int `json:"boomSide"`
	// Crew CG offset from the centreline, m (+ = starboard).
	CrewY float64 `json:"crewY"`
}

// InitialState is TS initialState(heading, speed); the TS defaults are 0, 0.
func InitialState(heading, speed float64) BoatState {
	return BoatState{Heading: heading, U: speed, BoomSide: 1}
}

// NeutralControls is TS NEUTRAL_CONTROLS.
var NeutralControls = Controls{Tiller: 0, Sheet: 0.5, Hike: 0}
