package sim

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// Golden traces exported from the TypeScript sim by scripts/goldenTraces.ts (npm run golden) into
// testdata/golden/. Go and TS are not bit-identical (V8 and Go differ in the last ulps of
// sin/cos/exp/atan2/pow/log10), so values are compared within an absolute + relative tolerance:
// |got - want| <= abs + rel*|want|. Everything starts at 1e-9; loosen per scenario only, with a
// comment saying why and by how much.

const goldenDir = "testdata/golden"

type tolerance struct{ abs, rel float64 }

var strict = tolerance{abs: 1e-9, rel: 1e-9}

// traceTolerances: per scenario, for the first 120 steps (head) and the sparse tail. Scenarios
// not listed use strict for both. None needs loosening at present: on the committed fixtures the
// worst |err| / tolerance over all scenarios is about 0.013 (waves-steep tail, |err| 5e-11 on
// diag.total.fy), i.e. two orders of magnitude inside the strict 1e-9.
var traceTolerances = map[string]struct{ head, tail tolerance }{}

func goldenOrSkip(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(goldenDir, name))
	if errors.Is(err, fs.ErrNotExist) {
		t.Skipf("golden fixture %s/%s not found: generate it with `npm run golden` (scripts/goldenTraces.ts)", goldenDir, name)
	}
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// errStats tracks the largest deviation seen, for the test log.
type errStats struct {
	maxAbs   float64
	maxAbsAt string
	// worst ratio |got-want| / (abs + rel*|want|); <= 1 passes.
	maxRatio   float64
	maxRatioAt string
	failures   int
}

func (s *errStats) String() string {
	return fmt.Sprintf("max |err| %.3g (%s), max err/tol %.3g (%s)", s.maxAbs, s.maxAbsAt, s.maxRatio, s.maxRatioAt)
}

// compare walks want (decoded fixture JSON) and checks got (Go value marshalled to JSON and
// decoded) for every key present in want. Keys missing in Go are failures.
func compare(t *testing.T, path string, want, got any, tol tolerance, st *errStats) {
	t.Helper()
	fail := func(format string, args ...any) {
		st.failures++
		if st.failures <= 20 {
			t.Errorf("%s: "+format, append([]any{path}, args...)...)
		}
	}
	switch w := want.(type) {
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok {
			fail("want object, got %v", got)
			return
		}
		keys := make([]string, 0, len(w))
		for k := range w {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			gv, ok := g[k]
			if !ok {
				fail("key %q missing in Go", k)
				continue
			}
			compare(t, path+"."+k, w[k], gv, tol, st)
		}
	case []any:
		g, ok := got.([]any)
		if !ok || len(g) != len(w) {
			fail("want array of %d, got %v", len(w), got)
			return
		}
		for i := range w {
			compare(t, fmt.Sprintf("%s[%d]", path, i), w[i], g[i], tol, st)
		}
	case float64:
		g, ok := got.(float64)
		if !ok {
			fail("want %v, got %v", w, got)
			return
		}
		err := math.Abs(g - w)
		limit := tol.abs + tol.rel*math.Abs(w)
		if err > st.maxAbs {
			st.maxAbs, st.maxAbsAt = err, path
		}
		if ratio := err / limit; ratio > st.maxRatio {
			st.maxRatio, st.maxRatioAt = ratio, path
		}
		if !(err <= limit) {
			fail("got %.17g, want %.17g (|err| %.3g > %.3g)", g, w, err, limit)
		}
	default: // nil, bool, string
		if want != got {
			fail("got %v, want %v", got, want)
		}
	}
}

