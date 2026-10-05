package netsim

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"math"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	"sail/server/sim"
)

const (
	// DefaultSnapshotHz is the contract's snapshot rate.
	DefaultSnapshotHz = 20
	// writeTimeout bounds one frame write so a stalled client cannot hold its loop forever.
	writeTimeout = 5 * time.Second // TUNING GUESS
	// inboxSize buffers client messages between the reader and the sim loop (about 1 s of inputs at 60 Hz).
	inboxSize = 64 // TUNING GUESS
)

// devOrigins lets the Vite dev server (another port on the same machine) open the socket.
var devOrigins = []string{"localhost:*", "127.0.0.1:*", "[::1]:*"}

// boat is shared by all sessions: sim.Step only reads it.
var boat = sync.OnceValue(sim.BuildBoat)

// Server serves the WebSocket endpoint: one Session per connection.
type Server struct {
	// Seed picks the wave/gust seed of a new session.
	Seed func() uint32
	// SnapshotHz is the snapshot rate; <= 0 means DefaultSnapshotHz.
	SnapshotHz float64
	// Log receives connect/disconnect lines; nil means log.Default().
	Log *log.Logger

	sessions sync.WaitGroup
}

// Wait blocks until every session has ended. http.Server.Shutdown does not wait for hijacked
// WebSocket connections; cancel their request context (http.Server.BaseContext) and then Wait.
func (s *Server) Wait() { s.sessions.Wait() }

func (s *Server) logger() *log.Logger {
	if s.Log != nil {
		return s.Log
	}
	return log.Default()
}

func (s *Server) snapshotHz() float64 {
	if s.SnapshotHz > 0 {
		return s.SnapshotHz
	}
	return DefaultSnapshotHz
}

// ServeHTTP upgrades the request and runs the session until the client leaves or the request
// context ends.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.sessions.Add(1)
	defer s.sessions.Done()
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: devOrigins})
	if err != nil {
		s.logger().Printf("ws accept %s: %v", r.RemoteAddr, err)
		return
	}
	defer c.CloseNow()

	sess := NewSession(boat(), s.Seed())
	s.logger().Printf("connect %s seed=%d", r.RemoteAddr, sess.seed)
	err = s.run(r.Context(), c, sess)
	if status := websocket.CloseStatus(err); status != -1 {
		s.logger().Printf("disconnect %s after %d ticks: client closed (%v)", r.RemoteAddr, sess.Tick(), status)
		return
	}
	s.logger().Printf("disconnect %s after %d ticks: %v", r.RemoteAddr, sess.Tick(), err)
	if errors.Is(err, context.Canceled) {
		c.Close(websocket.StatusGoingAway, "server shutting down")
	}
}

// run owns the session: it applies client messages in arrival order, steps the sim at a fixed dt
// (ticker plus accumulator, so a late tick is caught up rather than lost) and sends snapshots.
func (s *Server) run(ctx context.Context, c *websocket.Conn, sess *Session) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	inbox := make(chan []byte, inboxSize)
	readErr := make(chan error, 1)
	// The reader ignores cancellation: cancelling a Read drops the connection without a close frame,
	// and ServeHTTP closes it properly instead (which also ends this goroutine).
	readCtx := context.WithoutCancel(ctx)
	go func() {
		for {
			typ, data, err := c.Read(readCtx)
			if err != nil {
				readErr <- err
				return
			}
			if typ != websocket.MessageText {
				data = nil // rejected as bad JSON by the session
			}
			select {
			case inbox <- data:
			case <-ctx.Done():
				return
			}
		}
	}()

	hz := s.snapshotHz()
	if err := send(ctx, c, sess.Welcome(hz)); err != nil {
		return err
	}

	dt := sess.Dt()
	fixed := sim.NewFixedStep(dt) // caps catch-up like the browser loop
	ticker := time.NewTicker(time.Duration(dt * float64(time.Second)))
	defer ticker.Stop()
	last := time.Now()
	snapshotDue := 0.0 // snapshots owed, in units of one snapshot

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-readErr:
			return err
		case data := <-inbox:
			if err := sess.HandleMessage(data); err != nil {
				if err := send(ctx, c, ErrorMessage{Type: TypeError, Message: err.Error()}); err != nil {
					return err
				}
			}
		case now := <-ticker.C:
			steps := fixed.Advance(now.Sub(last).Seconds())
			last = now
			for range steps {
				sess.Step()
			}
			snapshotDue += float64(steps) * dt * hz
			if snapshotDue >= 1 {
				snapshotDue -= math.Floor(snapshotDue) // after a long catch-up, one snapshot is enough
				if err := send(ctx, c, sess.Snapshot()); err != nil {
					return err
				}
			}
		}
	}
}

func send(ctx context.Context, c *websocket.Conn, msg any) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return c.Write(ctx, websocket.MessageText, data)
}
