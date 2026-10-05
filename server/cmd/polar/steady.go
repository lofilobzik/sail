package main

import (
	"math"

	"sail/server/sim"
)

// Port of scripts/lib/autopilot.ts and scripts/lib/steadyState.ts.

// Helmsman for the headless polar: holds a heading with the tiller and keeps the boat near upright
// with hiking. Script-side only; the sim has no auto-trim. Gains are TUNING GUESS values chosen for
// a steady hold, not for performance.
const (
	headingKP = 4 // TUNING GUESS: tiller per rad of heading error
	headingKD = 3 // TUNING GUESS: tiller per rad/s of yaw rate
	hikeKI    = 3 // TUNING GUESS: hike per (rad of leeward heel * s)
)

type autopilot struct {
	targetHeading, sheet float64
	yawEnabled           bool
	hike                 float64
}

func (a *autopilot) controls(state sim.BoatState, dt float64) sim.Controls {
	err := sim.WrapPi(state.Heading - a.targetHeading)
	// Tiller to starboard (+) turns the bow to port, so a heading too far to
	// starboard (err > 0) or a starboard yaw rate needs positive tiller.
	tiller := 0.0
	if a.yawEnabled {
		tiller = sim.Clamp(headingKP*err+headingKD*state.R, -1, 1)
	}
	leewardHeel := float64(state.BoomSide) * state.Heel
	a.hike = sim.Clamp(a.hike+hikeKI*leewardHeel*dt, 0, 1)
	return sim.Controls{Tiller: tiller, Sheet: a.sheet, Hike: a.hike}
}

// steadyResult: sails the boat at a fixed true wind angle and sheet setting until the speed
// settles, then averages the last window.
type steadyResult struct {
	twaDeg, sheet, speedKn, vmgKn, leewayDeg, heelDeg, hike, rudderDeg, awsKn, awaDeg float64
	luffAmount, stallAmount                                                           float64
	converged                                                                         bool
	simSeconds                                                                        float64
}

const (
	startSpeed = 1.5   // m/s, TUNING GUESS starting push so the foils work from t = 0
	minTime    = 40.0  // s
	maxTime    = 240.0 // s
	window     = 10.0  // s, averaging window and convergence span
	tolerance  = 0.005 // m/s change of window-mean speed between windows
)

type sums struct{ speed, vmg, leeway, heel, hike, rudder, aws, awa, luff, stall float64 }

func (s sums) div(n float64) sums {
	return sums{s.speed / n, s.vmg / n, s.leeway / n, s.heel / n, s.hike / n, s.rudder / n, s.aws / n, s.awa / n, s.luff / n, s.stall / n}
}

// jsRound is Math.round (ties toward +Infinity).
func jsRound(x float64) float64 {
	r := math.Floor(x)
	if x-r >= 0.5 {
		r++
	}
	return r
}

func sailToSteadyState(boat *sim.BoatModel, cfg *sim.SimConfig, twaDeg, sheet float64) steadyResult {
	// Heading so that the wind (from cfg.wind.fromDeg) is twaDeg off the port bow:
	// starboard-tack-agnostic; port and starboard are symmetric in this model.
	heading := sim.Wrap2Pi((cfg.Wind.FromDeg + twaDeg) * sim.DEG)
	state := sim.InitialState(heading, startSpeed)
	state.BoomSide = 1
	state.CrewY = -boat.Cfg.Crew.SitInOffset
	pilot := &autopilot{targetHeading: heading, sheet: sheet, yawEnabled: cfg.Layers.Yaw}
	windowSteps := int(jsRound(window / cfg.Dt))

	var sum, mean sums
	prevMean := math.NaN()
	n := 0
	converged := false
	maxSteps := int(jsRound(maxTime / cfg.Dt))
	for i := 1; i <= maxSteps; i++ {
		controls := pilot.controls(state, cfg.Dt)
		r := sim.Step(state, controls, boat, cfg)
		state = r.State
		last := &r.Diagnostics
		sum.speed += state.U
		sum.vmg += last.Vmg
		sum.leeway += last.Leeway
		sum.heel += state.Heel
		sum.hike += controls.Hike
		if last.Foils != nil {
			sum.rudder += last.Foils.RudderAngle
		}
		sum.aws += last.Apparent.Speed
		sum.awa += math.Abs(last.Apparent.Angle)
		if last.Sail != nil {
			sum.luff += last.Sail.LuffAmount
			sum.stall += last.Sail.StallAmount
		}
		n++
		if i%windowSteps == 0 {
			mean = sum.div(float64(n))
			if state.T >= minTime && math.Abs(mean.speed-prevMean) < tolerance {
				converged = true
				break
			}
			prevMean = mean.speed
			sum = sums{}
			n = 0
		}
	}
	return steadyResult{
		twaDeg:      twaDeg,
		sheet:       sheet,
		speedKn:     mean.speed / sim.KNOT,
		vmgKn:       mean.vmg / sim.KNOT,
		leewayDeg:   mean.leeway / sim.DEG,
		heelDeg:     mean.heel / sim.DEG,
		hike:        mean.hike,
		rudderDeg:   mean.rudder / sim.DEG,
		awsKn:       mean.aws / sim.KNOT,
		awaDeg:      mean.awa / sim.DEG,
		luffAmount:  mean.luff,
		stallAmount: mean.stall,
		converged:   converged,
		simSeconds:  state.T,
	}
}

// bestTrim is the best sheet setting for a true wind angle: coarse grid, then golden-section
// refinement.
func bestTrim(boat *sim.BoatModel, cfg *sim.SimConfig, twaDeg float64) steadyResult {
	run := func(sheet float64) steadyResult { return sailToSteadyState(boat, cfg, twaDeg, sheet) }
	var best steadyResult
	bestIndex := 0
	for i, sheet := range []float64{0, 0.2, 0.4, 0.6, 0.8, 1} {
		r := run(sheet)
		if i == 0 || r.speedKn > best.speedKn {
			best = r
			bestIndex = i
		}
	}
	lo := max(0, float64(bestIndex-1)*0.2)
	hi := min(1, float64(bestIndex+1)*0.2)
	phi := (math.Sqrt(5) - 1) / 2
	a := run(hi - phi*(hi-lo))
	b := run(lo + phi*(hi-lo))
	for range 6 {
		if a.speedKn > b.speedKn {
			hi = b.sheet
			b = a
			a = run(hi - phi*(hi-lo))
		} else {
			lo = a.sheet
			a = b
			b = run(lo + phi*(hi-lo))
		}
	}
	for _, r := range []steadyResult{a, b} {
		if r.speedKn > best.speedKn {
			best = r
		}
	}
	return best
}
