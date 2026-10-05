package netsim

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"sail/server/sim"
)

const testSeed = 1234

func TestSessionAppliesAndAcksInput(t *testing.T) {
	s := NewSession(sim.BuildBoat(), testSeed)
	if err := s.HandleMessage([]byte(`{"type":"input","seq":1,"controls":{"tiller":0.5,"sheet":2,"hike":-1}}`)); err != nil {
		t.Fatal(err)
	}
	if got := s.Snapshot().AckSeq; got != 0 {
		t.Fatalf("ackSeq before a tick = %d, want 0", got)
	}
	s.Step()
	snap := s.Snapshot()
	want := sim.Controls{Tiller: 0.5, Sheet: 1, Hike: 0}
	if snap.AckSeq != 1 || snap.Tick != 1 || snap.Controls != want {
		t.Fatalf("snapshot = tick %d ack %d controls %+v, want tick 1 ack 1 controls %+v", snap.Tick, snap.AckSeq, snap.Controls, want)
	}
	if snap.State.T <= 0 {
		t.Fatalf("state.t = %v after a step", snap.State.T)
	}
}

func TestSessionRejectsBadMessages(t *testing.T) {
	s := NewSession(sim.BuildBoat(), testSeed)
	if err := s.HandleMessage([]byte(`{"type":"input","seq":5,"controls":{"tiller":1,"sheet":0,"hike":0}}`)); err != nil {
		t.Fatal(err)
	}
	before := s.Snapshot()
	for _, msg := range []string{
		`{not json`,
		``,
		`{"type":"fly"}`,
		`{"type":"input","controls":{"tiller":0}}`,
		`{"type":"input","seq":6}`,
		`{"type":"input","seq":5,"controls":{"tiller":-1,"sheet":0,"hike":0}}`, // not after the last seq
	} {
		if err := s.HandleMessage([]byte(msg)); err == nil {
			t.Errorf("%q accepted", msg)
		}
	}
	if after := s.Snapshot(); after != before {
		t.Fatalf("rejected messages changed the session: %+v -> %+v", before, after)
	}
}

func TestSessionReset(t *testing.T) {
	s := NewSession(sim.BuildBoat(), testSeed)
	start := s.Snapshot().State
	for range 60 {
		s.Step()
	}
	if s.Snapshot().State == start {
		t.Fatal("state did not move in 1 s")
	}
	if err := s.HandleMessage([]byte(`{"type":"reset"}`)); err != nil {
		t.Fatal(err)
	}
	snap := s.Snapshot()
	if snap.State != start {
		t.Fatalf("reset state = %+v, want %+v", snap.State, start)
	}
	if snap.Tick != 60 {
		t.Fatalf("reset changed tick to %d, want 60 (ticks never go back)", snap.Tick)
	}
}

// dial starts a server with a fixed seed and connects one client.
func dial(t *testing.T) (*websocket.Conn, context.Context) {
	t.Helper()
	srv := httptest.NewServer(&Server{Seed: func() uint32 { return testSeed }, Log: log.New(io.Discard, "", 0)})
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.CloseNow() })
	return c, ctx
}

// message reads one frame as a generic object plus its type.
func message(t *testing.T, ctx context.Context, c *websocket.Conn) (string, []byte) {
	t.Helper()
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var head struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		t.Fatalf("server sent bad JSON %q: %v", data, err)
	}
	return head.Type, data
}

func welcome(t *testing.T, ctx context.Context, c *websocket.Conn) Welcome {
	t.Helper()
	typ, data := message(t, ctx, c)
	if typ != TypeWelcome {
		t.Fatalf("first message %q, want welcome", typ)
	}
	var w Welcome
	if err := json.Unmarshal(data, &w); err != nil {
		t.Fatal(err)
	}
	return w
}

// snapshotWhere reads until a snapshot satisfies ok, failing on errors.
func snapshotWhere(t *testing.T, ctx context.Context, c *websocket.Conn, ok func(Snapshot) bool) Snapshot {
	t.Helper()
	for {
		typ, data := message(t, ctx, c)
		if typ != TypeSnapshot {
			t.Fatalf("unexpected %s: %s", typ, data)
		}
		var s Snapshot
		if err := json.Unmarshal(data, &s); err != nil {
			t.Fatal(err)
		}
		if ok(s) {
			return s
		}
	}
}

func write(t *testing.T, ctx context.Context, c *websocket.Conn, msg string) {
	t.Helper()
	if err := c.Write(ctx, websocket.MessageText, []byte(msg)); err != nil {
		t.Fatal(err)
	}
}

