package sim

import (
	"encoding/json"
	"flag"
	"math"
	"os"
	"path/filepath"
	"testing"
)

var update = flag.Bool("update", false, "rewrite native Go golden snapshots in testdata/golden")

const goldenBigSeed uint32 = 0x9e3779b9

// Match JavaScript Math.round, including its treatment of negative half ties.
func goldenRound4(x float64) float64 { return math.Floor(x*1e4+0.5) / 1e4 }

func goldenControl(tiller, sheet, hike float64) Controls {
	return Controls{Tiller: goldenRound4(tiller), Sheet: goldenRound4(sheet), Hike: goldenRound4(hike)}
}

func goldenReach(i int) Controls {
	x := float64(i)
	return goldenControl(-0.07+0.03*math.Sin(x/70), 0.5+0.1*math.Sin(x/150), 0.15+0.15*math.Sin(x/200))
}

func goldenTacking(i int) Controls {
	phase, side := i%900, 1.0
	if i/900%2 != 0 {
		side = -1
	}
	if phase < 300 {
		return goldenControl(-0.1*side, 0.15, 0.3)
	}
	if phase < 660 {
		return goldenControl(1.2*side, 0.15, 0)
	}
	return goldenControl(0.1*side, 0.15, 0.3)
}

func goldenGybing(i int) Controls {
	phase, side := i%720, 1.0
	if i/720%2 != 0 {
		side = -1
	}
	if phase < 200 {
		return goldenControl(-0.06*side, 0.8, 0)
	}
	if phase < 440 {
		return goldenControl(-0.5*side, 0.2, 0)
	}
	return goldenControl(0.06*side, 0.8, 0)
}

type goldenScenario struct {
	name, description string
	config            SimConfig
	initial           BoatState
	steps             int
	controls          func(int) Controls
}