// asJSON converts a Go value to its generic JSON form (the TS field names via json tags).
func asJSON(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// waveSpec is the uncompiled part of a WaveConfig in the fixtures.
type goldenWaveSpec struct {
	Enabled        bool    `json:"enabled"`
	AmplitudeScale float64 `json:"amplitudeScale"`
	BigScale       float64 `json:"bigScale"`
	RippleScale    float64 `json:"rippleScale"`
	Seed           uint32  `json:"seed"`
	WindSpeedKn    float64 `json:"windSpeedKn"`
	PeriodSeconds  float64 `json:"periodSeconds"`
	DirectionDeg   float64 `json:"directionDeg"`
}

// compileSpec rebuilds a WaveConfig from its spec fields through the public API (the fixture's
// compiled components are compared against it, never used).
func compileSpec(s goldenWaveSpec) WaveConfig {
	w := DefaultConfig(s.Seed).Waves
	SetWaveLayers(&w, s.BigScale, s.RippleScale)
	SetWaveParameters(&w, s.PeriodSeconds, s.DirectionDeg)
	SetWaveWind(&w, s.WindSpeedKn)
	w.Enabled = s.Enabled
	w.AmplitudeScale = s.AmplitudeScale
	return w
}

func TestGoldenSamples(t *testing.T) {
	raw := goldenOrSkip(t, "samples.json")
	var samples struct {
		Waves []struct {
			Spec           goldenWaveSpec `json:"spec"`
			Components     any            `json:"components"`
			AmplitudeLimit float64        `json:"amplitudeLimit"`
			Amplitude      float64        `json:"amplitude"`
			Points         []struct {
				X, Z, T, Depth float64
				Out            any `json:"out"`
			} `json:"points"`
		} `json:"waves"`
		Wind []struct {
			Config WindConfig `json:"config"`
			Points []struct {
				X, Z, T float64
				Out     any `json:"out"`
			} `json:"points"`
		} `json:"wind"`
		Terrain []struct {
			X, Z, H, Gx, Gz float64
		} `json:"terrain"`
		Landmarks []struct {
			Name string  `json:"name"`
			Base float64 `json:"base"`
		} `json:"landmarks"`
		Boat map[string]any `json:"boat"`
	}
	if err := json.Unmarshal(raw, &samples); err != nil {
		t.Fatal(err)
	}

	t.Run("waves", func(t *testing.T) {
		st := &errStats{}
		for i, w := range samples.Waves {
			cfg := compileSpec(w.Spec)
			p := fmt.Sprintf("waves[%d]", i)
			compare(t, p+".components", w.Components, asJSON(t, cfg.Components), strict, st)
			compare(t, p+".amplitudeLimit", w.AmplitudeLimit, cfg.AmplitudeLimit, strict, st)
			compare(t, p+".amplitude", w.Amplitude, WaveAmplitude(&cfg), strict, st)
			for j, pt := range w.Points {
				var out WaveSample
				SampleWaves(&cfg, pt.X, pt.Z, pt.T, pt.Depth, &out)
				compare(t, fmt.Sprintf("%s.points[%d]", p, j), pt.Out, asJSON(t, out), strict, st)
			}
		}
		t.Log(st)
	})

	t.Run("wind", func(t *testing.T) {
		st := &errStats{}
		for i, w := range samples.Wind {
			for j, pt := range w.Points {
				got := GetWind(Vec2{X: pt.X, Z: pt.Z}, pt.T, &w.Config)
				compare(t, fmt.Sprintf("wind[%d].points[%d]", i, j), pt.Out, asJSON(t, got), strict, st)
			}
		}
		t.Log(st)
	})

	t.Run("terrain", func(t *testing.T) {
		st := &errStats{}
		for i, pt := range samples.Terrain {
			p := fmt.Sprintf("terrain[%d](%g,%g)", i, pt.X, pt.Z)
			compare(t, p+".h", pt.H, TerrainHeight(pt.X, pt.Z), strict, st)
			g := TerrainGradient(pt.X, pt.Z)
			compare(t, p+".gx", pt.Gx, g.X, strict, st)
			compare(t, p+".gz", pt.Gz, g.Z, strict, st)
		}
		if len(samples.Landmarks) != len(Landmarks) {
			t.Fatalf("landmarks: want %d, got %d", len(samples.Landmarks), len(Landmarks))
		}
		for i, l := range samples.Landmarks {
			if Landmarks[i].Name != l.Name {
				t.Errorf("landmark %d: name %q, want %q", i, Landmarks[i].Name, l.Name)
			}
			compare(t, "landmarks."+l.Name+".base", l.Base, Landmarks[i].Base, strict, st)
		}
		t.Log(st)
	})

	t.Run("boat", func(t *testing.T) {
		st := &errStats{}
		boat := BuildBoat()
		want := samples.Boat
		splines, _ := want["splines"].(map[string]any)
		scalars := map[string]any{}
		for k, v := range want {
			if k != "splines" {
				scalars[k] = v
			}
		}
		compare(t, "boat", scalars, asJSON(t, boat), strict, st)
		tables := map[string]*CubicSpline{"clTable": boat.ClTable, "cdvTable": boat.CdvTable, "residuaryRatio": boat.ResiduaryRatio}
		for name, pts := range splines {
			s, ok := tables[name]
			if !ok {
				t.Errorf("unknown spline %q", name)
				continue
			}
			for j, pt := range pts.([]any) {
				m := pt.(map[string]any)
				compare(t, fmt.Sprintf("boat.splines.%s[%d]", name, j), m["y"], s.At(m["x"].(float64)), strict, st)
			}
		}
		t.Log(st)
	})
}

func TestGoldenTraces(t *testing.T) {
	files, err := filepath.Glob(filepath.Join(goldenDir, "trace-*.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) == 0 {
		t.Skipf("no golden traces in %s: generate them with `npm run golden` (scripts/goldenTraces.ts)", goldenDir)
	}
	boat := BuildBoat()
	for _, file := range files {
		name := strings.TrimSuffix(strings.TrimPrefix(filepath.Base(file), "trace-"), ".json")
		t.Run(name, func(t *testing.T) {
			raw, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			var trace struct {
				Name     string          `json:"name"`
				Config   json.RawMessage `json:"config"`
				Initial  BoatState       `json:"initial"`
				Steps    int             `json:"steps"`
				Controls []Controls      `json:"controls"`
				Record   []struct {
					Step  int `json:"step"`
					State any `json:"state"`
					Diag  any `json:"diag"`
				} `json:"record"`
			}
			if err := json.Unmarshal(raw, &trace); err != nil {
				t.Fatal(err)
			}
			var cfg SimConfig
			if err := json.Unmarshal(trace.Config, &cfg); err != nil {
				t.Fatal(err)
			}
			var spec struct {
				Waves goldenWaveSpec `json:"waves"`
			}
			if err := json.Unmarshal(trace.Config, &spec); err != nil {
				t.Fatal(err)
			}
			fixtureWaves := asJSON(t, cfg.Waves)
			cfg.Waves = compileSpec(spec.Waves)
			head, tail := strict, strict
			if tt, ok := traceTolerances[name]; ok {
				head, tail = tt.head, tt.tail
			}
			cst := &errStats{}
			compare(t, "config.waves", fixtureWaves, asJSON(t, cfg.Waves), strict, cst)

			headSt, tailSt := &errStats{}, &errStats{}
			s := trace.Initial
			next := 0
			for i, c := range trace.Controls {
				r := Step(s, c, boat, &cfg)
				s = r.State
				if next >= len(trace.Record) || trace.Record[next].Step != i {
					continue
				}
				rec := trace.Record[next]
				next++
				tol, st := head, headSt
				if i >= 120 {
					tol, st = tail, tailSt
				}
				p := fmt.Sprintf("step %d", i)
				compare(t, p+".state", rec.State, asJSON(t, s), tol, st)
				compare(t, p+".diag", rec.Diag, asJSON(t, r.Diagnostics), tol, st)
			}
			if next != len(trace.Record) {
				t.Errorf("only %d of %d records reached (steps %d)", next, len(trace.Record), len(trace.Controls))
			}
			t.Logf("steps 0-119 (abs %g rel %g): %v", head.abs, head.rel, headSt)
			t.Logf("tail (abs %g rel %g): %v", tail.abs, tail.rel, tailSt)
		})
	}
}