func TestWelcome(t *testing.T) {
	c, ctx := dial(t)
	w := welcome(t, ctx, c)
	cfg := sim.BrowserConfig(testSeed)
	if w.Seed != testSeed || w.Dt != cfg.Dt || w.Tick != 0 || w.SnapshotHz != DefaultSnapshotHz {
		t.Fatalf("welcome = seed %d dt %v tick %d hz %v", w.Seed, w.Dt, w.Tick, w.SnapshotHz)
	}
	if w.State != startState() {
		t.Fatalf("welcome state %+v, want the start", w.State)
	}
	if !w.Config.Waves.Enabled || !w.Config.Land || w.Config.Substeps != cfg.Substeps {
		t.Fatalf("welcome config is not BrowserConfig: %+v", w.Config)
	}
}

func TestSnapshotsAdvanceTick(t *testing.T) {
	c, ctx := dial(t)
	welcome(t, ctx, c)
	first := snapshotWhere(t, ctx, c, func(Snapshot) bool { return true })
	second := snapshotWhere(t, ctx, c, func(Snapshot) bool { return true })
	if first.Tick <= 0 || second.Tick <= first.Tick || second.State.T <= first.State.T {
		t.Fatalf("snapshots did not advance: tick %d t %v, then tick %d t %v", first.Tick, first.State.T, second.Tick, second.State.T)
	}
}

func TestInputIsAppliedAndAcked(t *testing.T) {
	c, ctx := dial(t)
	welcome(t, ctx, c)
	write(t, ctx, c, `{"type":"input","seq":1,"controls":{"tiller":0.25,"sheet":0.75,"hike":1}}`)
	write(t, ctx, c, `{"type":"input","seq":2,"controls":{"tiller":-3,"sheet":0.5,"hike":0.5}}`)
	s := snapshotWhere(t, ctx, c, func(s Snapshot) bool { return s.AckSeq == 2 })
	if want := (sim.Controls{Tiller: -1, Sheet: 0.5, Hike: 0.5}); s.Controls != want {
		t.Fatalf("acked controls %+v, want %+v (clamped)", s.Controls, want)
	}
}

func TestReset(t *testing.T) {
	c, ctx := dial(t)
	welcome(t, ctx, c)
	moved := snapshotWhere(t, ctx, c, func(s Snapshot) bool { return s.State.T > 0.2 })
	write(t, ctx, c, `{"type":"reset"}`)
	back := snapshotWhere(t, ctx, c, func(s Snapshot) bool { return s.State.T < moved.State.T })
	if back.Tick <= moved.Tick || back.State.T > 0.2 {
		t.Fatalf("after reset: tick %d t %v (before: tick %d t %v)", back.Tick, back.State.T, moved.Tick, moved.State.T)
	}
}

func TestBadJSONKeepsSessionAndServer(t *testing.T) {
	c, ctx := dial(t)
	welcome(t, ctx, c)
	write(t, ctx, c, `{"type":"input","seq":`)
	for {
		typ, data := message(t, ctx, c)
		if typ == TypeSnapshot {
			continue
		}
		var e ErrorMessage
		if err := json.Unmarshal(data, &e); err != nil || typ != TypeError || !strings.Contains(e.Message, "bad JSON") {
			t.Fatalf("got %s, want a bad JSON error", data)
		}
		break
	}
	if err := c.Write(ctx, websocket.MessageBinary, []byte{1, 2, 3}); err != nil {
		t.Fatal(err)
	}
	// The same connection still takes input after the rejections.
	write(t, ctx, c, `{"type":"input","seq":1,"controls":{"tiller":1,"sheet":0,"hike":0}}`)
	for {
		typ, data := message(t, ctx, c)
		if typ == TypeError {
			continue // the binary frame
		}
		var s Snapshot
		if err := json.Unmarshal(data, &s); err != nil {
			t.Fatal(err)
		}
		if s.AckSeq == 1 {
			break
		}
	}
}

func TestConnectionsAreIndependent(t *testing.T) {
	srv := httptest.NewServer(&Server{Seed: func() uint32 { return testSeed }, Log: log.New(io.Discard, "", 0)})
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	a, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer a.CloseNow()
	welcome(t, ctx, a)
	write(t, ctx, a, `{"type":"input","seq":7,"controls":{"tiller":1,"sheet":0,"hike":0}}`)
	snapshotWhere(t, ctx, a, func(s Snapshot) bool { return s.AckSeq == 7 })
	a.Close(websocket.StatusNormalClosure, "")

	b, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer b.CloseNow()
	if w := welcome(t, ctx, b); w.Tick != 0 {
		t.Fatalf("second session starts at tick %d", w.Tick)
	}
	s := snapshotWhere(t, ctx, b, func(Snapshot) bool { return true })
	if s.AckSeq != 0 || s.Controls.Tiller != 0 {
		t.Fatalf("second session inherited input: %+v", s)
	}
}
