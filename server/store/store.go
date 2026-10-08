// Package store is the persistent player progress: challenge steps and completions in SQLite.
// Players are anonymous: a code is a client-generated bearer secret, the server only validates its
// format. A player row is created lazily with the first recorded step.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	_ "modernc.org/sqlite" // pure-Go driver "sqlite"
)

// Challenge is one player's progress in one challenge.
type Challenge struct {
	// Steps in the order recorded.
	Steps []string
	// CompletedAt is zero until the challenge is complete.
	CompletedAt time.Time
}

// codeLen and codeAlphabet define a sailor code: 20 chars of base32 (100 bits).
const (
	codeLen      = 20
	codeAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
)

// ValidCode reports whether code is exactly 20 chars of [A-Z2-7].
func ValidCode(code string) bool {
	if len(code) != codeLen {
		return false
	}
	for i := range len(code) {
		c := code[i]
		if !(c >= 'A' && c <= 'Z' || c >= '2' && c <= '7') {
			return false
		}
	}
	return true
}

// migrations are applied in order, each in one transaction; PRAGMA user_version is the number applied.
var migrations = []string{
	`CREATE TABLE players (code TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE steps (player TEXT NOT NULL REFERENCES players(code) ON DELETE CASCADE, challenge TEXT NOT NULL, step TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (player, challenge, step));
CREATE TABLE completions (player TEXT NOT NULL REFERENCES players(code) ON DELETE CASCADE, challenge TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (player, challenge));`,
	`CREATE TABLE positions (player TEXT PRIMARY KEY REFERENCES players(code) ON DELETE CASCADE, x REAL NOT NULL, z REAL NOT NULL, heading REAL NOT NULL, at INTEGER NOT NULL);`,
}

// Store is an open database.
type Store struct{ db *sql.DB }

// Open opens (creating if needed) the SQLite file at path and applies pending migrations.
func Open(path string) (*Store, error) {
	dsn := "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // one writer, no lock contention
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) migrate() error {
	ctx := context.Background()
	var version int
	if err := s.db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version > len(migrations) {
		return fmt.Errorf("database schema version %d is newer than this server (%d)", version, len(migrations))
	}
	for i := version; i < len(migrations); i++ {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, migrations[i]); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %d: %w", i+1, err)
		}
		// PRAGMA does not take parameters; i is ours.
		if _, err := tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", i+1)); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %d: %w", i+1, err)
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

type querier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// load reads every challenge of code: steps by (at, step), completions.
func load(ctx context.Context, q querier, code string) (map[string]Challenge, error) {
	out := map[string]Challenge{}
	rows, err := q.QueryContext(ctx, "SELECT challenge, step FROM steps WHERE player = ? ORDER BY at, step", code)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var ch, step string
		if err := rows.Scan(&ch, &step); err != nil {
			rows.Close()
			return nil, err
		}
		c := out[ch]
		c.Steps = append(c.Steps, step)
		out[ch] = c
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows, err = q.QueryContext(ctx, "SELECT challenge, at FROM completions WHERE player = ?", code)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var ch string
		var at int64
		if err := rows.Scan(&ch, &at); err != nil {
			return nil, err
		}
		c := out[ch]
		c.CompletedAt = time.UnixMilli(at)
		out[ch] = c
	}
	return out, rows.Err()
}

// Progress is code's progress by challenge id; empty for an unknown code. A malformed code is an error.
func (s *Store) Progress(ctx context.Context, code string) (map[string]Challenge, error) {
	if !ValidCode(code) {
		return nil, errors.New("malformed player code")
	}
	return load(ctx, s.db, code)
}

// RecordStep records that code reached step of challenge (idempotent) and completes the challenge
// once total steps are recorded. It returns the challenge's progress.
func (s *Store) RecordStep(ctx context.Context, code, challenge, step string, total int, at time.Time) (Challenge, error) {
	if !ValidCode(code) {
		return Challenge{}, errors.New("malformed player code")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Challenge{}, err
	}
	defer tx.Rollback()
	ms := at.UnixMilli()
	if _, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO players (code, created_at) VALUES (?, ?)", code, ms); err != nil {
		return Challenge{}, err
	}
	if _, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO steps (player, challenge, step, at) VALUES (?, ?, ?, ?)", code, challenge, step, ms); err != nil {
		return Challenge{}, err
	}
	var n int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM steps WHERE player = ? AND challenge = ?", code, challenge).Scan(&n); err != nil {
		return Challenge{}, err
	}
	if n >= total {
		if _, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO completions (player, challenge, at) VALUES (?, ?, ?)", code, challenge, ms); err != nil {
			return Challenge{}, err
		}
	}
	all, err := load(ctx, tx, code)
	if err != nil {
		return Challenge{}, err
	}
	if err := tx.Commit(); err != nil {
		return Challenge{}, err
	}
	return all[challenge], nil
}

// Position is where a player's boat was when it left: world x east, z south, m; heading, rad.
type Position struct {
	X, Z, Heading float64
}

// SavePosition replaces code's last position.
func (s *Store) SavePosition(ctx context.Context, code string, p Position, at time.Time) error {
	if !ValidCode(code) {
		return errors.New("malformed player code")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ms := at.UnixMilli()
	if _, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO players (code, created_at) VALUES (?, ?)", code, ms); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "INSERT OR REPLACE INTO positions (player, x, z, heading, at) VALUES (?, ?, ?, ?, ?)", code, p.X, p.Z, p.Heading, ms); err != nil {
		return err
	}
	return tx.Commit()
}

// LastPosition is code's last saved position; ok is false when none is stored.
func (s *Store) LastPosition(ctx context.Context, code string) (p Position, ok bool, err error) {
	if !ValidCode(code) {
		return p, false, errors.New("malformed player code")
	}
	err = s.db.QueryRowContext(ctx, "SELECT x, z, heading FROM positions WHERE player = ?", code).Scan(&p.X, &p.Z, &p.Heading)
	if errors.Is(err, sql.ErrNoRows) {
		return p, false, nil
	}
	return p, err == nil, err
}
