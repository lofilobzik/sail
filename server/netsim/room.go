package netsim

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"log"
	"math"
	"slices"
	"time"

	"sail/server/sim"
)

// Start of every boat and every reset, mirrored from src/main.ts resetBoat.
const (
	StartSpeed = 1 // TUNING GUESS (main.ts START_SPEED): initial boat speed, m/s
)

const (
	// DefaultSnapshotHz is the contract's snapshot rate.
	DefaultSnapshotHz = 20
	// DefaultMaxBoats caps the boats sailing in the room at once.
	DefaultMaxBoats = 32 // TUNING GUESS
	// DefaultResumeGrace is how long a disconnected boat waits for its resume token.
	DefaultResumeGrace = 60 * time.Second // TUNING GUESS
	// spawnSpacing is the grid step of the spawn slots around the departure point, m; a slot is free
	// when no sailing boat is within half of it.
	spawnSpacing = 15.0 // TUNING GUESS
	// opsSize buffers connection → room requests (inputs from all connections, joins, leaves).
	opsSize = 256 // TUNING GUESS
	// outboxSize buffers snapshots to one connection; a client that falls further behind loses its
	// oldest queued snapshots rather than stalling the room.
	outboxSize = 4 // TUNING GUESS
	// creditPerTick is how many queued inputs a boat may apply per room tick on average: one per tick,
	// plus 1 % for a client clock that runs a little fast (a faster client builds a queue instead).
	creditPerTick = 1.01 // TUNING GUESS
	// maxCredit caps how many queued inputs one boat may catch up on in a single tick after a gap
	// (network jitter, a throttled tab): 0.25 s at 60 Hz, the browser loop's own catch-up cap.
	maxCredit = 15 // TUNING GUESS
	// inputQueueSize bounds a boat's received but not yet applied inputs (2 s at 60 Hz); a client
	// sending faster than real time loses its oldest inputs instead of building up lag without limit.
	inputQueueSize = 120 // TUNING GUESS

	// saveQueueSize bounds the visits waiting for the writer; a full queue is retried by the sweep.
	saveQueueSize = 64 // TUNING GUESS
	// saveRetryDelay is the wait before a failed visit write is tried again.
	saveRetryDelay = 2 * time.Second // TUNING GUESS
)

// RoomConfig configures NewRoom. Zero values pick the defaults.
type RoomConfig struct {
	// Seed is the wave/gust seed of the room's world.
	Seed uint32
	// MaxBoats caps the boats sailing at once; <= 0 means DefaultMaxBoats.
	MaxBoats int
	// SnapshotHz is the snapshot rate; <= 0 means DefaultSnapshotHz.
	SnapshotHz float64
	// ResumeGrace is how long a disconnected boat can be resumed; <= 0 means DefaultResumeGrace.
	ResumeGrace time.Duration
	// Now is the clock for the resume grace; nil means time.Now.
	Now func() time.Time
	// Log receives connect/disconnect lines; nil means log.Default().
	Log *log.Logger
	// Store keeps challenge progress; nil (the default) switches challenges off. Assign only a real store.
	Store Store
}

// Room is the one shared world: one seed and config, one tick, every connected boat stepped
// together. Run owns all room state; connections reach it only through the ops channel.
type Room struct {
	seed     uint32
	cfg      sim.SimConfig
	model    *sim.BoatModel
	maxBoats int
	hz       float64
	grace    time.Duration
	now      func() time.Time
	log      *log.Logger
	slots    []sim.Vec2

	ops  chan func()
	done chan struct{}

	// Challenge persistence (challenges.go): store and saves are nil without RoomConfig.Store, and
	// saveDone is then already closed.
	store    Store
	saves    chan saveJob
	saveDone chan struct{}

	// Owned by the Run goroutine.
	tick     int64
	nextID   int
	byToken  map[string]*roomBoat // sailing and parked boats
	sailing  []*roomBoat          // boats with a connection, in join order
	remote   [][]byte             // scratch: encoded RemoteBoat per sailing boat
	boatsBuf bytes.Buffer         // scratch: one receiver's boats array
}

