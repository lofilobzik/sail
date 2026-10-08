package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const code = "ABCDEFGHIJKLMNOPQRST"

func open(t *testing.T) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "t.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s, path
}

func TestUnknownCodeWritesNothing(t *testing.T) {
	s, _ := open(t)
	p, err := s.Progress(context.Background(), code)
	if err != nil || len(p) != 0 {
		t.Fatalf("progress = %v, %v", p, err)
	}
	var n int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM players").Scan(&n); err != nil || n != 0 {
		t.Fatalf("players = %d, %v", n, err)
	}
	if _, err := s.Progress(context.Background(), "bad"); err == nil {
		t.Fatal("malformed code accepted")
	}
}

func TestCompletion(t *testing.T) {
	s, _ := open(t)
	ctx := context.Background()
	at := time.UnixMilli(1000)
	steps := []string{"a", "b", "c", "d", "e"}
	for i, st := range steps {
		ch, err := s.RecordStep(ctx, code, "tour", st, 5, at.Add(time.Duration(i)*time.Second))
		if err != nil {
			t.Fatal(err)
		}
		if len(ch.Steps) != i+1 || ch.Steps[i] != st {
			t.Fatalf("steps = %v", ch.Steps)
		}
		if done := !ch.CompletedAt.IsZero(); done != (i == 4) {
			t.Fatalf("step %d: completed = %v", i, done)
		}
	}
	ch, err := s.RecordStep(ctx, code, "tour", "a", 5, at.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(ch.Steps) != 5 || ch.CompletedAt.UnixMilli() != at.Add(4*time.Second).UnixMilli() {
		t.Fatalf("repeat changed progress: %+v", ch)
	}
}

func TestReopen(t *testing.T) {
	s, path := open(t)
	ctx := context.Background()
	if _, err := s.RecordStep(ctx, code, "tour", "a", 2, time.UnixMilli(5)); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s2, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	p, err := s2.Progress(ctx, code)
	if err != nil || len(p["tour"].Steps) != 1 || p["tour"].Steps[0] != "a" {
		t.Fatalf("progress = %v, %v", p, err)
	}
}

func TestPosition(t *testing.T) {
	s, _ := open(t)
	ctx := context.Background()
	if _, ok, err := s.LastPosition(ctx, code); ok || err != nil {
		t.Fatalf("unknown code: ok %v, %v", ok, err)
	}
	for _, p := range []Position{{X: 1, Z: 2, Heading: 3}, {X: -4, Z: 5.5, Heading: -0.5}} {
		if err := s.SavePosition(ctx, code, p, time.UnixMilli(9)); err != nil {
			t.Fatal(err)
		}
		if got, ok, err := s.LastPosition(ctx, code); !ok || err != nil || got != p {
			t.Fatalf("position = %+v %v %v, want %+v", got, ok, err, p)
		}
	}
}

// A database written by the first schema version gains positions and keeps its progress.
func TestMigrateFromVersion1(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{migrations[0], "PRAGMA user_version = 1", "INSERT INTO players VALUES ('" + code + "', 0)", "INSERT INTO steps VALUES ('" + code + "', 'tour', 'a', 0)"} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	db.Close()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	if p, err := s.Progress(ctx, code); err != nil || len(p["tour"].Steps) != 1 {
		t.Fatalf("progress = %v, %v", p, err)
	}
	if err := s.SavePosition(ctx, code, Position{X: 1}, time.Now()); err != nil {
		t.Fatal(err)
	}
}

func TestValidCode(t *testing.T) {
	if !ValidCode(code) {
		t.Fatal("valid code rejected")
	}
	for _, bad := range []string{code[:19], code + "A", strings.ToLower(code), "0" + code[1:], "1" + code[1:], "8" + code[1:], "9" + code[1:], ""} {
		if ValidCode(bad) {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestConcurrentSameStep(t *testing.T) {
	s, _ := open(t)
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := s.RecordStep(context.Background(), code, "tour", "a", 5, time.Now()); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	var n int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM steps").Scan(&n); err != nil || n != 1 {
		t.Fatalf("rows = %d, %v", n, err)
	}
}
