package sim

import (
	"math"
	"testing"
)

// Port of src/sim/layers/sail.test.ts.

func bestBoom(beta float64) float64 {
	rig := &testBoat.Cfg.Rig
	alphaOpt := testBoat.BetaPeak - rig.BoomMinDeg*DEG
	return Clamp(beta-alphaOpt, rig.BoomMinDeg*DEG, rig.BoomMaxDeg*DEG)
}

func TestSailReproducesTable1AtBestTrim(t *testing.T) {
	table := &SailCoefficientsJSON
	for _, beta := range []float64{60, 90, 120, 150, 180} {
		i := indexOf(table.BetaDeg, beta)
		c := sailCoefficients(testBoat, beta*DEG, bestBoom(beta*DEG))
		closeTo(t, "cl", c.Cl, table.Cl[i], 9)
		closeTo(t, "cdv", c.Cdv, table.Cdv[i], 9)
		equal(t, "luffAmount", c.LuffAmount, 0)
	}
}

func TestSailReproducesTable1UpwindSheetedIn(t *testing.T) {
	table := &SailCoefficientsJSON
	rig := &testBoat.Cfg.Rig
	for _, beta := range []float64{28} {
		i := indexOf(table.BetaDeg, beta)
		c := sailCoefficients(testBoat, beta*DEG, rig.BoomMinDeg*DEG)
		closeTo(t, "cl", c.Cl, table.Cl[i], 9)
		closeTo(t, "cdv", c.Cdv, table.Cdv[i], 9)
	}
}

func TestPinchingCollapsesLift(t *testing.T) {
	rig := &testBoat.Cfg.Rig
	sheetedIn := func(betaDeg float64) SailCoefficients {
		return sailCoefficients(testBoat, betaDeg*DEG, rig.BoomMinDeg*DEG)
	}
	equal(t, "luff at start", sheetedIn(rig.LuffStartBetaEffDeg).LuffAmount, 0)
	closeTo(t, "cl at start", sheetedIn(rig.LuffStartBetaEffDeg).Cl, testBoat.ClTable.At(rig.LuffStartBetaEffDeg), 9)
	mid := (rig.LuffStartBetaEffDeg + rig.LuffFullBetaEffDeg) / 2
	closeTo(t, "luff at mid", sheetedIn(mid).LuffAmount, 0.5, 9)
	closeTo(t, "cl at mid", sheetedIn(mid).Cl, 0.5*testBoat.ClTable.At(mid), 9)
	equal(t, "cl at full", sheetedIn(rig.LuffFullBetaEffDeg).Cl, 0)
	closeTo(t, "cdv at full", sheetedIn(rig.LuffFullBetaEffDeg).Cdv, SailCoefficientsJSON.Cdv[0], 9)
}

func TestMaximumLiftBetween28And60(t *testing.T) {
	greater(t, "betaPeak", testBoat.BetaPeak/DEG, 28)
	less(t, "betaPeak", testBoat.BetaPeak/DEG, 60)
}

func TestEasedPastBestTrimLosesLiftAndLuffs(t *testing.T) {
	beta := 60 * DEG
	prevCl := math.Inf(1)
	prevLuff := math.Inf(-1)
	for eased := 0.0; eased <= 30; eased += 5 {
		c := sailCoefficients(testBoat, beta, bestBoom(beta)+eased*DEG)
		lessEq(t, "cl", c.Cl, prevCl+1e-12)
		greaterEq(t, "luffAmount", c.LuffAmount, prevLuff)
		prevCl = c.Cl
		prevLuff = c.LuffAmount
	}
	flagging := sailCoefficients(testBoat, beta, beta) // boom along the wind: alpha = 0
	equal(t, "flagging cl", flagging.Cl, 0)
	equal(t, "flagging luff", flagging.LuffAmount, 1)
	closeTo(t, "flagging cdv", flagging.Cdv, SailCoefficientsJSON.Cdv[0], 9)
}

func TestOverSheetedStalls(t *testing.T) {
	rig := &testBoat.Cfg.Rig
	beta := 90 * DEG
	best := sailCoefficients(testBoat, beta, bestBoom(beta))
	tight := sailCoefficients(testBoat, beta, rig.BoomMinDeg*DEG)
	less(t, "trimError", tight.TrimError, 0)
	less(t, "cl", tight.Cl, best.Cl)
	greater(t, "cdv", tight.Cdv, best.Cdv)
	equal(t, "luffAmount", tight.LuffAmount, 0)
}

func TestLuffsWhenPinchingHeadToWind(t *testing.T) {
	greater(t, "luffAmount", sailCoefficients(testBoat, 4*DEG, testBoat.Cfg.Rig.BoomMinDeg*DEG).LuffAmount, 0.5)
}