// roomBoat is one boat in the room, sailing (member != nil) or parked for its resume grace.
type roomBoat struct {
	id       int
	token    string
	state    sim.BoatState
	controls sim.Controls // the controls of the last applied input
	queue    inputQueue   // received inputs and resets, applied one input per sim step
	credit   float64      // inputs this boat may still apply (see creditPerTick, maxCredit)
	ackSeq   int64        // seq of the last applied input on the current connection
	sail     sailView
	member   *member
	leftAt   time.Time

	player  string               // sailor code of the current connection, "" when none
	visited []bool               // per buoy: reached (stored or detected)
	unsaved map[int]*unsavedStep // buoy index -> visit detected but not yet confirmed stored
}

// queuedInput is one input (or a reset, in order with the inputs) waiting to be applied.
type queuedInput struct {
	seq      int64
	controls sim.Controls
	reset    bool
}

// inputQueue is a fixed ring of a boat's waiting inputs, oldest first, so queueing never allocates.
type inputQueue struct {
	buf        [inputQueueSize]queuedInput
	head, size int
}

// push appends e; a full queue drops its oldest entry.
func (q *inputQueue) push(e queuedInput) {
	if q.size == len(q.buf) {
		q.pop()
	}
	q.buf[(q.head+q.size)%len(q.buf)] = e
	q.size++
}

func (q *inputQueue) front() *queuedInput { return &q.buf[q.head] }

func (q *inputQueue) pop() {
	q.head = (q.head + 1) % len(q.buf)
	q.size--
}

func (q *inputQueue) clear() { q.head, q.size = 0, 0 }

// sailView is what other clients need from a boat's last Diagnostics to draw its sail.
type sailView struct {
	apparentU, apparentV, luffAmount, stallAmount float64
}

// member is one connection's attachment to a boat. The connection goroutine only receives from out
// and replaced; boat belongs to the Run goroutine.
type member struct {
	out      chan []byte
	news     chan []byte   // challenge progress frames; separate from out so a stalled client cannot lose one
	replaced chan struct{} // closed when a newer connection resumed the boat
	boat     *roomBoat
}

// joinResult answers a join: welcome is nil when the room is full.
type joinResult struct {
	member  *member
	id      int
	welcome []byte
}

// NewRoom builds a room at tick 0 in sim.BrowserConfig(c.Seed). Call Run to start its clock.
func NewRoom(c RoomConfig) *Room {
	r := &Room{
		seed:     c.Seed,
		cfg:      sim.BrowserConfig(c.Seed),
		model:    sim.BuildBoat(),
		maxBoats: c.MaxBoats,
		hz:       c.SnapshotHz,
		grace:    c.ResumeGrace,
		now:      c.Now,
		log:      c.Log,
		ops:      make(chan func(), opsSize),
		done:     make(chan struct{}),
		nextID:   1,
		byToken:  map[string]*roomBoat{},
		store:    c.Store,
		saveDone: make(chan struct{}),
	}
	if r.store != nil {
		r.saves = make(chan saveJob, saveQueueSize)
	} else {
		close(r.saveDone)
	}
	if r.maxBoats <= 0 {
		r.maxBoats = DefaultMaxBoats
	}
	if r.hz <= 0 {
		r.hz = DefaultSnapshotHz
	}
	if r.grace <= 0 {
		r.grace = DefaultResumeGrace
	}
	if r.now == nil {
		r.now = time.Now
	}
	if r.log == nil {
		r.log = log.Default()
	}
	r.slots = spawnSlots(r.maxBoats)
	return r
}

