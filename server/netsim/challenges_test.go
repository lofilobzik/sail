package netsim

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"sail/server/sim"
	"sail/server/store"
)

const (
	codeA = "AAAAAAAAAAAAAAAAAAAA"
	codeB = "BBBBBBBBBBBBBBBBBBBB"
)

var tourID = sim.ChallengeParams.BuoyTour.ID

func openStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

// hookStore wraps a Store to inject latency, failures and blocking into RecordStep.
type hookStore struct {
	Store
	before func(code, step string) error
	after  func(code, step string)
}

func (h hookStore) RecordStep(ctx context.Context, code, challenge, step string, total int, at time.Time) (store.Challenge, error) {
	if h.after != nil {
		defer h.after(code, step)
	}
	if h.before != nil {
		if err := h.before(code, step); err != nil {
			return store.Challenge{}, err
		}
	}
	return h.Store.RecordStep(ctx, code, challenge, step, total, at)
}

// visit moves the boat with token to (x, z) on the room goroutine and observes it there.
func (tr *testRoom) visit(token string, x, z float64) {
	tr.t.Helper()
	done := make(chan struct{})
	if !tr.room.do(tr.ctx, func() {
		b := tr.room.byToken[token]
		b.state.X, b.state.Z = x, z
		tr.room.observe(b)
		close(done)
	}) {
		tr.t.Fatal("room ended")
	}
	<-done
}

// onBuoy visits buoy i exactly.
func (tr *testRoom) onBuoy(token string, i int) {
	tr.t.Helper()
	tr.visit(token, sim.BuoyData.Buoys[i].X, sim.BuoyData.Buoys[i].Z)
}

// challengesFrame reads until a challenges frame, skipping snapshots.
func (tr *testRoom) challengesFrame(c *websocket.Conn) ChallengeStatus {
	tr.t.Helper()
	for {
		typ, data := tr.message(c)
		switch typ {
		case TypeSnapshot:
		case TypeChallenges:
			var m ChallengesMessage
			if err := json.Unmarshal(data, &m); err != nil || len(m.Challenges) != 1 {
				tr.t.Fatalf("bad challenges frame %s: %v", data, err)
			}
			return m.Challenges[0]
		default:
			tr.t.Fatalf("unexpected %s", data)
		}
	}
}

// noChallengesFrame reads n frames and fails on a challenges frame.
func (tr *testRoom) noChallengesFrame(c *websocket.Conn, n int) {
	tr.t.Helper()
	for range n {
		if typ, data := tr.message(c); typ == TypeChallenges {
			tr.t.Fatalf("unexpected challenges frame %s", data)
		}
	}
}

func (tr *testRoom) welcomeAs(token, player string) Welcome {
	tr.t.Helper()
	return tr.welcome(tr.dialAs(token, player))
}

func stepsOf(t *testing.T, st Store, code string) []string {
	t.Helper()
	p, err := st.Progress(context.Background(), code)
	if err != nil {
		t.Fatal(err)
	}
	return p[tourID].Steps
}

func TestBuoyTourPersists(t *testing.T) {
	st := openStore(t)
	tr := startRoom(t, RoomConfig{Store: st})
	c := tr.dialAs("", codeA)
	w := tr.welcome(c)
	if len(w.Challenges) != 1 || w.Challenges[0].ID != "buoy-tour" || w.Challenges[0].Total != 5 || len(w.Challenges[0].Steps) != 0 {
		t.Fatalf("welcome challenges = %+v", w.Challenges)
	}
	buoys := sim.BuoyData.Buoys
	var names []string
	for i, b := range buoys {
		tr.onBuoy(w.Resume, i)
		names = append(names, b.Name)
		got := tr.challengesFrame(c)
		if !slices.Equal(got.Steps, names) {
			t.Fatalf("after %s: steps %v, want %v", b.Name, got.Steps, names)
		}
		if done := got.CompletedAt > 0; done != (i == len(buoys)-1) {
			t.Fatalf("after %s: completedAt %d", b.Name, got.CompletedAt)
		}
		tr.clock.Advance(time.Second)
		w2 := tr.welcomeAs("", codeA) // a fresh connection sees the stored progress
		if !slices.Equal(w2.Challenges[0].Steps, names) {
			t.Fatalf("persisted steps %v, want %v", w2.Challenges[0].Steps, names)
		}
	}
}

