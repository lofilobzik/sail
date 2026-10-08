// Package netsim is the server side of the WebSocket protocol: one public Room per process in which
// every connection sails its own authoritative boat, all stepped together at the sim's fixed
// timestep, with snapshots of the whole room sent back to every client.
//
// Protocol (JSON text frames on /ws; the connect URL may carry ?resume=<token> and ?player=<sailor code>):
//
//	server → client  {"type":"welcome","id","resume","resumed","seed","config","dt","tick","state","snapshotHz","challenges"?}  once, on connect
//	server → client  {"type":"snapshot","tick","ackSeq","state","controls","boats":[RemoteBoat]}            at snapshotHz
//	server → client  {"type":"challenges","challenges":[ChallengeStatus]}                                    after a visit is stored (only with a valid ?player and -db)
//	server → client  {"type":"error","message"}                                                              rejected message, or "room full" (then close 1013)
//	client → server  {"type":"input","seq","controls":{"tiller","sheet","hike"}}                             once per client fixed step
//	client → server  {"type":"reset"}                                                                        boat back to a free spawn slot
//
// Input seq order is per connection: on every (re)connect the boat's newest seq and ackSeq restart at 0.
// A connection whose boat was resumed by a newer connection (by ?resume, or by the same ?player code:
// one boat per sailor code) is closed with code 4000 "replaced".
package netsim

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/coder/websocket"

	"sail/server/sim"
)

// Message types.
const (
	TypeWelcome    = "welcome"
	TypeSnapshot   = "snapshot"
	TypeError      = "error"
	TypeChallenges = "challenges"
	TypeInput      = "input"
	TypeReset      = "reset"
)

// Close codes and messages beyond the error frames.
const (
	// MessageRoomFull is the error sent before closing with StatusRoomFull.
	MessageRoomFull = "room full"
	// StatusRoomFull closes a connection that found the room at -max-boats.
	StatusRoomFull = websocket.StatusTryAgainLater
	// StatusReplaced closes a connection whose boat another connection resumed.
	StatusReplaced websocket.StatusCode = 4000
)

// Welcome is sent once when a client connects: everything it needs to predict the same world.
// Resume is the token for ?resume= on a reconnect; Resumed is true when this connection
// re-attached an earlier boat from ?resume (false for a new boat, also for an unknown or expired token).
type Welcome struct {
	Type       string        `json:"type"`
	ID         int           `json:"id"`
	Resume     string        `json:"resume"`
	Resumed    bool          `json:"resumed"`
	Seed       uint32        `json:"seed"`
	Config     sim.SimConfig `json:"config"`
	Dt         float64       `json:"dt"`
	Tick       int64         `json:"tick"`
	State      sim.BoatState `json:"state"`
	SnapshotHz float64       `json:"snapshotHz"`
	// Challenges is the player's stored progress; absent when challenges are unavailable on this connection.
	Challenges []ChallengeStatus `json:"challenges,omitempty"`
}

// Snapshot is the authoritative state after Tick fixed steps. AckSeq is the seq of the input applied
// on the last tick (0 before any input on this connection); Controls are the clamped controls that
// tick used. Boats holds every other boat in the room at the same tick.
type Snapshot struct {
	Type     string        `json:"type"`
	Tick     int64         `json:"tick"`
	AckSeq   int64         `json:"ackSeq"`
	State    sim.BoatState `json:"state"`
	Controls sim.Controls  `json:"controls"`
	Boats    []RemoteBoat  `json:"boats"`
}

// snapshotFrame is Snapshot as the room encodes it: Boats is the pre-encoded JSON array, so each
// boat is encoded once per snapshot rather than once per receiver.
type snapshotFrame struct {
	Type     string          `json:"type"`
	Tick     int64           `json:"tick"`
	AckSeq   int64           `json:"ackSeq"`
	State    sim.BoatState   `json:"state"`
	Controls sim.Controls    `json:"controls"`
	Boats    json.RawMessage `json:"boats"`
}

// RemoteBoat is another boat's pose at the snapshot's tick, for drawing it: BoatState fields, the
// applied (clamped) controls and the sail diagnostics of its last step.
type RemoteBoat struct {
	ID          int     `json:"id"`
	X           float64 `json:"x"`
	Z           float64 `json:"z"`
	Heading     float64 `json:"heading"`
	U           float64 `json:"u"`
	Heel        float64 `json:"heel"`
	Pitch       float64 `json:"pitch"`
	Boom        float64 `json:"boom"`
	CrewY       float64 `json:"crewY"`
	Tiller      float64 `json:"tiller"`
	Sheet       float64 `json:"sheet"`
	ApparentU   float64 `json:"apparentU"`
	ApparentV   float64 `json:"apparentV"`
	LuffAmount  float64 `json:"luffAmount"`
	StallAmount float64 `json:"stallAmount"`
}

// ErrorMessage reports a rejected client message (the connection stays open) or a full room.
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

// parseClientMessage decodes and checks one client frame. lastSeq is the newest input seq accepted
// on this connection; an input must come after it.
func parseClientMessage(data []byte, lastSeq int64) (clientMessage, error) {
	var m clientMessage
	if err := json.Unmarshal(data, &m); err != nil {
		return m, fmt.Errorf("bad JSON: %w", err)
	}
	switch m.Type {
	case TypeInput:
		if m.Seq == nil || m.Controls == nil {
			return m, errors.New("input needs seq and controls")
		}
		if *m.Seq <= lastSeq {
			return m, fmt.Errorf("input seq %d not after %d", *m.Seq, lastSeq)
		}
	case TypeReset:
	default:
		return m, fmt.Errorf("unknown message type %q", m.Type)
	}
	return m, nil
}

// ChallengeStatus is one challenge's stored progress; CompletedAt is unix ms, absent until complete.
type ChallengeStatus struct {
	ID          string   `json:"id"`
	Steps       []string `json:"steps"`
	Total       int      `json:"total"`
	CompletedAt int64    `json:"completedAt,omitempty"`
}

// ChallengesMessage reports progress after a visit has been stored.
type ChallengesMessage struct {
	Type       string            `json:"type"`
	Challenges []ChallengeStatus `json:"challenges"`
}
