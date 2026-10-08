package netsim

import (
	"context"
	"encoding/json"
	"slices"
	"time"

	"sail/server/sim"
	"sail/server/store"
)

// Store is the player persistence the room needs (challenge progress, last boat position);
// *store.Store satisfies it.
type Store interface {
	Progress(ctx context.Context, code string) (map[string]store.Challenge, error)
	RecordStep(ctx context.Context, code, challenge, step string, total int, at time.Time) (store.Challenge, error)
	LastPosition(ctx context.Context, code string) (store.Position, bool, error)
	SavePosition(ctx context.Context, code string, p store.Position, at time.Time) error
}

// unsavedStep is a visit the room has detected whose write the store has not yet confirmed.
type unsavedStep struct {
	code     string
	inflight bool
	retryAt  time.Time
}

// saveJob is one queued write: a challenge step (entry is the exact unsavedStep it was queued for),
// or, when pos is set, a player's last position.
type saveJob struct {
	boat  *roomBoat
	index int
	entry *unsavedStep
	code  string
	step  string
	pos   *store.Position
}

// playerInfo is a connection's resolved sailor code, its stored progress and its boat's last
// position (nil when none is stored).
type playerInfo struct {
	code     string
	progress map[string]store.Challenge
	position *store.Position
}

// resolve reads code's progress from the store. It returns nil (the connection then plays without
// challenges) when challenges are off, the code is malformed, or the read fails. It blocks on the
// store: call it from the connection goroutine, not the room loop.
func (r *Room) resolve(ctx context.Context, code string) *playerInfo {
	if r.store == nil || !store.ValidCode(code) {
		return nil
	}
	progress, err := r.store.Progress(ctx, code)
	if err != nil {
		r.log.Printf("progress %s: %v", code, err)
		return nil
	}
	info := &playerInfo{code: code, progress: progress}
	switch pos, ok, err := r.store.LastPosition(ctx, code); {
	case err != nil:
		r.log.Printf("position %s: %v", code, err) // the boat then starts at a spawn slot
	case ok:
		info.position = &pos
	}
	return info
}

// statuses is the buoy tour's status for the wire.
func (r *Room) statuses(progress map[string]store.Challenge) []ChallengeStatus {
	tour := sim.ChallengeParams.BuoyTour
	c := progress[tour.ID]
	st := ChallengeStatus{ID: tour.ID, Steps: c.Steps, Total: len(sim.BuoyData.Buoys)}
	if st.Steps == nil {
		st.Steps = []string{}
	}
	if !c.CompletedAt.IsZero() {
		st.CompletedAt = c.CompletedAt.UnixMilli()
	}
	return []ChallengeStatus{st}
}

// seedProgress sets b's visited flags from stored progress and its pending visits (join).
func (r *Room) seedProgress(b *roomBoat, p *playerInfo) {
	if p == nil {
		if len(b.unsaved) > 0 {
			r.log.Printf("boat %d: dropped %d unsaved challenge steps (no player)", b.id, len(b.unsaved))
		}
		b.player, b.visited, b.unsaved = "", nil, nil
		return
	}
	if p.code != b.player && len(b.unsaved) > 0 {
		r.log.Printf("boat %d: dropped %d unsaved challenge steps (player changed)", b.id, len(b.unsaved))
		b.unsaved = nil
	}
	b.player = p.code
	stored := p.progress[sim.ChallengeParams.BuoyTour.ID].Steps
	b.visited = make([]bool, len(sim.BuoyData.Buoys))
	for i, buoy := range sim.BuoyData.Buoys {
		b.visited[i] = slices.Contains(stored, buoy.Name) || b.unsaved[i] != nil
	}
}

