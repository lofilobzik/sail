package sim

import (
	"math"
	"testing"
)

// Port of src/sim/layers/foils.test.ts.

var noTiller = Controls{Tiller: 0, Sheet: 0, Hike: 0}

func foilsAt(state BoatState, controls Controls, terms *TermToggles, models *ModelOptions) FoilsResult {
	cfg := DefaultConfigUnseeded()
	if terms == nil {
		terms = &cfg.Terms
	}
	if models == nil {
		models = &cfg.Models
	}
	return foilForces(&state, &controls, testBoat, &cfg.Env, terms, models, nil)
}

func sliding(speed, leewayDeg float64) BoatState {
	s := InitialState(0, speed)
	s.V = speed * math.Tan(leewayDeg*DEG)
	return s
}

func TestFoilLiftSlopeForms(t *testing.T) {
	ar := (2 * 0.68) / 0.341
	b := &testBoat.Board
	closeTo(t, "aspectRatioImage", b.AspectRatioImage, ar, 12)
	closeTo(t, "liftSlope", b.LiftSlope, (5.7*ar)/(1.8+math.Sqrt(ar*ar+4)), 12)
	closeTo(t, "liftSlopePrinted", b.LiftSlopePrinted, (5.7*ar)/(1.8+math.Sqrt(math.Pow(ar, 4)+4)), 12)
	closeTo(t, "cHull", b.CHull, 1+1.8*(testBoat.Tc/0.68), 12)
}

func TestPrintedLiftSlopeGivesLessSideForce(t *testing.T) {
	state := sliding(2, 3)
	cfg := DefaultConfigUnseeded()
	std := foilsAt(state, noTiller, nil, nil)
	printed := cfg.Models
	printed.LiftSlope = "printed"
	p := foilsAt(state, noTiller, nil, &printed)
	less(t, "|printed fy|", math.Abs(p.Board.Fy), 0.5*math.Abs(std.Board.Fy))
}

func TestFoilLinearBelowStallCappedAbove(t *testing.T) {
	slope := testBoat.Board.LiftSlope * testBoat.Board.CHull
	clMax := testBoat.Cfg.Foil.ClMax
	smallCl, smallStalled := foilLiftCoefficient(slope, 2*DEG, clMax)
	closeTo(t, "small cl", smallCl, slope*2*DEG, 12)
	equal(t, "small stalled", smallStalled, false)
	bigCl, bigStalled := foilLiftCoefficient(slope, 40*DEG, clMax)
	equal(t, "big stalled", bigStalled, true)
	lessEq(t, "|big cl|", math.Abs(bigCl), clMax)
	negCl, _ := foilLiftCoefficient(slope, -2*DEG, clMax)
	closeTo(t, "negative cl", negCl, -smallCl, 12)
}

func TestZeroLiftDriftUnitsAndSign(t *testing.T) {
	phi := 20 * DEG
	value := math.Pow(0.405*11.755*phi, 2) // 2.76
	closeTo(t, "deg", zeroLiftDrift(phi, 11.755, "deg", 1), value*DEG, 12)
	closeTo(t, "rad", zeroLiftDrift(phi, 11.755, "rad", 1), value, 12)
	closeTo(t, "negative heel", zeroLiftDrift(-phi, 11.755, "deg", 1), -value*DEG, 12)
	closeTo(t, "sign -1", zeroLiftDrift(phi, 11.755, "deg", -1), -value*DEG, 12)
	equal(t, "zero heel", zeroLiftDrift(0, 11.755, "deg", 1), 0)
}

func TestLeewardHeelCostsBoardLift(t *testing.T) {
	cfg := DefaultConfigUnseeded()
	terms := cfg.Terms
	terms.ZeroLiftDrift = true
	s := sliding(2, 3) // sliding to starboard
	upright := foilsAt(s, noTiller, &terms, nil)
	heeledState := s
	heeledState.Heel = 15 * DEG
	heeled := foilsAt(heeledState, noTiller, &terms, nil)
	greater(t, "lambda0", heeled.Lambda0, 0)
	less(t, "|heeled lift|", math.Abs(heeled.Board.Lift), math.Abs(upright.Board.Lift))
}

func TestBoardResistsLeeway(t *testing.T) {
	state := sliding(2, 4)
	f := foilsAt(state, noTiller, nil, nil)
	less(t, "board fy", f.Board.Fy, 0)
	// Along the direction of travel only drag remains: it opposes the motion.
	speed := math.Hypot(state.U, state.V)
	closeTo(t, "drag along travel", (f.Board.Fx*state.U+f.Board.Fy*state.V)/speed, -f.Board.Drag, 9)
	// Lift is perpendicular to the flow, so it leans forward: a little drive from the board.
	greater(t, "board fx", f.Board.Fx, 0)
	greater(t, "heelMoment", f.HeelMoment, 0) // board below the waterline pushing to port heels the top to starboard
}

func TestRudderTurnsBowAwayFromTillerForwardTowardAstern(t *testing.T) {
	forward := foilsAt(InitialState(0, 2), Controls{Tiller: 1}, nil, nil)
	less(t, "forward yaw", forward.YawMoment, 0) // tiller to starboard -> bow to port
	astern := foilsAt(InitialState(0, -1), Controls{Tiller: 1}, nil, nil)
	greater(t, "astern yaw", astern.YawMoment, 0)
}

func TestDownwashReducesRudderLoad(t *testing.T) {
	cfg := DefaultConfigUnseeded()
	state := sliding(2, 4)
	withDw := foilsAt(state, noTiller, nil, nil)
	termsOff := cfg.Terms
	termsOff.Downwash = false
	noDw := foilsAt(state, noTiller, &termsOff, nil)
	greater(t, "downwash", withDw.Downwash, 0)
	less(t, "|rudder lift|", math.Abs(withDw.Rudder.Lift), math.Abs(noDw.Rudder.Lift))
	closeTo(t, "board lift", withDw.Board.Lift, noDw.Board.Lift, 12)
}

func TestITTCFrictionLine(t *testing.T) {
	closeTo(t, "cf(1e7)", ittcFriction(1e7), 0.075/25, 12)
	greater(t, "cf(1e6)", ittcFriction(1e6), ittcFriction(1e7))
}