func TestOutsideRadiusAndNoPlayerRecordNothing(t *testing.T) {
	st := openStore(t)
	tr := startRoom(t, RoomConfig{Store: st})
	b := sim.BuoyData.Buoys[0]
	r := sim.ChallengeParams.BuoyTour.Radius

	w := tr.welcomeAs("", codeA)
	tr.visit(w.Resume, b.X+r+1, b.Z)
	for _, player := range []string{"", "not-a-code"} {
		w := tr.welcomeAs("", player)
		if w.Challenges != nil {
			t.Fatalf("player %q got challenges %+v", player, w.Challenges)
		}
		tr.onBuoy(w.Resume, 0)
	}
	// Everything above is queued before this round trip; a write would be queued by now.
	time.Sleep(100 * time.Millisecond)
	if got := stepsOf(t, st, codeA); len(got) != 0 {
		t.Fatalf("steps %v", got)
	}
	var n int
	done := make(chan struct{})
	tr.room.do(tr.ctx, func() { n = len(tr.room.byToken); close(done) })
	<-done
	if n != 3 {
		t.Fatalf("boats %d", n)
	}
	// Exactly at the radius counts.
	c := tr.dialAs(w.Resume, codeA)
	tr.welcome(c)
	tr.visit(w.Resume, b.X+r, b.Z)
	if got := tr.challengesFrame(c); len(got.Steps) != 1 {
		t.Fatalf("steps %v", got.Steps)
	}
}

func TestSavesStayInDetectionOrder(t *testing.T) {
	st := openStore(t)
	slow := hookStore{Store: st, before: func(_, step string) error {
		if step == "N" {
			time.Sleep(80 * time.Millisecond)
		}
		return nil
	}}
	tr := startRoom(t, RoomConfig{Store: slow})
	c := tr.dialAs("", codeA)
	w := tr.welcome(c)
	tr.clock.Advance(time.Second)
	tr.onBuoy(w.Resume, 0)
	tr.clock.Advance(time.Second)
	tr.onBuoy(w.Resume, 1)
	if got := tr.challengesFrame(c); !slices.Equal(got.Steps, []string{"N"}) {
		t.Fatalf("first frame %v", got.Steps)
	}
	if got := tr.challengesFrame(c); !slices.Equal(got.Steps, []string{"N", "NE"}) {
		t.Fatalf("second frame %v", got.Steps)
	}
}

// settle advances the fake clock past the retry delay until cond holds.
func (tr *testRoom) settle(cond func() bool) {
	tr.t.Helper()
	for range 500 {
		if cond() {
			return
		}
		tr.clock.Advance(saveRetryDelay)
		time.Sleep(20 * time.Millisecond)
	}
	tr.t.Fatal("condition not reached")
}

func TestFailedSaveIsRetried(t *testing.T) {
	st := openStore(t)
	var calls atomic.Int32
	flaky := hookStore{Store: st, before: func(_, _ string) error {
		if calls.Add(1) <= 2 {
			return errors.New("disk on fire")
		}
		return nil
	}}
	tr := startRoom(t, RoomConfig{Store: flaky})
	c := tr.dialAs("", codeA)
	w := tr.welcome(c)
	tr.onBuoy(w.Resume, 0)
	tr.visit(w.Resume, 0, 0) // leaving the radius must not matter
	tr.settle(func() bool { return calls.Load() >= 3 })
	if got := tr.challengesFrame(c); !slices.Equal(got.Steps, []string{"N"}) {
		t.Fatalf("frame %v", got.Steps)
	}
	if got := stepsOf(t, st, codeA); !slices.Equal(got, []string{"N"}) {
		t.Fatalf("stored %v", got)
	}
	if calls.Load() != 3 {
		t.Fatalf("calls %d", calls.Load())
	}
}

