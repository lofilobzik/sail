package netsim

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"sail/server/sim"
)

const testSeed = 1234

var quiet = log.New(io.Discard, "", 0)

// fakeClock is the resume-grace clock; tests move it instead of sleeping.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newFakeClock() *fakeClock { return &fakeClock{t: time.Unix(1_000_000, 0)} }

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// testRoom is a running room behind an httptest server.
type testRoom struct {
	t     *testing.T
	ctx   context.Context
	url   string
	clock *fakeClock
	dt    float64
}

func startRoom(t *testing.T, cfg RoomConfig) *testRoom {
	t.Helper()
	clock := newFakeClock()
	cfg.Seed, cfg.Now, cfg.Log = testSeed, clock.Now, quiet
	room := NewRoom(cfg)
	srv := httptest.NewServer(&Server{Room: room, Log: quiet})
	t.Cleanup(srv.Close)
	roomCtx, stopRoom := context.WithCancel(context.Background())
	t.Cleanup(stopRoom)
	go room.Run(roomCtx)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	return &testRoom{t: t, ctx: ctx, url: "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws", clock: clock, dt: room.cfg.Dt}
}

// dial connects a client, with ?resume=token when token is not empty.
func (tr *testRoom) dial(token string) *websocket.Conn {
	tr.t.Helper()
	url := tr.url
	if token != "" {
		url += "?resume=" + token
	}
	c, _, err := websocket.Dial(tr.ctx, url, nil)
	if err != nil {
		tr.t.Fatal(err)
	}
	tr.t.Cleanup(func() { c.CloseNow() })
	return c
}

// join connects a client and reads its welcome.
func (tr *testRoom) join(token string) (*websocket.Conn, Welcome) {
	tr.t.Helper()
	c := tr.dial(token)
	return c, tr.welcome(c)
}

// message reads one frame plus its type.
func (tr *testRoom) message(c *websocket.Conn) (string, []byte) {
	tr.t.Helper()
	_, data, err := c.Read(tr.ctx)
	if err != nil {
		tr.t.Fatal(err)
	}
	var head struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		tr.t.Fatalf("server sent bad JSON %q: %v", data, err)
	}
	return head.Type, data
}

func (tr *testRoom) welcome(c *websocket.Conn) Welcome {
	tr.t.Helper()
	typ, data := tr.message(c)
	if typ != TypeWelcome {
		tr.t.Fatalf("first message %s, want welcome", data)
	}
	var w Welcome
	if err := json.Unmarshal(data, &w); err != nil {
		tr.t.Fatal(err)
	}
	return w
}

// snapshotWhere reads until a snapshot satisfies ok, failing on other messages.
func (tr *testRoom) snapshotWhere(c *websocket.Conn, ok func(Snapshot) bool) Snapshot {
	tr.t.Helper()
	for {
		typ, data := tr.message(c)
		if typ != TypeSnapshot {
			tr.t.Fatalf("unexpected %s", data)
		}
		var s Snapshot
		if err := json.Unmarshal(data, &s); err != nil {
			tr.t.Fatal(err)
		}
		if s.Boats == nil {
			tr.t.Fatalf("boats is not an array: %s", data)
		}
		if ok(s) {
			return s
		}
	}
}

func (tr *testRoom) write(c *websocket.Conn, msg string) {
	tr.t.Helper()
	if err := c.Write(tr.ctx, websocket.MessageText, []byte(msg)); err != nil {
		tr.t.Fatal(err)
	}
}

// waitGone reads observer snapshots until boat id is absent and returns the last pose seen of it.
func (tr *testRoom) waitGone(observer *websocket.Conn, id int) (last RemoteBoat) {
	tr.t.Helper()
	tr.snapshotWhere(observer, func(s Snapshot) bool {
		b, ok := find(s.Boats, id)
		if ok {
			last = b
		}
		return !ok
	})
	return last
}

func find(boats []RemoteBoat, id int) (RemoteBoat, bool) {
	for _, b := range boats {
		if b.ID == id {
			return b, true
		}
	}
	return RemoteBoat{}, false
}