// observe marks every buoy within the visit radius of b as visited and queues its write.
func (r *Room) observe(b *roomBoat) {
	if b.player == "" {
		return
	}
	radius := sim.ChallengeParams.BuoyTour.Radius
	for i, buoy := range sim.BuoyData.Buoys {
		if b.visited[i] {
			continue
		}
		dx, dz := buoy.X-b.state.X, buoy.Z-b.state.Z
		if dx*dx+dz*dz > radius*radius {
			continue
		}
		b.visited[i] = true
		if b.unsaved == nil {
			b.unsaved = map[int]*unsavedStep{}
		}
		b.unsaved[i] = &unsavedStep{code: b.player}
		r.save(b, i)
	}
}

// save queues the write of b's unsaved visit i; a full queue counts as a failure the sweep retries.
func (r *Room) save(b *roomBoat, i int) {
	u := b.unsaved[i]
	if u == nil || u.inflight {
		return
	}
	select {
	case r.saves <- saveJob{boat: b, index: i, entry: u, code: u.code, step: sim.BuoyData.Buoys[i].Name}:
		u.inflight = true
	default:
		u.retryAt = r.now().Add(saveRetryDelay)
	}
}

// writeLoop is the one writer: stores jobs in the order they were queued, then reports each step
// result to the Run goroutine, so confirmations arrive in the same order. Position writes are best
// effort: a failure is logged, not retried.
func (r *Room) writeLoop() {
	defer close(r.saveDone)
	total := len(sim.BuoyData.Buoys)
	for job := range r.saves {
		if job.pos != nil {
			if err := r.store.SavePosition(context.Background(), job.code, *job.pos, r.now()); err != nil {
				r.log.Printf("save position %s: %v", job.code, err)
			}
			continue
		}
		ch, err := r.store.RecordStep(context.Background(), job.code, sim.ChallengeParams.BuoyTour.ID, job.step, total, r.now())
		r.do(context.Background(), func() { r.saved(job, ch, err) })
	}
}

// savePosition queues b's position as its player's last one (Run goroutine). block waits for room
// in the queue (shutdown, while the writer drains); otherwise a full queue drops it, logged.
func (r *Room) savePosition(b *roomBoat, block bool) {
	if r.store == nil || b.player == "" {
		return
	}
	job := saveJob{code: b.player, pos: &store.Position{X: b.state.X, Z: b.state.Z, Heading: b.state.Heading}}
	if block {
		r.saves <- job
		return
	}
	select {
	case r.saves <- job:
	default:
		r.log.Printf("boat %d: position not saved, write queue full", b.id)
	}
}

// saved handles a finished write on the Run goroutine.
func (r *Room) saved(job saveJob, ch store.Challenge, err error) {
	u := job.boat.unsaved[job.index]
	if u == nil || u != job.entry || u.code != job.code || job.boat.player != job.code {
		return // the boat switched sailor code meanwhile; the write itself landed under job.code
	}
	if err != nil {
		u.inflight = false
		u.retryAt = r.now().Add(saveRetryDelay)
		r.log.Printf("save %s %s: %v", sim.ChallengeParams.BuoyTour.ID, job.step, err)
		return
	}
	delete(job.boat.unsaved, job.index)
	if m := job.boat.member; m != nil {
		frame, err := json.Marshal(ChallengesMessage{
			Type:       TypeChallenges,
			Challenges: r.statuses(map[string]store.Challenge{sim.ChallengeParams.BuoyTour.ID: ch}),
		})
		if err != nil {
			panic(err)
		}
		select {
		case m.news <- frame:
		default: // at most one frame per buoy per connection fits by construction
		}
	}
}

// retryUnsaved re-queues every unsaved visit whose retry time has come.
func (r *Room) retryUnsaved() {
	if r.store == nil {
		return
	}
	now := r.now()
	for _, b := range r.byToken {
		for i, u := range b.unsaved {
			if !u.inflight && !now.Before(u.retryAt) {
				r.save(b, i)
			}
		}
	}
}

// WaitWrites blocks until the writer has stored every queued job; call after Run has returned.
func (r *Room) WaitWrites() { <-r.saveDone }