// Run steps the room at a fixed dt (ticker plus accumulator, so a late tick is caught up rather
// than lost), serves connection requests between ticks and sends snapshots, until ctx ends.
func (r *Room) Run(ctx context.Context) {
	if r.store != nil {
		go r.writeLoop()
		// Runs after close(r.done), still on this goroutine: the boats still sailing keep their
		// positions, then the writer drains every queued job and exits.
		defer func() {
			for _, b := range r.sailing {
				r.savePosition(b, true)
			}
			close(r.saves)
		}()
	}
	defer close(r.done)
	dt := r.cfg.Dt
	fixed := sim.NewFixedStep(dt) // caps catch-up like the browser loop
	ticker := time.NewTicker(time.Duration(dt * float64(time.Second)))
	defer ticker.Stop()
	last := time.Now()
	snapshotDue := 0.0 // snapshots owed, in units of one snapshot
	for {
		select {
		case <-ctx.Done():
			return
		case op := <-r.ops:
			op()
		case now := <-ticker.C:
			steps := fixed.Advance(now.Sub(last).Seconds())
			last = now
			for range steps {
				r.step()
			}
			snapshotDue += float64(steps) * dt * r.hz
			if snapshotDue >= 1 {
				snapshotDue -= math.Floor(snapshotDue) // after a long catch-up, one snapshot is enough
				r.broadcast()
				r.forgetExpired()
				r.retryUnsaved()
			}
		}
	}
}

// do runs op on the Run goroutine; false when the room or ctx has ended first.
func (r *Room) do(ctx context.Context, op func()) bool {
	select {
	case r.ops <- op:
		return true
	case <-r.done:
	case <-ctx.Done():
	}
	return false
}

// time is the room time, s.
func (r *Room) time() float64 { return float64(r.tick) * r.cfg.Dt }

// step advances the room clock one tick and each sailing boat by the inputs it has received: one
// sim step per input, in seq order, so the server's state after input N is exactly the client's
// prediction after input N, whatever the network jitter. A boat with no waiting input does not move
// (its own clock, state.T, falls behind the room clock by the input's travel time); after a gap it
// catches up on at most maxCredit inputs in one tick. Resets apply in order with the inputs.
func (r *Room) step() {
	r.tick++
	for _, b := range r.sailing {
		b.credit = min(b.credit+creditPerTick, maxCredit)
		for b.queue.size > 0 {
			e := b.queue.front()
			if e.reset {
				b.state = r.spawn(b)
				r.see(b, sim.Evaluate(b.state, b.controls, r.model, &r.cfg))
				b.queue.pop()
				continue
			}
			if b.credit < 1 {
				break
			}
			b.credit--
			b.controls = e.controls
			b.ackSeq = e.seq
			b.queue.pop()
			res := sim.Step(b.state, b.controls, r.model, &r.cfg)
			b.state = res.State
			r.observe(b)
			r.see(b, res.Diagnostics)
		}
	}
}

// see keeps what other clients need to draw b's sail, from b's latest Diagnostics.
func (r *Room) see(b *roomBoat, d sim.Diagnostics) {
	b.sail = sailView{apparentU: d.Apparent.U, apparentV: d.Apparent.V}
	if d.Sail != nil {
		b.sail.luffAmount, b.sail.stallAmount = d.Sail.LuffAmount, d.Sail.StallAmount
	}
}

// broadcast queues one snapshot to every sailing boat; a full outbox drops it.
func (r *Room) broadcast() {
	r.remote = r.remote[:0]
	for _, b := range r.sailing {
		data, err := json.Marshal(RemoteBoat{
			ID: b.id, X: b.state.X, Z: b.state.Z, Heading: b.state.Heading, U: b.state.U,
			Heel: b.state.Heel, Pitch: b.state.Pitch, Boom: b.state.Boom, CrewY: b.state.CrewY,
			Tiller: b.controls.Tiller, Sheet: b.controls.Sheet,
			ApparentU: b.sail.apparentU, ApparentV: b.sail.apparentV,
			LuffAmount: b.sail.luffAmount, StallAmount: b.sail.stallAmount,
		})
		if err != nil {
			r.log.Printf("encode boat %d: %v", b.id, err)
			data = nil
		}
		r.remote = append(r.remote, data)
	}
	for i, b := range r.sailing {
		r.boatsBuf.Reset()
		r.boatsBuf.WriteByte('[')
		first := true
		for j, data := range r.remote {
			if j == i || data == nil {
				continue
			}
			if !first {
				r.boatsBuf.WriteByte(',')
			}
			first = false
			r.boatsBuf.Write(data)
		}
		r.boatsBuf.WriteByte(']')
		frame, err := json.Marshal(snapshotFrame{
			Type: TypeSnapshot, Tick: r.tick, AckSeq: b.ackSeq, State: b.state, Controls: b.controls,
			Boats: r.boatsBuf.Bytes(),
		})
		if err != nil {
			r.log.Printf("encode snapshot for boat %d: %v", b.id, err)
			continue
		}
		select {
		case b.member.out <- frame:
		default: // the room is the only sender, so after dropping the oldest there is room
			select {
			case <-b.member.out:
			default:
			}
			b.member.out <- frame
		}
	}
}