func TestSpawnSlots(t *testing.T) {
	s := 15.0
	want := []sim.Vec2{{}, {X: 0, Z: s}, {X: 0, Z: -s}, {X: s, Z: 0}, {X: -s, Z: 0}, {X: s, Z: s}, {X: s, Z: -s}, {X: -s, Z: s}, {X: -s, Z: -s}}
	slots := spawnSlots(DefaultMaxBoats)
	if len(slots) != DefaultMaxBoats {
		t.Fatalf("%d slots, want %d", len(slots), DefaultMaxBoats)
	}
	for i, w := range want {
		if slots[i] != w {
			t.Fatalf("slot %d = %+v, want %+v", i, slots[i], w)
		}
	}
	for i, p := range slots {
		if depth := -sim.TerrainHeight(p.X, p.Z); depth < 3 {
			t.Errorf("slot %d %+v is %.1f m deep", i, p, depth)
		}
		for _, q := range slots[:i] {
			if math.Hypot(p.X-q.X, p.Z-q.Z) < spawnSpacing {
				t.Errorf("slots %+v and %+v closer than %v m", p, q, spawnSpacing)
			}
		}
	}
}

func TestParseClientMessage(t *testing.T) {
	if _, err := parseClientMessage([]byte(`{"type":"input","seq":6,"controls":{"tiller":1,"sheet":0,"hike":0}}`), 5); err != nil {
		t.Fatal(err)
	}
	if _, err := parseClientMessage([]byte(`{"type":"reset"}`), 5); err != nil {
		t.Fatal(err)
	}
	for _, msg := range []string{
		`{not json`,
		``,
		`{"type":"fly"}`,
		`{"type":"input","controls":{"tiller":0}}`,
		`{"type":"input","seq":6}`,
		`{"type":"input","seq":5,"controls":{"tiller":-1,"sheet":0,"hike":0}}`, // not after the last seq
	} {
		if _, err := parseClientMessage([]byte(msg), 5); err == nil {
			t.Errorf("%q accepted", msg)
		}
	}
}

// TestRoomAppliesEachInputOnceInOrder drives the room directly (no clock goroutine) for exact states:
// however the inputs arrive (bursts after gaps, starved ticks), the server's boat after input N is
// exactly N sim steps from its spawn, which is what the client predicts.
func TestRoomAppliesEachInputOnceInOrder(t *testing.T) {
	r := NewRoom(RoomConfig{Seed: testSeed, Now: newFakeClock().Now, Log: quiet})
	a := r.join("", "a")
	b := a.member.boat
	want := b.state
	controls := func(seq int64) sim.Controls {
		return sim.Controls{Tiller: 0.3 * math.Sin(float64(seq)/7), Sheet: 0.4, Hike: float64(seq%3) / 2}
	}
	// Arrivals per tick, like a jittery link: steady, a gap, a burst, a long gap, a big burst.
	arrivals := []int{1, 1, 1, 0, 0, 0, 4, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 30, 1, 1}
	var seq int64
	for _, n := range arrivals {
		for range n {
			seq++
			r.input(a.member, seq, controls(seq))
		}
		before := b.ackSeq
		r.step()
		if applied := b.ackSeq - before; applied > maxCredit {
			t.Fatalf("applied %d inputs in one tick, max %d", applied, maxCredit)
		}
	}
	for range 20 { // let the last burst drain
		r.step()
	}
	if b.ackSeq != seq {
		t.Fatalf("applied up to input %d of %d", b.ackSeq, seq)
	}
	cfg := sim.BrowserConfig(testSeed)
	for i := int64(1); i <= seq; i++ {
		want = sim.Step(want, controls(i), r.model, &cfg).State
	}
	if b.state != want {
		t.Fatalf("after %d inputs the server boat is %+v, want %+v (one step per input)", seq, b.state, want)
	}
	if b.state.T >= r.time() {
		t.Fatalf("boat t %v, room t %v: a boat only moves on its inputs, so it is behind the room clock", b.state.T, r.time())
	}
}

// TestRoomQueueDropsOldestWhenFull: a client sending far faster than real time loses old inputs
// instead of building up unbounded lag.
func TestRoomQueueDropsOldestWhenFull(t *testing.T) {
	r := NewRoom(RoomConfig{Seed: testSeed, Now: newFakeClock().Now, Log: quiet})
	a := r.join("", "a")
	for seq := int64(1); seq <= inputQueueSize+10; seq++ {
		r.input(a.member, seq, sim.NeutralControls)
	}
	r.step()
	if got := a.member.boat.ackSeq; got != 11 {
		t.Fatalf("first applied input %d, want 11 (the 10 oldest dropped)", got)
	}
}

