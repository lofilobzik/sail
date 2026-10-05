// Command polar is the Go port of scripts/polar.ts: a headless polar (PHYSICS.md section 5). For
// each true wind speed and true wind angle: hold the heading with an autopilot, search the sheet
// for the best boat speed, sail to steady state, record. Also runs a head-to-wind (in irons) test.
//
// Usage (same flags as the TS script):
//
//	go run ./server/cmd/polar [--tws 6,7,8] [--twa-step 5] [--disable sail,foils]
//	    [--disable-terms windage,downwash] [--enable-terms zeroLiftDrift]
//	    [--model liftSlope=printed,lambda0Unit=rad,lambda0Sign=-1,uprightResistance=tank]
//	    [--set rig.luffStartBetaEffDeg=20,crew.sitInOffset=0.3] [--quiet]
//	    [--out polar-out] [--waves] [--wave-amplitude 0..2]
//
// Layers: apparentWind, sail, foils, hull, heel, yaw.
// --set overrides numeric values of the boat config (data/laser.json) for tuning experiments.
// When 9 kn is in --tws, the 9 kn result is compared with Day 2017 Figs 4 and 6
// (data/laser-polar-target.json). Outputs <out>/polar.csv, <out>/polar.svg and a summary on stdout.
// True wind angles run in parallel goroutines; the results do not depend on scheduling.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"

	"sail/data"
	"sail/server/sim"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "polar:", err)
		os.Exit(1)
	}
}

func list(s string) []string {
	var out []string
	for _, x := range strings.Split(s, ",") {
		if x = strings.TrimSpace(x); x != "" {
			out = append(out, x)
		}
	}
	return out
}

// number is JS Number(s) for the inputs the script accepts.
func number(s string) float64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return math.NaN()
	}
	return v
}

func isFinite(x float64) bool { return !math.IsNaN(x) && !math.IsInf(x, 0) }

// fixed is Number.prototype.toFixed.
func fixed(x float64, d int) string { return strconv.FormatFloat(x, 'f', d, 64) }

// jsString is the JS number-to-string conversion for the plain (non-exponent) values printed here.
func jsString(x float64) string { return strconv.FormatFloat(x, 'f', -1, 64) }

func pad(s string, width int) string { return fmt.Sprintf("%*s", width, s) }