// forgetExpired drops parked boats whose resume grace has passed.
func (r *Room) forgetExpired() {
	now := r.now()
	for token, b := range r.byToken {
		if b.member == nil && now.Sub(b.leftAt) > r.grace {
			if len(b.unsaved) > 0 {
				r.log.Printf("boat %d expired with %d unsaved challenge steps", b.id, len(b.unsaved))
			}
			delete(r.byToken, token)
		}
	}
}

// join attaches a connection to a boat: the boat of a live resume token, else the boat of the
// player's sailor code (one boat per code, so another tab, a reload or another browser with the same
// code takes it over), both in place and at rest; else a new boat at the player's last stored
// position or a free spawn slot. A boat that is still sailing is handed over and the old
// connection's replaced channel closed.
func (r *Room) join(resume, addr string, p *playerInfo) joinResult {
	b := r.byToken[resume]
	if b == nil && p != nil {
		b = r.boatOf(p.code)
	}
	if b != nil && b.member == nil && r.now().Sub(b.leftAt) > r.grace {
		delete(r.byToken, b.token)
		b = nil
	}
	if b != nil && b.member != nil {
		close(b.member.replaced)
		r.detach(b)
	}
	if len(r.sailing) >= r.maxBoats {
		r.log.Printf("reject %s: room full (%d/%d)", addr, len(r.sailing), r.maxBoats)
		return joinResult{}
	}
	resumed := b != nil
	if resumed {
		// Back where it was, at the start speed: the boat does not sail on while its player is away.
		b.state = r.stillAt(b.state.X, b.state.Z, b.state.Heading)
	} else {
		b = &roomBoat{id: r.nextID, token: rand.Text(), controls: sim.NeutralControls}
		r.nextID++
		if p != nil && p.position != nil {
			// A sailor code whose last boat is gone (resume grace over, or a restarted server).
			b.state = r.stillAt(p.position.X, p.position.Z, p.position.Heading)
		} else {
			b.state = r.spawn(nil)
		}
		r.byToken[b.token] = b
	}
	// Others draw the sail of a boat that has not sent an input yet as it stands.
	r.see(b, sim.Evaluate(b.state, b.controls, r.model, &r.cfg))
	// Input seq order is per connection; anything queued from an old connection is dropped.
	b.ackSeq, b.credit = 0, 0
	b.queue.clear()
	m := &member{
		out: make(chan []byte, outboxSize), news: make(chan []byte, len(sim.BuoyData.Buoys)+1),
		replaced: make(chan struct{}), boat: b,
	}
	r.seedProgress(b, p)
	var challenges []ChallengeStatus
	if p != nil {
		challenges = r.statuses(p.progress)
	}
	b.member = m
	r.sailing = append(r.sailing, b)
	welcome, err := json.Marshal(Welcome{
		Type: TypeWelcome, ID: b.id, Resume: b.token, Resumed: resumed,
		Seed: r.seed, Config: r.cfg, Dt: r.cfg.Dt, Tick: r.tick, State: b.state, SnapshotHz: r.hz,
		Challenges: challenges,
	})
	if err != nil {
		panic(err) // plain structs of numbers and strings
	}
	how := "new"
	if resumed {
		how = "resumed"
	}
	r.log.Printf("connect %s boat %d (%s), room %d/%d", addr, b.id, how, len(r.sailing), r.maxBoats)
	return joinResult{member: m, id: b.id, welcome: welcome}
}

// boatOf is the sailing or parked boat of sailor code, or nil.
func (r *Room) boatOf(code string) *roomBoat {
	for _, b := range r.byToken {
		if b.player == code {
			return b
		}
	}
	return nil
}