// TestRoomResumeKeepsStateAtRoomTime: a parked boat comes back as it left, at the room time.
func TestRoomResumeKeepsStateAtRoomTime(t *testing.T) {
	clock := newFakeClock()
	r := NewRoom(RoomConfig{Seed: testSeed, Now: clock.Now, Log: quiet})
	a := r.join("", "a")
	for seq := int64(1); seq <= 30; seq++ {
		r.input(a.member, seq, sim.Controls{Tiller: 0.3, Sheet: 0.6, Hike: 1})
		r.step()
	}
	for range 30 {
		r.step()
	}
	left := a.member.boat.state
	token := a.member.boat.token
	r.leave(a.member, "a", "test")
	for range 90 {
		r.step()
	}
	clock.Advance(DefaultResumeGrace - time.Second)
	back := r.join(token, "a")
	var w Welcome
	if err := json.Unmarshal(back.welcome, &w); err != nil {
		t.Fatal(err)
	}
	if !w.Resumed || w.ID != a.id || w.Resume != token || w.Tick != 150 {
		t.Fatalf("resume welcome = id %d resumed %v token %q tick %d, want id %d resumed tick 150", w.ID, w.Resumed, w.Resume, w.Tick, a.id)
	}
	if w.State.T != r.time() {
		t.Fatalf("resumed t = %v, want room time %v", w.State.T, r.time())
	}
	w.State.T = left.T
	if w.State != left {
		t.Fatalf("resumed state %+v, want %+v as it left", w.State, left)
	}
	if got := back.member.boat.controls; got != (sim.Controls{Tiller: 0.3, Sheet: 0.6, Hike: 1}) {
		t.Fatalf("resumed controls %+v", got)
	}
	r.leave(back.member, "a", "test")
	clock.Advance(DefaultResumeGrace + time.Second)
	if again := r.join(token, "a"); again.member.boat.id == a.id {
		t.Fatal("expired token resumed the boat")
	}
}

func TestWelcome(t *testing.T) {
	tr := startRoom(t, RoomConfig{})
	_, w := tr.join("")
	cfg := sim.BrowserConfig(testSeed)
	if w.Seed != testSeed || w.Dt != cfg.Dt || w.SnapshotHz != DefaultSnapshotHz || w.ID < 1 || w.Resume == "" || w.Resumed {
		t.Fatalf("welcome = seed %d dt %v hz %v id %d resume %q resumed %v", w.Seed, w.Dt, w.SnapshotHz, w.ID, w.Resume, w.Resumed)
	}
	start := sim.InitialState(StartHeadingDeg*math.Pi/180, StartSpeed)
	start.T = float64(w.Tick) * w.Dt
	if w.State != start {
		t.Fatalf("welcome state %+v, want %+v (slot 0 at the room time)", w.State, start)
	}
	if !w.Config.Waves.Enabled || !w.Config.Land || w.Config.Substeps != cfg.Substeps {
		t.Fatalf("welcome config is not BrowserConfig: %+v", w.Config)
	}
}

