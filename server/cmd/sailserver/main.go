// Command sailserver runs the authoritative sailing sim over WebSocket (/ws): one public room in
// which every connection sails its own boat in the same world. With -static it also serves the
// built site (dist/) on the same origin, so the page can reach /ws without cross-origin rules.
// GET /healthz answers 200 while the server runs.
//
//	go run ./server/cmd/sailserver [-addr :8080] [-seed N] [-snapshot-hz 20] [-max-boats 32] [-static dist] [-db sail.db]
//	sailserver -healthcheck   # exit 0 if the server on -addr answers /healthz (container health check)
package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"math/rand/v2"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"sail/server/netsim"
	"sail/server/store"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	seed := flag.Uint64("seed", 0, "wave/gust seed of the room (default: random at start)")
	snapshotHz := flag.Float64("snapshot-hz", netsim.DefaultSnapshotHz, "snapshots per second")
	maxBoats := flag.Int("max-boats", netsim.DefaultMaxBoats, "boats sailing in the room at once")
	static := flag.String("static", "", "directory with the built site to serve at / (default: none)")
	db := flag.String("db", "", "SQLite `file` for challenge progress (default: none, challenges off)")
	healthcheck := flag.Bool("healthcheck", false, "probe /healthz of the server on -addr and exit 0/1")
	flag.Parse()

	if *healthcheck {
		os.Exit(probe(*addr))
	}

	seeded := false
	flag.Visit(func(f *flag.Flag) { seeded = seeded || f.Name == "seed" })
	if *seed > 0xffffffff {
		log.Fatalf("-seed %d does not fit in uint32", *seed)
	}
	if *snapshotHz <= 0 {
		log.Fatalf("-snapshot-hz must be positive, got %v", *snapshotHz)
	}
	if *maxBoats <= 0 {
		log.Fatalf("-max-boats must be positive, got %d", *maxBoats)
	}
	roomSeed := rand.Uint32()
	if seeded {
		roomSeed = uint32(*seed)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg := netsim.RoomConfig{Seed: roomSeed, MaxBoats: *maxBoats, SnapshotHz: *snapshotHz}
	var st *store.Store
	if *db != "" {
		var err error
		if st, err = store.Open(*db); err != nil {
			log.Fatalf("-db %s: %v", *db, err)
		}
		cfg.Store = st // only a real store: a nil *store.Store would be a non-nil interface
	}
	room := netsim.NewRoom(cfg)
	roomDone := make(chan struct{})
	go func() {
		defer close(roomDone)
		room.Run(ctx)
	}()
	ws := &netsim.Server{Room: room}
	mux := http.NewServeMux()
	mux.Handle("/ws", ws)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok\n")) })
	if *static != "" {
		mux.Handle("/", staticSite(*static))
	}
	// Connections and the room hang off ctx, so a signal also ends the hijacked WebSocket connections.
	srv := &http.Server{Addr: *addr, Handler: mux, BaseContext: func(net.Listener) context.Context { return ctx }}

	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdown); err != nil {
			log.Printf("shutdown: %v", err)
		}
	}()

	log.Printf("sailserver on %s/ws (seed %d, snapshots %v Hz, max %d boats)", *addr, roomSeed, *snapshotHz, *maxBoats)
	if *static != "" {
		log.Printf("serving the site from %s", *static)
	}
	if st != nil {
		log.Printf("challenge progress in %s", *db)
	}
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	ws.Wait() // connections send their close frames
	<-roomDone
	room.WaitWrites() // queued challenge steps reach the database
	if st != nil {
		if err := st.Close(); err != nil {
			log.Printf("close %s: %v", *db, err)
		}
	}
}

// probe asks the local server's /healthz; the container image has no shell or curl.
func probe(addr string) int {
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		log.Printf("healthcheck: bad -addr %q: %v", addr, err)
		return 1
	}
	client := http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/healthz")
	if err != nil {
		log.Printf("healthcheck: %v", err)
		return 1
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		log.Printf("healthcheck: status %s", resp.Status)
		return 1
	}
	return 0
}