func goldenScenarios(t *testing.T) []goldenScenario {
	t.Helper()
	reachStart := InitialState(90*DEG, 1)
	list := []goldenScenario{{"flat-reach", "defaultConfig: calm water, constant 7 kn, beam reach with a tiller weave", DefaultConfigUnseeded(), reachStart, 1800, goldenReach}}
	for _, layer := range LayerIDs {
		cfg, err := WithDisabledLayers(DefaultConfigUnseeded(), []string{layer})
		if err != nil {
			t.Fatal(err)
		}
		list = append(list, goldenScenario{"no-" + layer, "flat-reach with the " + layer + " layer disabled", cfg, reachStart, 900, goldenReach})
	}
	withWind := func(speed float64) SimConfig {
		cfg := DefaultConfigUnseeded()
		cfg.Wind.SpeedKn = speed
		SetWaveWind(&cfg.Waves, speed)
		return cfg
	}
	gusts := DefaultConfigUnseeded()
	gusts.Wind.Gusts.Enabled = true
	waves := BrowserConfig(1)
	waves.Wind.Gusts.Enabled = false
	steep := withWind(16)
	steep.Waves.Enabled, steep.Waves.AmplitudeScale = true, 2
	SetWaveLayers(&steep.Waves, 2, 1)
	SetWaveParameters(&steep.Waves, 2, 135)
	groundEast, groundShoal := DefaultConfigUnseeded(), DefaultConfigUnseeded()
	groundEast.Land, groundShoal.Land = true, true
	east, shoal := reachStart, reachStart
	east.X, east.Z, east.U = 1700, 0, 2
	shoal.X, shoal.Z, shoal.U = 40, -800, 2
	printed, tank, rad := DefaultConfigUnseeded(), DefaultConfigUnseeded(), DefaultConfigUnseeded()
	printed.Models.LiftSlope = "printed"
	tank.Models.UprightResistance = "tank"
	rad.Models.Lambda0Unit = "rad"
	return append(list,
		goldenScenario{"upwind-tacks", "close-hauled, tack every 15 s (boom flip, crew crossing, tiller clamp, sternway in irons)", DefaultConfigUnseeded(), InitialState(55*DEG, 2), 3600, goldenTacking},
		goldenScenario{"downwind-gybes", "broad reaches through dead downwind, gybe every 12 s (boom flip, crew crossing)", DefaultConfigUnseeded(), InitialState(150*DEG, 2), 2880, goldenGybing},
		goldenScenario{"heel-clamp", "16 kn, sheeted in, sitting in: heel reaches the heel limit; sheet/hike below 0 are clamped", withWind(16), reachStart, 900, func(int) Controls { return goldenControl(0, -0.1, -0.2) }},
		goldenScenario{"waves", "browserConfig(1) with gusts off: waves sized by the wind, bay seabed on", waves, reachStart, 1800, goldenReach},
		goldenScenario{"moored", "browserConfig(1), gusts off, held at berth 0 with the sheet eased: heel and pitch on the waves, no translation", waves, MooredAt(Bay.Harbour.Berths[0], 0, BuildBoat(), &waves), 1800, func(int) Controls { return goldenControl(0, 1, 0) }},
		goldenScenario{"waves-steep", "16 kn, 2 s steep sea at the steepness limit, quartering: pitch clamp", steep, InitialState(0, 2), 1800, func(i int) Controls { return goldenControl(0.05*math.Sin(float64(i)/60), 0.3, 1) }},
		goldenScenario{"gusts", "defaultConfig with gusts and shifts on, flat water", gusts, reachStart, 1800, goldenReach},
		goldenScenario{"browser", "full browserConfig with a uint32 seed above 2^31 (waves, gusts, bay)", BrowserConfig(goldenBigSeed), reachStart, 1800, goldenReach},
		goldenScenario{"ground-east", "bay on: reach east from (1700, 0) onto the east shore, ground, then ease the sheet", groundEast, east, 8400, func(i int) Controls {
			if i < 7200 {
				return goldenReach(i)
			}
			return goldenControl(-0.07, 1, 0)
		}},
		goldenScenario{"ground-shoal", "bay on: reach across Holm Spit (150, -800, top 0.3 m deep), touching the shoal", groundShoal, shoal, 3600, goldenReach},
		goldenScenario{"zero-wind", "no wind: the boat coasts to rest from 2 m/s with a turned tiller", withWind(0), InitialState(30*DEG, 2), 1800, func(i int) Controls {
			if i < 600 {
				return goldenControl(0.5, 0.5, 0)
			}
			return goldenControl(0, 0.5, 0)
		}},
		goldenScenario{"model-liftslope-printed", "flat-reach with models.liftSlope = printed", printed, reachStart, 900, goldenReach},
		goldenScenario{"model-tank", "flat-reach with models.uprightResistance = tank", tank, reachStart, 900, goldenReach},
		goldenScenario{"model-lambda0-rad", "upwind with models.lambda0Unit = rad (large zero-lift drift)", rad, InitialState(55*DEG, 2), 900, goldenTacking},
	)
}

func writeGolden(t *testing.T, name string, value any) {
	t.Helper()
	data, err := json.Marshal(value) // Reject non-finite values rather than writing null.
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(goldenDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(goldenDir, name), append(data, '\n'), 0644); err != nil {
		t.Fatal(err)
	}
}

// Preserve the TS fixture's selected diagnostics rather than expanding its schema.
func goldenDiagnostics(t *testing.T, d Diagnostics) map[string]any {
	all := asJSON(t, d).(map[string]any)
	out := map[string]any{}
	for _, key := range []string{"total", "trueWind", "speed", "leeway", "vmg", "boomTarget", "boomSide"} {
		out[key] = all[key]
	}
	for key, fields := range map[string][]string{
		"apparent": {"u", "v", "speed", "angle"},
		"sail":     {"luffAmount", "stallAmount"},
		"waves":    {"height", "rollTarget", "pitchTarget"},
		"ground":   {"depth", "penetration"},
	} {
		out[key] = nil
		if source, ok := all[key].(map[string]any); ok {
			selected := map[string]any{}
			for _, field := range fields {
				selected[field] = source[field]
			}
			out[key] = selected
		}
	}
	return out
}