// TestTwoClientsShareTheWorld: each sees the other (never itself), as the other's own snapshot says.
func TestTwoClientsShareTheWorld(t *testing.T) {
	tr := startRoom(t, RoomConfig{})
	a, wa := tr.join("")
	tr.snapshotWhere(a, func(s Snapshot) bool { return s.Tick > 10 })
	b, wb := tr.join("")
	if wb.ID == wa.ID || wb.Resume == wa.Resume {
		t.Fatalf("both boats are id %d", wa.ID)
	}
	if wb.Tick <= 10 || wb.State.T != float64(wb.Tick)*wb.Dt {
		t.Fatalf("second welcome at tick %d t %v, want a spawn at the room time", wb.Tick, wb.State.T)
	}

	own := map[int64]Snapshot{}
	seen := 0
	tr.snapshotWhere(a, func(s Snapshot) bool {
		if _, self := find(s.Boats, wa.ID); self {
			t.Fatalf("a sees itself: %+v", s.Boats)
		}
		own[s.Tick] = s
		if _, ok := find(s.Boats, wb.ID); ok {
			seen++
		}
		return seen >= 3
	})
	sb := tr.snapshotWhere(b, func(s Snapshot) bool {
		if _, self := find(s.Boats, wb.ID); self {
			t.Fatalf("b sees itself: %+v", s.Boats)
		}
		_, ok := own[s.Tick]
		return ok
	})
	sa := own[sb.Tick]
	ra, ok := find(sb.Boats, wa.ID)
	if !ok || len(sb.Boats) != 1 {
		t.Fatalf("b's boats %+v, want just a", sb.Boats)
	}
	s := sa.State
	want := RemoteBoat{
		ID: wa.ID, X: s.X, Z: s.Z, Heading: s.Heading, U: s.U, Heel: s.Heel, Pitch: s.Pitch, Boom: s.Boom, CrewY: s.CrewY,
		Tiller: sa.Controls.Tiller, Sheet: sa.Controls.Sheet,
		ApparentU: ra.ApparentU, ApparentV: ra.ApparentV, LuffAmount: ra.LuffAmount, StallAmount: ra.StallAmount,
	}
	if ra != want {
		t.Fatalf("b sees a as %+v, a's own snapshot says %+v", ra, want)
	}
	if ra.ApparentU == 0 && ra.ApparentV == 0 || ra.LuffAmount < 0 || ra.LuffAmount > 1 || ra.StallAmount < 0 || ra.StallAmount > 1 {
		t.Fatalf("remote sail diagnostics %+v", ra)
	}
}

func TestSpawnSlotsAreDistinctAndResetPicksAFreeOne(t *testing.T) {
	tr := startRoom(t, RoomConfig{})
	slots := spawnSlots(DefaultMaxBoats)
	at := func(s sim.BoatState, p sim.Vec2) bool { return math.Hypot(s.X-p.X, s.Z-p.Z) < 1 }
	a, wa := tr.join("")
	b, wb := tr.join("")
	if !at(wa.State, slots[0]) || !at(wb.State, slots[1]) {
		t.Fatalf("spawned at (%v, %v) and (%v, %v), want slots 0 and 1", wa.State.X, wa.State.Z, wb.State.X, wb.State.Z)
	}
	// Ops from one connection apply in order, so the snapshot acking the next input follows the reset.
	tr.write(b, `{"type":"reset"}`)
	tr.write(b, `{"type":"input","seq":1,"controls":{"tiller":0,"sheet":0.5,"hike":0}}`)
	if s := tr.snapshotWhere(b, func(s Snapshot) bool { return s.AckSeq == 1 }); !at(s.State, slots[1]) {
		t.Fatalf("reset with slot 0 taken put b at (%v, %v), want slot 1", s.State.X, s.State.Z)
	}
	a.Close(websocket.StatusNormalClosure, "")
	tr.waitGone(b, wa.ID)
	tr.write(b, `{"type":"reset"}`)
	tr.write(b, `{"type":"input","seq":2,"controls":{"tiller":0,"sheet":0.5,"hike":0}}`)
	s := tr.snapshotWhere(b, func(s Snapshot) bool { return s.AckSeq == 2 })
	if !at(s.State, slots[0]) {
		t.Fatalf("reset with slot 0 free put b at (%v, %v), want slot 0", s.State.X, s.State.Z)
	}
}

// TestResetAppliesInOrderWithInputs: inputs sent before a reset move the old boat, inputs after it
// the respawned one, however the room's ticks fall between them.
func TestResetAppliesInOrderWithInputs(t *testing.T) {
	r := NewRoom(RoomConfig{Seed: testSeed, Now: newFakeClock().Now, Log: quiet})
	a := r.join("", "a")
	spawn := a.member.boat.state
	for seq := int64(1); seq <= 5; seq++ {
		r.input(a.member, seq, sim.Controls{Tiller: 1, Sheet: 0.3})
	}
	r.reset(a.member)
	r.input(a.member, 6, sim.NeutralControls)
	for range 10 {
		r.step()
	}
	b := a.member.boat
	cfg := sim.BrowserConfig(testSeed)
	respawn := spawn
	respawn.T = b.state.T - cfg.Dt // the reset happened at the room time of the tick that applied it
	want := sim.Step(respawn, sim.NeutralControls, r.model, &cfg).State
	if b.ackSeq != 6 || b.state != want {
		t.Fatalf("after reset + input 6: ack %d state %+v, want %+v", b.ackSeq, b.state, want)
	}
}