// leave parks m's boat for its resume grace, unless a newer connection has taken the boat over.
func (r *Room) leave(m *member, addr, reason string) {
	b := m.boat
	if b.member != m {
		r.log.Printf("disconnect %s boat %d (%s): replaced", addr, b.id, reason)
		return
	}
	r.detach(b)
	r.savePosition(b, false) // a later boat for this sailor code starts here, also after a restart
	r.log.Printf("disconnect %s boat %d (%s), room %d/%d", addr, b.id, reason, len(r.sailing), r.maxBoats)
}

func (r *Room) detach(b *roomBoat) {
	b.member = nil
	b.leftAt = r.now()
	r.sailing = slices.DeleteFunc(r.sailing, func(o *roomBoat) bool { return o == b })
}

// input queues one input for m's boat; step applies it as one sim step, in seq order.
func (r *Room) input(m *member, seq int64, c sim.Controls) {
	if b := m.boat; b.member == m {
		b.queue.push(queuedInput{seq: seq, controls: clampControls(c)})
	}
}

// reset queues a respawn for m's boat at a free spawn slot at the room time, after the inputs
// already received.
func (r *Room) reset(m *member) {
	if b := m.boat; b.member == m {
		b.queue.push(queuedInput{reset: true})
	}
}

// stillAt is a fresh start state (StartSpeed, sail and crew at rest) at x, z and heading, at the room
// time: a boat coming back where it was, without the way it carried when its player left.
func (r *Room) stillAt(x, z, heading float64) sim.BoatState {
	s := sim.InitialState(heading, StartSpeed)
	s.T = r.time()
	s.X, s.Z = x, z
	return s
}

// spawn is the start state at the first spawn slot with no sailing boat other than self within
// spawnSpacing / 2.
func (r *Room) spawn(self *roomBoat) sim.BoatState {
	s := sim.InitialState(sim.Bay.Harbour.Departure.HeadingDeg*sim.DEG, StartSpeed)
	s.T = r.time()
	slot := r.slots[len(r.slots)-1] // unreachable: a boat blocks at most one slot and there are maxBoats
	for _, p := range r.slots {
		free := true
		for _, b := range r.sailing {
			if b != self && math.Hypot(b.state.X-p.X, b.state.Z-p.Z) < spawnSpacing/2 {
				free = false
				break
			}
		}
		if free {
			slot = p
			break
		}
	}
	s.X, s.Z = slot.X, slot.Z
	return s
}

// spawnSlots is the first n points of the spawnSpacing grid around the harbour departure point,
// nearest first; ties in the order (0, +), (0, -), (+, 0), (-, 0), then (+, +), (+, -), (-, +), (-, -).
func spawnSlots(n int) []sim.Vec2 {
	extent := int(math.Ceil(math.Sqrt(float64(n)))) // the n nearest grid points lie within this many steps
	order := make([]int, 0, 2*extent+1)
	order = append(order, 0)
	for k := 1; k <= extent; k++ {
		order = append(order, k, -k)
	}
	type cell struct{ i, j int }
	cells := make([]cell, 0, len(order)*len(order))
	for _, i := range order {
		for _, j := range order {
			cells = append(cells, cell{i, j})
		}
	}
	slices.SortStableFunc(cells, func(a, b cell) int { return (a.i*a.i + a.j*a.j) - (b.i*b.i + b.j*b.j) })
	dep := sim.Bay.Harbour.Departure
	slots := make([]sim.Vec2, n)
	for k := range slots {
		slots[k] = sim.Vec2{X: dep.X + float64(cells[k].i)*spawnSpacing, Z: dep.Z + float64(cells[k].j)*spawnSpacing}
	}
	return slots
}

// clampControls clamps like TS step (src/sim/step.ts), so snapshots report the controls as applied.
func clampControls(c sim.Controls) sim.Controls {
	return sim.Controls{
		Tiller: math.Min(1, math.Max(-1, c.Tiller)),
		Sheet:  math.Min(1, math.Max(0, c.Sheet)),
		Hike:   math.Min(1, math.Max(0, c.Hike)),
	}
}