func TestStallAmount(t *testing.T) {
	rig := &testBoat.Cfg.Rig
	for _, beta := range []float64{28, 60, 90, 120} {
		equal(t, "stall at best trim", sailCoefficients(testBoat, beta*DEG, bestBoom(beta*DEG)).StallAmount, 0)
	}
	beta := 90 * DEG
	over10 := sailCoefficients(testBoat, beta, bestBoom(beta)-10*DEG).StallAmount
	over30 := sailCoefficients(testBoat, beta, bestBoom(beta)-30*DEG).StallAmount
	greater(t, "over10", over10, 0)
	greater(t, "over30", over30, over10)
	equal(t, "eased", sailCoefficients(testBoat, beta, bestBoom(beta)+10*DEG).StallAmount, 0) // eased: luffing side
	greater(t, "dead run", sailCoefficients(testBoat, math.Pi, rig.BoomMaxDeg*DEG).StallAmount, 0.9)
}

func TestBoomLimitedBySheetAndWeathervanes(t *testing.T) {
	rig := &testBoat.Cfg.Rig
	state := InitialState(0, 0)
	state.BoomSide = -1
	// Wind 120 deg off starboard, boom to port.
	half := boomKinematics(120*DEG, &state, 0.5, testBoat)
	equal(t, "boomSide", half.BoomSide, -1)
	closeTo(t, "target", half.Target/DEG, -(rig.BoomMinDeg + 0.5*(rig.BoomMaxDeg-rig.BoomMinDeg)), 9)
	free := boomKinematics(30*DEG, &state, 1, testBoat)
	closeTo(t, "free target", free.Target/DEG, -30, 9)
}

func TestBoomFlipsOnTack(t *testing.T) {
	state := InitialState(0, 0)
	state.BoomSide = -1                                 // boom to port, wind was from starboard
	k := boomKinematics(-10*DEG, &state, 0.2, testBoat) // wind now from port
	equal(t, "boomSide", k.BoomSide, 1)
	greater(t, "target", k.Target, 0)
}

func TestGybesOnlyPastByTheLeeMargin(t *testing.T) {
	rig := &testBoat.Cfg.Rig
	state := InitialState(0, 0)
	state.BoomSide = -1
	small := boomKinematics(-(180-rig.GybeByTheLeeDeg+5)*DEG, &state, 1, testBoat)
	equal(t, "small", small.BoomSide, -1)
	big := boomKinematics(-(180-rig.GybeByTheLeeDeg-5)*DEG, &state, 1, testBoat)
	equal(t, "big", big.BoomSide, 1)
}

func trimmedSail(heading, windFromDeg float64, terms *TermToggles) SailResult {
	cfg := DefaultConfigUnseeded()
	wind := GetWind(Vec2{}, 0, &WindConfig{SpeedKn: 7, FromDeg: windFromDeg})
	s0 := InitialState(heading, 0)
	aw := apparentWind(&s0, wind, true)
	side := 1
	if aw.Angle > 0 {
		side = -1
	}
	state := s0
	state.BoomSide = side
	state.Boom = float64(side) * bestBoom(math.Abs(aw.Angle))
	if terms == nil {
		terms = &cfg.Terms
	}
	return sailForces(&state, &aw, 0, testBoat, &cfg.Env, terms)
}

func TestSailBeamReachDrivesAndIsMirrorSymmetric(t *testing.T) {
	stbdTack := trimmedSail(0, 90, nil) // wind from starboard
	portTack := trimmedSail(0, 270, nil)
	greater(t, "fx", stbdTack.Fx, 0)
	less(t, "fy", stbdTack.Fy, 0)                 // leeward = port
	less(t, "heelMoment", stbdTack.HeelMoment, 0) // heels to port
	closeTo(t, "mirrored fx", portTack.Fx, stbdTack.Fx, 9)
	closeTo(t, "mirrored fy", portTack.Fy, -stbdTack.Fy, 9)
	closeTo(t, "mirrored yaw", portTack.YawMoment, -stbdTack.YawMoment, 9)
}

func TestSailDeadRunPushesDownwind(t *testing.T) {
	run := trimmedSail(0, 180, nil)
	greater(t, "fx", run.Fx, 0)
	less(t, "|cl|", math.Abs(run.Cl), 0.2)
}

func TestSailInducedDragSwitch(t *testing.T) {
	cfg := DefaultConfigUnseeded()
	on := trimmedSail(0, 45, nil)
	termsOff := cfg.Terms
	termsOff.SailInducedDrag = false
	wind := GetWind(Vec2{}, 0, &WindConfig{SpeedKn: 7, FromDeg: 45})
	s0 := InitialState(0, 0)
	aw := apparentWind(&s0, wind, true)
	state := s0
	state.BoomSide = -1
	state.Boom = -bestBoom(aw.Angle)
	off := sailForces(&state, &aw, 0, testBoat, &cfg.Env, &termsOff)
	equal(t, "cdi off", off.Cdi, 0)
	greater(t, "cdi on", on.Cdi, 0)
	less(t, "drag", off.Drag, on.Drag)
}