func TestLeaveRemovesBoat(t *testing.T) {
	tr := startRoom(t, RoomConfig{})
	a, wa := tr.join("")
	b, _ := tr.join("")
	tr.snapshotWhere(b, func(s Snapshot) bool { _, ok := find(s.Boats, wa.ID); return ok })
	a.Close(websocket.StatusNormalClosure, "")
	tr.waitGone(b, wa.ID)
	tr.snapshotWhere(b, func(s Snapshot) bool { return true })
	if s := tr.snapshotWhere(b, func(s Snapshot) bool { return true }); len(s.Boats) != 0 {
		t.Fatalf("boats after a left: %+v", s.Boats)
	}
}

func TestResume(t *testing.T) {
	tr := startRoom(t, RoomConfig{})
	observer, _ := tr.join("")
	a, wa := tr.join("")
	for seq := 1; seq <= 30; seq++ {
		tr.write(a, fmt.Sprintf(`{"type":"input","seq":%d,"controls":{"tiller":0.2,"sheet":0.3,"hike":0}}`, seq))
	}
	tr.snapshotWhere(a, func(s Snapshot) bool { return s.AckSeq == 30 })
	tr.snapshotWhere(observer, func(s Snapshot) bool { _, ok := find(s.Boats, wa.ID); return ok })
	a.Close(websocket.StatusNormalClosure, "")
	last := tr.waitGone(observer, wa.ID)

	tr.clock.Advance(DefaultResumeGrace - time.Second)
	a, w := tr.join(wa.Resume)
	if !w.Resumed || w.ID != wa.ID || w.Resume != wa.Resume {
		t.Fatalf("resume welcome id %d resumed %v, want id %d resumed", w.ID, w.Resumed, wa.ID)
	}
	if w.State.T != float64(w.Tick)*w.Dt {
		t.Fatalf("resumed at t %v, room time %v", w.State.T, float64(w.Tick)*w.Dt)
	}
	// The boat was parked where it left: the observer saw its last pose.
	if d := math.Hypot(w.State.X-last.X, w.State.Z-last.Z); d > 1e-9 {
		t.Fatalf("resumed %v m from where it left", d)
	}
	// Input seqs restart per connection, and each new input is one step from the resumed state.
	tr.write(a, `{"type":"input","seq":1,"controls":{"tiller":0,"sheet":0.5,"hike":0}}`)
	if s := tr.snapshotWhere(a, func(s Snapshot) bool { return s.AckSeq == 1 }); math.Abs(s.State.T-(w.State.T+w.Dt)) > 1e-9 {
		t.Fatalf("resumed boat t %v after one input, want %v", s.State.T, w.State.T+w.Dt)
	}
	tr.snapshotWhere(observer, func(s Snapshot) bool { _, ok := find(s.Boats, wa.ID); return ok })

	a.Close(websocket.StatusNormalClosure, "")
	tr.waitGone(observer, wa.ID)
	tr.clock.Advance(DefaultResumeGrace + time.Second)
	if _, w := tr.join(wa.Resume); w.Resumed || w.ID == wa.ID || w.Resume == wa.Resume {
		t.Fatalf("expired token: id %d resumed %v", w.ID, w.Resumed)
	}
	if _, w := tr.join("NOT-A-TOKEN"); w.Resumed || w.ID == wa.ID {
		t.Fatalf("bad token: id %d resumed %v", w.ID, w.Resumed)
	}
}

func TestResumeReplacesALiveConnection(t *testing.T) {
	tr := startRoom(t, RoomConfig{})
	old, wa := tr.join("")
	_, w := tr.join(wa.Resume)
	if !w.Resumed || w.ID != wa.ID {
		t.Fatalf("takeover welcome id %d resumed %v", w.ID, w.Resumed)
	}
	for {
		if _, _, err := old.Read(tr.ctx); err != nil {
			if status := websocket.CloseStatus(err); status != StatusReplaced {
				t.Fatalf("old connection ended with %v, want close %d", err, StatusReplaced)
			}
			return
		}
	}
}

