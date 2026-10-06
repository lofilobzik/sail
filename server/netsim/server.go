package netsim

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	// writeTimeout bounds one frame write so a stalled client cannot hold its connection forever.
	writeTimeout = 5 * time.Second // TUNING GUESS
	// errorsSize buffers rejections between a connection's reader and writer.
	errorsSize = 16 // TUNING GUESS
)

// devOrigins lets the Vite dev server (another port on the same machine) open the socket.
var devOrigins = []string{"localhost:*", "127.0.0.1:*", "[::1]:*"}

// Server serves the WebSocket endpoint: every connection sails one boat in Room.
type Server struct {
	// Room is the shared world; its Run must be running.
	Room *Room
	// Log receives accept errors and shutdown disconnects; nil means log.Default().
	Log *log.Logger

	conns sync.WaitGroup
}

// Wait blocks until every connection has ended. http.Server.Shutdown does not wait for hijacked
// WebSocket connections; cancel their request context (http.Server.BaseContext) and then Wait.
func (s *Server) Wait() { s.conns.Wait() }

func (s *Server) logger() *log.Logger {
	if s.Log != nil {
		return s.Log
	}
	return log.Default()
}

// ServeHTTP upgrades the request, joins the room (resuming ?resume=<token> if it is live) and
// relays between the socket and the room until the client leaves, the boat is resumed elsewhere,
// or the request context or room ends.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.conns.Add(1)
	defer s.conns.Done()
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: devOrigins})
	if err != nil {
		s.logger().Printf("ws accept %s: %v", r.RemoteAddr, err)
		return
	}
	defer c.CloseNow()
	ctx := r.Context()
	room := s.Room

	resume := r.URL.Query().Get("resume")
	joined := make(chan joinResult, 1)
	if !room.do(ctx, func() { joined <- room.join(resume, r.RemoteAddr) }) {
		c.Close(websocket.StatusGoingAway, "server shutting down")
		return
	}
	var j joinResult
	select {
	case j = <-joined:
	case <-room.done:
		c.Close(websocket.StatusGoingAway, "server shutting down")
		return
	}
	if j.welcome == nil {
		_ = send(ctx, c, ErrorMessage{Type: TypeError, Message: MessageRoomFull})
		c.Close(StatusRoomFull, MessageRoomFull)
		return
	}

	err = s.relay(ctx, c, j)
	reason := err.Error()
	if status := websocket.CloseStatus(err); status != -1 {
		reason = fmt.Sprintf("client closed (%v)", status)
	}
	m := j.member
	if !room.do(context.Background(), func() { room.leave(m, r.RemoteAddr, reason) }) {
		s.logger().Printf("disconnect %s boat %d (%s), server shutting down", r.RemoteAddr, j.id, reason)
	}
	switch {
	case errors.Is(err, errReplaced):
		c.Close(StatusReplaced, "replaced")
	case errors.Is(err, context.Canceled), errors.Is(err, errRoomClosed):
		c.Close(websocket.StatusGoingAway, "server shutting down")
	}
}

var (
	errReplaced   = errors.New("resumed by a newer connection")
	errRoomClosed = errors.New("room closed")
)

// relay sends the welcome, then forwards checked client messages to the room and room snapshots
// and rejections to the client.
func (s *Server) relay(ctx context.Context, c *websocket.Conn, j joinResult) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	room, m := s.Room, j.member

	rejected := make(chan string, errorsSize)
	readErr := make(chan error, 1)
	// The reader ignores cancellation: cancelling a Read drops the connection without a close frame,
	// and ServeHTTP closes it properly instead (which also ends this goroutine).
	readCtx := context.WithoutCancel(ctx)
	go func() {
		var lastSeq int64 // input seq order is per connection
		for {
			typ, data, err := c.Read(readCtx)
			if err != nil {
				readErr <- err
				return
			}
			if typ != websocket.MessageText {
				data = nil // rejected as bad JSON
			}
			msg, err := parseClientMessage(data, lastSeq)
			if err != nil {
				select {
				case rejected <- err.Error():
				case <-ctx.Done():
					return
				}
				continue
			}
			var op func()
			switch msg.Type {
			case TypeInput:
				lastSeq = *msg.Seq
				seq, controls := *msg.Seq, *msg.Controls
				op = func() { room.input(m, seq, controls) }
			case TypeReset:
				op = func() { room.reset(m) }
			}
			if !room.do(ctx, op) {
				return
			}
		}
	}()

	if err := sendRaw(ctx, c, j.welcome); err != nil {
		return err
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-room.done:
			return errRoomClosed
		case <-m.replaced:
			return errReplaced
		case err := <-readErr:
			return err
		case frame := <-m.out:
			if err := sendRaw(ctx, c, frame); err != nil {
				return err
			}
		case msg := <-rejected:
			if err := send(ctx, c, ErrorMessage{Type: TypeError, Message: msg}); err != nil {
				return err
			}
		}
	}
}

func send(ctx context.Context, c *websocket.Conn, msg any) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return sendRaw(ctx, c, data)
}

func sendRaw(ctx context.Context, c *websocket.Conn, data []byte) error {
	ctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return c.Write(ctx, websocket.MessageText, data)
}
