package netsim

import (
	"context"
	"testing"
	"time"

	"github.com/coder/websocket"

	"sail/server/sim"
	"sail/server/store"
)

// A sailor code whose boat is gone starts its next boat where the last one left, at rest.
func TestNewBoatStartsAtLastPosition(t *testing.T) {
	st := openStore(t)
	tr := startRoom(t, RoomConfig{Store: st})
	c := tr.dialAs("", codeA)
	w := tr.welcome(c)
	spawn := w.State
	tr.visit(w.Resume, -1600, 700)
	c.Close(websocket.StatusNormalClosure, "bye")

	var pos store.Position
	tr.settle(func() bool {
		p, ok, err := st.LastPosition(context.Background(), codeA)
		if err != nil {
			t.Fatal(err)
		}
		pos = p
		return ok
	})
	if pos.X != -1600 || pos.Z != 700 {
		t.Fatalf("saved %+v", pos)
	}

	tr.clock.Advance(DefaultResumeGrace + time.Second) // the parked boat is gone
	back := tr.welcomeAs("", codeA)                    // a new boat
	if back.Resumed || back.ID == w.ID {
		t.Fatalf("resumed %v id %d", back.Resumed, back.ID)
	}
	want := sim.InitialState(pos.Heading, StartSpeed)
	want.T, want.X, want.Z = back.State.T, pos.X, pos.Z
	if back.State != want {
		t.Fatalf("new boat %+v, want %+v", back.State, want)
	}

	// Another code, and no code at all, still start at a spawn slot.
	for _, player := range []string{codeB, ""} {
		other := tr.welcomeAs("", player)
		if dx, dz := other.State.X-spawn.X, other.State.Z-spawn.Z; dx*dx+dz*dz > spawnSpacing*spawnSpacing*16 {
			t.Fatalf("player %q started at %v, %v, far from the spawn grid", player, other.State.X, other.State.Z)
		}
	}
}

// A server shutting down keeps where every sailing boat was.
func TestShutdownSavesPositions(t *testing.T) {
	st := openStore(t)
	room := NewRoom(RoomConfig{Seed: testSeed, Log: quiet, Store: st})
	ctx, stop := context.WithCancel(context.Background())
	go room.Run(ctx)
	p := room.resolve(context.Background(), codeA)
	done := make(chan struct{})
	room.do(context.Background(), func() {
		b := room.join("", "a", p).member.boat
		b.state.X, b.state.Z, b.state.Heading = -1500, 650, 2
		close(done)
	})
	<-done
	stop()
	waited := make(chan struct{})
	go func() { room.WaitWrites(); close(waited) }()
	select {
	case <-waited:
	case <-time.After(5 * time.Second):
		t.Fatal("writes did not finish")
	}
	pos, ok, err := st.LastPosition(context.Background(), codeA)
	if err != nil || !ok || pos != (store.Position{X: -1500, Z: 650, Heading: 2}) {
		t.Fatalf("position %+v %v %v", pos, ok, err)
	}
}

// One boat per sailor code: another connection with the code (another tab, a reload, another
// browser) takes the boat over, sailing or parked; the replaced connection is closed.
func TestSameCodeTakesOverBoat(t *testing.T) {
	st := openStore(t)
	tr := startRoom(t, RoomConfig{Store: st})
	first := tr.dialAs("", codeA)
	w1 := tr.welcome(first)
	tr.visit(w1.Resume, -1600, 700)

	second := tr.dialAs("", codeA)
	w2 := tr.welcome(second)
	if !w2.Resumed || w2.ID != w1.ID || w2.Resume != w1.Resume || w2.State.X != -1600 {
		t.Fatalf("second tab: resumed %v id %d (want %d) at x %v", w2.Resumed, w2.ID, w1.ID, w2.State.X)
	}
	for {
		if _, _, err := first.Read(tr.ctx); err != nil {
			if websocket.CloseStatus(err) != StatusReplaced {
				t.Fatalf("first tab closed with %v, want replaced", err)
			}
			break
		}
	}

	// Parked (the tab was closed or reloaded): the code still finds the boat within the grace.
	second.Close(websocket.StatusNormalClosure, "reload")
	tr.settle(func() bool {
		parked := false
		done := make(chan struct{})
		tr.room.do(tr.ctx, func() { b := tr.room.byToken[w1.Resume]; parked = b != nil && b.member == nil; close(done) })
		<-done
		return parked
	})
	if w3 := tr.welcomeAs("", codeA); !w3.Resumed || w3.ID != w1.ID {
		t.Fatalf("reload: resumed %v id %d, want boat %d", w3.Resumed, w3.ID, w1.ID)
	}

	// Other codes and connections without a code get boats of their own.
	for _, player := range []string{codeB, ""} {
		if w := tr.welcomeAs("", player); w.ID == w1.ID {
			t.Fatalf("player %q got boat %d", player, w.ID)
		}
	}
}