func TestRoomFull(t *testing.T) {
	tr := startRoom(t, RoomConfig{MaxBoats: 2})
	a, wa := tr.join("")
	b, _ := tr.join("")
	c := tr.dial("")
	typ, data := tr.message(c)
	var e ErrorMessage
	if err := json.Unmarshal(data, &e); err != nil || typ != TypeError || e.Message != MessageRoomFull {
		t.Fatalf("third client got %s, want a room full error", data)
	}
	if _, _, err := c.Read(tr.ctx); websocket.CloseStatus(err) != websocket.StatusTryAgainLater {
		t.Fatalf("third client read %v, want close 1013", err)
	}
	a.Close(websocket.StatusNormalClosure, "")
	tr.waitGone(b, wa.ID)
	if _, w := tr.join(""); w.ID == wa.ID {
		t.Fatalf("a free place went to id %d", w.ID)
	}
}

func TestInputIsAckedPerBoat(t *testing.T) {
	tr := startRoom(t, RoomConfig{})
	a, wa := tr.join("")
	b, _ := tr.join("")
	tr.write(a, `{"type":"input","seq":1,"controls":{"tiller":0.25,"sheet":0.75,"hike":1}}`)
	tr.write(a, `{"type":"input","seq":2,"controls":{"tiller":-3,"sheet":0.5,"hike":0.5}}`)
	tr.write(b, `{"type":"input","seq":9,"controls":{"tiller":0.5,"sheet":0.2,"hike":0}}`)
	sa := tr.snapshotWhere(a, func(s Snapshot) bool {
		if s.AckSeq > 2 {
			t.Fatalf("a acked %d", s.AckSeq)
		}
		return s.AckSeq == 2
	})
	if want := (sim.Controls{Tiller: -1, Sheet: 0.5, Hike: 0.5}); sa.Controls != want {
		t.Fatalf("a's acked controls %+v, want %+v (clamped)", sa.Controls, want)
	}
	sb := tr.snapshotWhere(b, func(s Snapshot) bool {
		if s.AckSeq != 0 && s.AckSeq != 9 {
			t.Fatalf("b acked %d", s.AckSeq)
		}
		ra, _ := find(s.Boats, wa.ID)
		return s.AckSeq == 9 && ra.Tiller == -1
	})
	if want := (sim.Controls{Tiller: 0.5, Sheet: 0.2}); sb.Controls != want {
		t.Fatalf("b's acked controls %+v, want %+v", sb.Controls, want)
	}
	if ra, _ := find(sb.Boats, wa.ID); ra.Sheet != 0.5 {
		t.Fatalf("b sees a's sheet %v, want 0.5", ra.Sheet)
	}
}

func TestBadJSONKeepsConnection(t *testing.T) {
	tr := startRoom(t, RoomConfig{})
	c, _ := tr.join("")
	tr.write(c, `{"type":"input","seq":`)
	for {
		typ, data := tr.message(c)
		if typ == TypeSnapshot {
			continue
		}
		var e ErrorMessage
		if err := json.Unmarshal(data, &e); err != nil || typ != TypeError || !strings.Contains(e.Message, "bad JSON") {
			t.Fatalf("got %s, want a bad JSON error", data)
		}
		break
	}
	if err := c.Write(tr.ctx, websocket.MessageBinary, []byte{1, 2, 3}); err != nil {
		t.Fatal(err)
	}
	// The same connection still takes input after the rejections.
	tr.write(c, `{"type":"input","seq":1,"controls":{"tiller":1,"sheet":0,"hike":0}}`)
	for {
		typ, data := tr.message(c)
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

// BenchmarkRoomTick measures one fixed step of a full room with every boat sending one input per
// tick, and a step plus encoding and queueing one snapshot for every boat (a snapshot tick).
func BenchmarkRoomTick(b *testing.B) {
	r := NewRoom(RoomConfig{Seed: testSeed, Log: quiet})
	members := make([]*member, DefaultMaxBoats)
	for i := range members {
		members[i] = r.join("", "bench").member
	}
	var seq int64
	tick := func() {
		seq++
		for i, m := range members {
			r.input(m, seq, sim.Controls{Tiller: 0.1 * float64(i%5), Sheet: 0.5, Hike: 1})
		}
		r.step()
	}
	for range 60 {
		tick()
	}
	b.Run("step32", func(b *testing.B) {
		for b.Loop() {
			tick()
		}
	})
	b.Run("step32+snapshot", func(b *testing.B) {
		for b.Loop() {
			tick()
			r.broadcast()
		}
	})
}