func writeGoldenTraces(t *testing.T) {
	boat := BuildBoat()
	for _, s := range goldenScenarios(t) {
		controls := make([]Controls, 0, s.steps)
		records := []any{}
		state := s.initial
		flips := 0
		var maxHeel, maxPitch, maxPenetration float64
		for i := range s.steps {
			c := s.controls(i)
			controls = append(controls, c)
			r := Step(state, c, boat, &s.config)
			if r.State.BoomSide != state.BoomSide {
				flips++
			}
			state = r.State
			maxHeel = math.Max(maxHeel, math.Abs(state.Heel)/DEG)
			maxPitch = math.Max(maxPitch, math.Abs(state.Pitch)/DEG)
			if r.Diagnostics.Ground != nil {
				maxPenetration = math.Max(maxPenetration, r.Diagnostics.Ground.Penetration)
			}
			if i < 120 || i%30 == 0 {
				records = append(records, map[string]any{"step": i, "state": state, "diag": goldenDiagnostics(t, r.Diagnostics)})
			}
		}
		writeGolden(t, "trace-"+s.name+".json", map[string]any{"name": s.name, "description": s.description, "config": s.config, "initial": s.initial, "steps": s.steps, "controls": controls, "record": records})
		t.Logf("%-24s boom flips %d, max heel %.1f deg, max pitch %.1f deg, max penetration %.2f m, final (%.0f, %.0f) heading %.0f deg, u %.2f m/s", s.name, flips, maxHeel, maxPitch, maxPenetration, state.X, state.Z, state.Heading/DEG, state.U)
	}
}

func goldenWaveSamples() []any {
	specs := []goldenWaveSpec{
		{true, 1, 1, 1, 1987, 7, 3.3953, 180},
		{true, 1, 1, 1, 1, 7, 3.3953, 180},
		{true, 1, 1, 1, goldenBigSeed, 12, 4.5, 225},
		{true, 1, 0.5, 2, 42, 1.5, 3, -30},
		{true, 2, 2.5, 1.5, 7, 16, 1, 400},
		{true, 1, 1, 1, 3, 0, 9, 90},
	}
	result := []any{}
	for _, spec := range specs {
		w := compileSpec(spec)
		// Store normalized inputs, just as the TS generator did after compilation.
		spec = goldenWaveSpec{w.Enabled, w.AmplitudeScale, w.BigScale, w.RippleScale, w.Seed, w.WindSpeedKn, w.PeriodSeconds, w.DirectionDeg}
		points := []any{}
		for _, p := range [][2]float64{{0, 0}, {3.7, -11.2}, {-25.5, 40.25}, {1700, 0}, {-812.3, 1543.9}, {12345.6, -9876.5}} {
			for _, time := range []float64{0, 0.25, 7.3, 61.017, 3600.5} {
				for _, depth := range []float64{0, -0.2, -0.75, -1.3, -3} {
					var out WaveSample
					SampleWaves(&w, p[0], p[1], time, depth, &out)
					points = append(points, map[string]any{"x": p[0], "z": p[1], "t": time, "depth": depth, "out": out})
				}
			}
		}
		result = append(result, map[string]any{"spec": spec, "components": w.Components, "amplitudeLimit": w.AmplitudeLimit, "amplitude": WaveAmplitude(&w), "points": points})
	}
	return result
}

func goldenWindSamples(t *testing.T) []any {
	configs := []WindConfig{
		{7, 0, GustConfig{false, 1, 1, 1}},
		{SpeedKn: 7},
		{7, 0, GustConfig{true, 1, 1, 1}},
		{12.5, 237, GustConfig{true, goldenBigSeed, 1.5, 0.5}},
		{4, 315, GustConfig{true, 0xffffffff, 2, 2}},
		{9, 45, GustConfig{true, 12345, 3, 1}},
		{0, 0, GustConfig{true, 5, 1, 1}},
	}
	positions := [][3]float64{}
	for i := range 60 {
		x := float64(i)
		positions = append(positions, [3]float64{goldenRound4(-2000 + float64(i*397%4000) + 0.37*x), goldenRound4(-2000 + float64(i*613%4000) - 0.21*x), goldenRound4(math.Mod(x*37.3, 600))})
	}
	positions = append(positions, [3]float64{-1e-3, -1e-3, 0}, [3]float64{90, -90, 1e4}, [3]float64{-4500.5, 3999.9, 86400})
	result := []any{}
	for i, cfg := range configs {
		points := []any{}
		for _, p := range positions {
			points = append(points, map[string]any{"x": p[0], "z": p[1], "t": p[2], "out": GetWind(Vec2{X: p[0], Z: p[1]}, p[2], &cfg)})
		}
		config := asJSON(t, cfg).(map[string]any)
		if i == 1 {
			delete(config, "gusts")
		} // Keep the missing-gusts schema case.
		result = append(result, map[string]any{"config": config, "points": points})
	}
	return result
}

