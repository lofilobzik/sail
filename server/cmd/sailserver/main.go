// Command sailserver runs the authoritative sailing sim over WebSocket (/ws): one boat per connection.
// With -static it also serves the built site (dist/) on the same origin, so the page can reach
// /ws without cross-origin rules. GET /healthz answers 200 while the server runs.
//
//	go run ./server/cmd/sailserver [-addr :8080] [-seed N] [-snapshot-hz 20] [-static dist]
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
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	seed := flag.Uint64("seed", 0, "wave/gust seed for every session (default: random per session)")
	snapshotHz := flag.Float64("snapshot-hz", netsim.DefaultSnapshotHz, "snapshots per second")
	static := flag.String("static", "", "directory with the built site to serve at / (default: none)")
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
	pick := rand.Uint32
	if seeded {
		fixed := uint32(*seed)
		pick = func() uint32 { return fixed }
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	ws := &netsim.Server{Seed: pick, SnapshotHz: *snapshotHz}
	mux := http.NewServeMux()
	mux.Handle("/ws", ws)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok\n")) })
	if *static != "" {
		mux.Handle("/", staticSite(*static))
	}
	// Sessions hang off ctx, so a signal also ends the hijacked WebSocket connections.
	srv := &http.Server{Addr: *addr, Handler: mux, BaseContext: func(net.Listener) context.Context { return ctx }}

	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdown); err != nil {
			log.Printf("shutdown: %v", err)
		}
	}()

	if seeded {
		log.Printf("sailserver on %s/ws (seed %d, snapshots %v Hz)", *addr, *seed, *snapshotHz)
	} else {
		log.Printf("sailserver on %s/ws (random seed per session, snapshots %v Hz)", *addr, *snapshotHz)
	}
	if *static != "" {
		log.Printf("serving the site from %s", *static)
	}
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	ws.Wait() // sessions send their close frames
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