// setTerms switches named terms through their JSON names (the TS keys).
func setTerms(cfg *sim.SimConfig, names []string, on bool) error {
	b, _ := json.Marshal(cfg.Terms)
	var terms map[string]bool
	_ = json.Unmarshal(b, &terms)
	for _, name := range names {
		if _, ok := terms[name]; !ok {
			keys := make([]string, 0, len(terms))
			for k := range terms {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			return fmt.Errorf("unknown term %q, expected one of %s", name, strings.Join(keys, ", "))
		}
		terms[name] = on
	}
	b, _ = json.Marshal(terms)
	return json.Unmarshal(b, &cfg.Terms)
}

func setModels(cfg *sim.SimConfig, kvs []string) error {
	b, _ := json.Marshal(cfg.Models)
	var models map[string]any
	_ = json.Unmarshal(b, &models)
	for _, kv := range kvs {
		key, value, ok := strings.Cut(kv, "=")
		current, known := models[key]
		if !ok || key == "" || !known {
			keys := make([]string, 0, len(models))
			for k := range models {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			return fmt.Errorf("bad --model %q, keys: %s", kv, strings.Join(keys, ", "))
		}
		if _, isNumber := current.(float64); isNumber {
			models[key] = number(value)
		} else {
			models[key] = value
		}
	}
	b, _ = json.Marshal(models)
	return json.Unmarshal(b, &cfg.Models)
}

// boatConfig applies --set overrides to data/laser.json by key path.
func boatConfig(sets []string) (sim.BoatConfig, error) {
	raw, err := data.FS.ReadFile("laser.json")
	if err != nil {
		return sim.BoatConfig{}, err
	}
	var tree map[string]any
	if err := json.Unmarshal(raw, &tree); err != nil {
		return sim.BoatConfig{}, err
	}
	for _, kv := range sets {
		path, value, ok := strings.Cut(kv, "=")
		keys := strings.Split(path, ".")
		obj := tree
		for _, k := range keys[:len(keys)-1] {
			next, _ := obj[k].(map[string]any)
			obj = next
		}
		last := keys[len(keys)-1]
		if _, isNumber := obj[last].(float64); !isNumber || !ok {
			return sim.BoatConfig{}, fmt.Errorf("bad --set %q (numeric boat config path required)", kv)
		}
		obj[last] = number(value)
	}
	b, err := json.Marshal(tree)
	if err != nil {
		return sim.BoatConfig{}, err
	}
	var cfg sim.BoatConfig
	err = json.Unmarshal(b, &cfg)
	return cfg, err
}

type polarTarget struct {
	TwsKn  float64 `json:"twsKn"`
	Upwind struct {
		TwaDeg  []float64 `json:"twaDeg"`
		SpeedKn []float64 `json:"speedKn"`
	} `json:"upwind"`
	Downwind struct {
		TwaDeg  []float64 `json:"twaDeg"`
		SpeedKn []float64 `json:"speedKn"`
	} `json:"downwind"`
}

func run() error {
	twsFlag := flag.String("tws", "6,7,8", "true wind speeds, kn")
	twaStepFlag := flag.String("twa-step", "5", "true wind angle step, deg")
	disable := flag.String("disable", "", "layers to disable")
	disableTerms := flag.String("disable-terms", "", "terms to disable")
	enableTerms := flag.String("enable-terms", "", "terms to enable")
	model := flag.String("model", "", "model options key=value,...")
	set := flag.String("set", "", "numeric boat config overrides path=value,...")
	quiet := flag.Bool("quiet", false, "only print summaries")
	waves := flag.Bool("waves", false, "enable waves")
	waveAmplitude := flag.String("wave-amplitude", "1", "wave amplitude scale")
	wavePeriod := flag.String("wave-period", "", "primary wave period, s")
	waveDirection := flag.String("wave-direction", "", "wave direction TO, deg")
	outDir := flag.String("out", "polar-out", "output directory")
	flag.Parse()

	base, err := sim.WithDisabledLayers(sim.DefaultConfigUnseeded(), list(*disable))
	if err != nil {
		return err
	}
	base.Waves.Enabled = *waves
	base.Waves.AmplitudeScale = number(*waveAmplitude)
	if !isFinite(base.Waves.AmplitudeScale) {
		return fmt.Errorf("--wave-amplitude must be finite")
	}
	period, direction := base.Waves.PeriodSeconds, base.Waves.DirectionDeg
	if *wavePeriod != "" {
		period = number(*wavePeriod)
	}
	if *waveDirection != "" {
		direction = number(*waveDirection)
	}
	if !isFinite(period) || !isFinite(direction) {
		return fmt.Errorf("wave period and direction must be finite")
	}
	sim.SetWaveParameters(&base.Waves, period, direction)
	if err := setTerms(&base, list(*disableTerms), false); err != nil {
		return err
	}
	if err := setTerms(&base, list(*enableTerms), true); err != nil {
		return err
	}
	if err := setModels(&base, list(*model)); err != nil {
		return err
	}
	boatCfg, err := boatConfig(list(*set))
	if err != nil {
		return err
	}
	var twsList []float64
	for _, s := range list(*twsFlag) {
		twsList = append(twsList, number(s))
	}
	twaStep := number(*twaStepFlag)
	boat := sim.BuildBoatFrom(boatCfg, sim.SailCoefficientsJSON)

	var target polarTarget
	if raw, err := data.FS.ReadFile("laser-polar-target.json"); err != nil {
		return err
	} else if err := json.Unmarshal(raw, &target); err != nil {
		return err
	}

	offLayers := offNames(base.Layers)
	offTerms := offNames(base.Terms)
	fmt.Printf("Disabled layers: %s; disabled terms: %s\n", orNone(offLayers), orNone(offTerms))
	modelsJSON, _ := json.Marshal(base.Models)
	overrides := ""
	if *set != "" {
		overrides = "; boat overrides: " + *set
	}
	fmt.Printf("Models: %s%s\n", modelsJSON, overrides)
	onOff := "off"
	if base.Waves.Enabled {
		onOff = "on"
	}
	fmt.Printf("Waves: %s; amplitude scale %s\n", onOff, jsString(base.Waves.AmplitudeScale))
	if base.Waves.Enabled && base.Waves.AmplitudeScale > 0 {
		fmt.Println("Warning: waves are periodic forcing; this steady-state polar is not a validated wave-performance prediction.")
	}

	rows := []string{"tws_kn,twa_deg,boat_speed_kn,vmg_kn,leeway_deg,heel_deg,sheet,hike,rudder_deg,aws_kn,awa_deg,luff,stall,converged,sim_s"}
	var curves []polarCurve
	f := func(x float64) string { return fixed(x, 2) }

	for _, tws := range twsList {
		cfg := base
		cfg.Wind.SpeedKn = tws
		sim.SetWaveWind(&cfg.Waves, tws)
		var twas []float64
		for twa := 30.0; twa <= 180+1e-9; twa += twaStep {
			twas = append(twas, twa)
		}
		results := make([]steadyResult, len(twas))
		var wg sync.WaitGroup
		sem := make(chan struct{}, runtime.GOMAXPROCS(0))
		for i, twa := range twas {
			wg.Go(func() {
				sem <- struct{}{}
				defer func() { <-sem }()
				results[i] = bestTrim(boat, &cfg, twa)
			})
		}
		wg.Wait()
		curve := polarCurve{label: fmt.Sprintf("TWS %s kn", jsString(tws))}
		for _, r := range results {
			rows = append(rows, strings.Join([]string{
				jsString(tws), jsString(r.twaDeg), fixed(r.speedKn, 3), fixed(r.vmgKn, 3), f(r.leewayDeg), f(r.heelDeg),
				fixed(r.sheet, 3), f(r.hike), f(r.rudderDeg), f(r.awsKn), fixed(r.awaDeg, 1), f(r.luffAmount),
				f(r.stallAmount), strconv.FormatBool(r.converged), fixed(r.simSeconds, 0),
			}, ","))
			curve.points = append(curve.points, polarPoint{twaDeg: r.twaDeg, speedKn: r.speedKn})
		}
		curves = append(curves, curve)

		fmt.Printf("\nTWS %s kn\n", jsString(tws))
		if !*quiet {
			fmt.Println(" TWA  speed  VMG   leeway heel  sheet hike rudder AWA  luff stall conv")
			for _, r := range results {
				conv := "n"
				if r.converged {
					conv = "y"
				}
				fmt.Println(strings.Join([]string{
					pad(fixed(r.twaDeg, 0), 4), pad(f(r.speedKn), 6), pad(f(r.vmgKn), 5), pad(fixed(r.leewayDeg, 1), 6),
					pad(fixed(r.heelDeg, 1), 5), pad(f(r.sheet), 5), pad(f(r.hike), 4), pad(fixed(r.rudderDeg, 1), 6),
					pad(fixed(r.awaDeg, 0), 4), pad(f(r.luffAmount), 5), pad(f(r.stallAmount), 5), conv,
				}, " "))
			}
		}
		upwind, downwind, peak := results[0], results[0], results[0]
		for _, r := range results[1:] {
			if r.vmgKn > upwind.vmgKn {
				upwind = r
			}
			if r.vmgKn < downwind.vmgKn {
				downwind = r
			}
			if r.speedKn > peak.speedKn {
				peak = r
			}
		}
		deadRun := results[len(results)-1]
		fmt.Printf("  best upwind VMG %s kn at TWA %s; peak speed %s kn at TWA %s; dead run %s kn; best downwind VMG %s kn at TWA %s\n",
			f(upwind.vmgKn), jsString(upwind.twaDeg), f(peak.speedKn), jsString(peak.twaDeg), f(deadRun.speedKn), f(-downwind.vmgKn), jsString(downwind.twaDeg))
		at30 := results[0]
		fmt.Printf("  TWA 30: %s kn (%s%% of close-hauled speed %s kn), leeway close-hauled %s deg, heel close-hauled %s deg, rudder %s deg\n",
			f(at30.speedKn), fixed((100*at30.speedKn)/upwind.speedKn, 0), f(upwind.speedKn), fixed(upwind.leewayDeg, 1), fixed(upwind.heelDeg, 1), fixed(upwind.rudderDeg, 1))
		if tws == target.TwsKn {
			cmp := func(twas, speeds []float64) string {
				parts := make([]string, len(twas))
				for i, twa := range twas {
					parts[i] = jsString(twa) + ": n/a"
					for _, r := range results {
						if math.Abs(r.twaDeg-twa) < 1e-6 {
							parts[i] = fmt.Sprintf("%s: %s/%s (%s)", jsString(twa), f(r.speedKn), f(speeds[i]), f(r.speedKn-speeds[i]))
							break
						}
					}
				}
				return strings.Join(parts, "  ")
			}
			fmt.Printf("  vs Day VPP 9 kn Fig 4 (ours/Day): %s\n", cmp(target.Upwind.TwaDeg, target.Upwind.SpeedKn))
			fmt.Printf("  vs Day VPP 9 kn Fig 6 (ours/Day): %s\n", cmp(target.Downwind.TwaDeg, target.Downwind.SpeedKn))
		}

		// In irons: point straight into the wind at 3 kn, tiller centred, sheet half out.
		s := sim.InitialState(cfg.Wind.FromDeg*sim.DEG, 3*sim.KNOT)
		var trace []string
		every := int(jsRound(10 / cfg.Dt))
		for i := 1; i <= int(jsRound(60/cfg.Dt)); i++ {
			s = sim.Step(s, sim.Controls{Tiller: 0, Sheet: 0.5, Hike: 0}, boat, &cfg).State
			if i%every == 0 {
				trace = append(trace, fmt.Sprintf("t=%ss u=%skn hdg_off_wind=%sdeg",
					fixed(s.T, 0), f(s.U/sim.KNOT), fixed(math.Mod(s.Heading/sim.DEG+540-cfg.Wind.FromDeg, 360)-180, 0)))
			}
		}
		fmt.Printf("  head to wind: %s\n", strings.Join(trace, " | "))
	}

	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		return err
	}
	csvPath := filepath.Join(*outDir, "polar.csv")
	if err := os.WriteFile(csvPath, []byte(strings.Join(rows, "\n")+"\n"), 0o644); err != nil {
		return err
	}
	title := fmt.Sprintf("Laser polar (disabled: %s)", orNone(append(offLayers, offTerms...)))
	svgPath := filepath.Join(*outDir, "polar.svg")
	if err := os.WriteFile(svgPath, []byte(polarSvg(curves, title)), 0o644); err != nil {
		return err
	}
	fmt.Printf("\nWrote %s and %s\n", csvPath, svgPath)
	return nil
}

// offNames lists the false booleans of a toggle struct by JSON name, in declaration order.
func offNames(v any) []string {
	b, _ := json.Marshal(v)
	dec := json.NewDecoder(strings.NewReader(string(b)))
	var out []string
	_, _ = dec.Token() // {
	for dec.More() {
		key, _ := dec.Token()
		val, _ := dec.Token()
		if on, ok := val.(bool); ok && !on {
			out = append(out, key.(string))
		}
	}
	return out
}

func orNone(names []string) string {
	if len(names) == 0 {
		return "none"
	}
	return strings.Join(names, ", ")
}