func goldenWindTimeSamples(t *testing.T) []any {
	positions := []Vec2{{X: Bay.Harbour.Berths[0].X, Z: Bay.Harbour.Berths[0].Z}, {X: Bay.Harbour.Departure.X, Z: Bay.Harbour.Departure.Z}}
	for _, name := range []string{"N", "E", "S"} {
		found := false
		for _, b := range BuoyData.Buoys {
			if b.Name == name {
				positions = append(positions, Vec2{X: b.X, Z: b.Z})
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("missing windTime buoy %s", name)
		}
	}
	result := []any{}
	for _, seed := range []uint32{1, goldenBigSeed} {
		cfg := BrowserConfig(seed).Wind
		points := []any{}
		for _, p := range positions {
			for time := 0.0; time <= 600; time += 30 {
				points = append(points, map[string]any{"x": p.X, "z": p.Z, "t": time, "wind": GetWind(p, time, &cfg), "factor": WindSpeedFactor(p, time, &cfg)})
			}
		}
		result = append(result, map[string]any{"config": cfg, "points": points})
	}
	return result
}

func goldenTerrainSamples() []any {
	points := [][2]float64{}
	for x := -3000.0; x <= 3000; x += 150 {
		for z := -3000.0; z <= 3000; z += 150 {
			points = append(points, [2]float64{x, z})
		}
	}
	for x := 1700.0; x <= 2300; x += 7.5 {
		points = append(points, [2]float64{x, 0})
	}
	for d := -300.0; d <= 300; d += 12.5 {
		points = append(points, [2]float64{150 + d, -800}, [2]float64{700, 1150 + d})
	}
	points = append(points, [][2]float64{{-750, -950}, {-1400, -950}, {-750, -620}, {950, 850}, {1140, 850}, {0, 0}, {-7999, -7999}, {7999, 2600}, {0, 5000}, {0.5, -0.5}}...)
	result := []any{}
	for _, p := range points {
		g := TerrainGradient(p[0], p[1])
		result = append(result, map[string]any{"x": p[0], "z": p[1], "h": TerrainHeight(p[0], p[1]), "gx": g.X, "gz": g.Z})
	}
	return result
}

func goldenBoatSamples(t *testing.T) map[string]any {
	boat := BuildBoat()
	out := map[string]any{}
	for key, value := range asJSON(t, boat).(map[string]any) {
		if _, scalar := value.(float64); scalar || key == "board" || key == "rudder" {
			out[key] = value
		}
	}
	spline := func(s *CubicSpline, from, to, by float64) []any {
		points := []any{}
		for i := 0; from+float64(i)*by <= to+1e-9; i++ {
			x := goldenRound4(from + float64(i)*by)
			points = append(points, map[string]any{"x": x, "y": s.At(x)})
		}
		return points
	}
	out["splines"] = map[string]any{"clTable": spline(boat.ClTable, -10, 190, 2.5), "cdvTable": spline(boat.CdvTable, -10, 190, 2.5), "residuaryRatio": spline(boat.ResiduaryRatio, 0.05, 0.85, 0.0125)}
	return out
}

func writeGoldenSamples(t *testing.T) {
	landmarks := []any{}
	for _, l := range Landmarks {
		landmarks = append(landmarks, map[string]any{"name": l.Name, "base": l.Base})
	}
	writeGolden(t, "samples.json", map[string]any{"waves": goldenWaveSamples(), "wind": goldenWindSamples(t), "windTime": goldenWindTimeSamples(t), "terrain": goldenTerrainSamples(), "landmarks": landmarks, "boat": goldenBoatSamples(t)})
}
