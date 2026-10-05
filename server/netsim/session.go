package netsim

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"

	"sail/server/sim"
)

// Start of every session and every reset, mirrored from src/main.ts resetBoat.
const (
	StartHeadingDeg = 90 // TUNING GUESS (main.ts START_HEADING_DEG): beam reach for the default wind from 0°
	StartSpeed      = 1  // TUNING GUESS (main.ts START_SPEED): initial boat speed, m/s
)

// Session is one connection's authoritative boat. It is not safe for concurrent use: the
// connection loop owns it and feeds it client messages and ticks in order.
type Session struct {
	seed     uint32
	boat     *sim.BoatModel
	cfg      sim.SimConfig
	state    sim.BoatState
	controls sim.Controls
	tick     int64
	lastSeq  int64 // newest input seq received
	ackSeq   int64 // seq of the input applied on the last tick
}

// NewSession starts a boat at the start position in sim.BrowserConfig(seed).
func NewSession(boat *sim.BoatModel, seed uint32) *Session {
	return &Session{
		seed:     seed,
		boat:     boat,
		cfg:      sim.BrowserConfig(seed),
		state:    startState(),
		controls: sim.NeutralControls, // until the first input
	}
}

func startState() sim.BoatState {
	return sim.InitialState(StartHeadingDeg*math.Pi/180, StartSpeed)
}

// Dt is the fixed step, s.
func (s *Session) Dt() float64 { return s.cfg.Dt }

// Tick is the number of fixed steps run.
func (s *Session) Tick() int64 { return s.tick }

// Welcome describes the session to a newly connected client.
func (s *Session) Welcome(snapshotHz float64) Welcome {
	return Welcome{Type: TypeWelcome, Seed: s.seed, Config: s.cfg, Dt: s.cfg.Dt, Tick: s.tick, State: s.state, SnapshotHz: snapshotHz}
}

// Snapshot is the current authoritative state.
func (s *Session) Snapshot() Snapshot {
	return Snapshot{Type: TypeSnapshot, Tick: s.tick, AckSeq: s.ackSeq, State: s.state, Controls: s.controls}
}

// HandleMessage applies one client message. An error leaves the session unchanged.
func (s *Session) HandleMessage(data []byte) error {
	var m clientMessage
	if err := json.Unmarshal(data, &m); err != nil {
		return fmt.Errorf("bad JSON: %w", err)
	}
	switch m.Type {
	case TypeInput:
		if m.Seq == nil || m.Controls == nil {
			return errors.New("input needs seq and controls")
		}
		if *m.Seq <= s.lastSeq {
			return fmt.Errorf("input seq %d not after %d", *m.Seq, s.lastSeq)
		}
		s.lastSeq = *m.Seq
		s.controls = clampControls(*m.Controls)
	case TypeReset:
		s.state = startState()
	default:
		return fmt.Errorf("unknown message type %q", m.Type)
	}
	return nil
}

// Step runs one fixed step with the newest controls received.
func (s *Session) Step() {
	s.state = sim.Step(s.state, s.controls, s.boat, &s.cfg).State
	s.tick++
	s.ackSeq = s.lastSeq
}

// clampControls clamps like TS step (src/sim/step.ts), so snapshots report the controls as applied.
func clampControls(c sim.Controls) sim.Controls {
	return sim.Controls{
		Tiller: math.Min(1, math.Max(-1, c.Tiller)),
		Sheet:  math.Min(1, math.Max(0, c.Sheet)),
		Hike:   math.Min(1, math.Max(0, c.Hike)),
	}
}
