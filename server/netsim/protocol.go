// Package netsim is the server side of the WebSocket protocol: one authoritative boat per
// connection, stepped at the sim's fixed timestep, with snapshots sent back to the client.
//
// Protocol (JSON text frames on /ws):
//
//	server → client  {"type":"welcome","seed","config","dt","tick","state","snapshotHz"}  once, on connect
//	server → client  {"type":"snapshot","tick","ackSeq","state","controls"}                at snapshotHz
//	server → client  {"type":"error","message"}                                            for a rejected message
//	client → server  {"type":"input","seq","controls":{"tiller","sheet","hike"}}           once per client fixed step
//	client → server  {"type":"reset"}                                                      boat back to the start
package netsim

import "sail/server/sim"

// Message types.
const (
	TypeWelcome  = "welcome"
	TypeSnapshot = "snapshot"
	TypeError    = "error"
	TypeInput    = "input"
	TypeReset    = "reset"
)

// Welcome is sent once when a client connects: everything it needs to predict the same world.
type Welcome struct {
	Type       string        `json:"type"`
	Seed       uint32        `json:"seed"`
	Config     sim.SimConfig `json:"config"`
	Dt         float64       `json:"dt"`
	Tick       int64         `json:"tick"`
	State      sim.BoatState `json:"state"`
	SnapshotHz float64       `json:"snapshotHz"`
}

// Snapshot is the authoritative state after Tick fixed steps. AckSeq is the seq of the input applied
// on the last tick (0 before any input); Controls are the clamped controls that tick used.
type Snapshot struct {
	Type     string        `json:"type"`
	Tick     int64         `json:"tick"`
	AckSeq   int64         `json:"ackSeq"`
	State    sim.BoatState `json:"state"`
	Controls sim.Controls  `json:"controls"`
}

// ErrorMessage reports a rejected client message; the connection stays open.
type ErrorMessage struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

// clientMessage is any client → server message; fields unused by Type are ignored.
type clientMessage struct {
	Type     string        `json:"type"`
	Seq      *int64        `json:"seq"`
	Controls *sim.Controls `json:"controls"`
}