func TestRetrySurvivesReconnect(t *testing.T) {
	st := openStore(t)
	var failing atomic.Bool
	failing.Store(true)
	var calls atomic.Int32
	flaky := hookStore{Store: st, before: func(_, _ string) error {
		calls.Add(1)
		if failing.Load() {
			return errors.New("disk on fire")
		}
		return nil
	}}
	tr := startRoom(t, RoomConfig{Store: flaky})
	w := tr.welcomeAs("", codeA)
	tr.onBuoy(w.Resume, 0)
	tr.settle(func() bool { return calls.Load() >= 1 })

	c := tr.dialAs(w.Resume, codeA)
	w2 := tr.welcome(c)
	if !w2.Resumed || len(w2.Challenges[0].Steps) != 0 {
		t.Fatalf("resumed %v, challenges %+v", w2.Resumed, w2.Challenges)
	}
	failing.Store(false)
	tr.settle(func() bool { return len(stepsOf(t, st, codeA)) == 1 })
	if got := tr.challengesFrame(c); !slices.Equal(got.Steps, []string{"N"}) {
		t.Fatalf("frame %v", got.Steps)
	}
}

func TestUnsavedVisitExpiresWithBoat(t *testing.T) {
	st := openStore(t)
	var calls atomic.Int32
	down := hookStore{Store: st, before: func(_, _ string) error {
		calls.Add(1)
		return errors.New("disk on fire")
	}}
	tr := startRoom(t, RoomConfig{Store: down, ResumeGrace: time.Minute})
	c := tr.dialAs("", codeA)
	w := tr.welcome(c)
	tr.onBuoy(w.Resume, 0)
	tr.settle(func() bool { return calls.Load() >= 1 })
	c.Close(websocket.StatusNormalClosure, "bye")
	gone := func() bool {
		var ok bool
		done := make(chan struct{})
		tr.room.do(tr.ctx, func() { _, has := tr.room.byToken[w.Resume]; ok = !has; close(done) })
		<-done
		return ok
	}
	// Retries keep failing while parked; once the grace has passed the boat is forgotten.
	tr.settle(gone)
	if got := stepsOf(t, st, codeA); len(got) != 0 {
		t.Fatalf("stored %v", got)
	}
	if w := tr.welcomeAs("", codeA); len(w.Challenges[0].Steps) != 0 {
		t.Fatalf("steps %v", w.Challenges[0].Steps)
	}
}

func TestStaleSaveCallbackIgnored(t *testing.T) {
	st := openStore(t)
	var mu sync.Mutex
	gate := map[string]chan struct{}{codeA: make(chan struct{}), codeB: make(chan struct{})}
	started := map[string]chan struct{}{codeA: make(chan struct{}, 4), codeB: make(chan struct{}, 4)}
	returned := map[string]chan struct{}{codeA: make(chan struct{}, 4), codeB: make(chan struct{}, 4)}
	hooked := hookStore{Store: st,
		before: func(code, _ string) error {
			mu.Lock()
			g, s := gate[code], started[code]
			mu.Unlock()
			s <- struct{}{}
			<-g
			return nil
		},
		after: func(code, _ string) { returned[code] <- struct{}{} },
	}
	tr := startRoom(t, RoomConfig{Store: hooked})
	w := tr.welcomeAs("", codeA)
	tr.onBuoy(w.Resume, 0)
	<-started[codeA] // A's job is in flight, the writer is blocked

	c := tr.dialAs(w.Resume, codeB)
	w2 := tr.welcome(c)
	if !w2.Resumed || len(w2.Challenges[0].Steps) != 0 {
		t.Fatalf("resumed %v, challenges %+v", w2.Resumed, w2.Challenges)
	}
	tr.visit(w.Resume, sim.BuoyData.Buoys[0].X, sim.BuoyData.Buoys[0].Z) // B's own visit, queued behind A's

	close(gate[codeA])
	<-returned[codeA]
	<-started[codeB] // the writer moved on, so A's saved callback is already queued ahead of us
	var code string
	var inflight bool
	done := make(chan struct{})
	tr.room.do(tr.ctx, func() {
		u := tr.room.byToken[w.Resume].unsaved[0]
		code, inflight = u.code, u.inflight
		close(done)
	})
	<-done
	if code != codeB || !inflight {
		t.Fatalf("unsaved[0] = code %s inflight %v", code, inflight)
	}
	tr.noChallengesFrame(c, 5)

	close(gate[codeB])
	if got := tr.challengesFrame(c); !slices.Equal(got.Steps, []string{"N"}) {
		t.Fatalf("frame %v", got.Steps)
	}
	for _, code := range []string{codeA, codeB} {
		if got := stepsOf(t, st, code); !slices.Equal(got, []string{"N"}) {
			t.Fatalf("%s stored %v", code, got)
		}
	}
}
