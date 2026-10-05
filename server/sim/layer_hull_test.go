package sim

import (
	"math"
	"testing"
)

// Port of src/sim/layers/hull.test.ts.

func hullAt(state BoatState, terms *TermToggles, models *ModelOptions) HullResult {
	cfg := DefaultConfigUnseeded()
	if terms == nil {
		terms = &cfg.Terms
	}
	if models == nil {
		models = &cfg.Models
	}
	return hullForces(&state, testBoat, &cfg.Env, terms, models)
}

func TestTankModelFollowsDragArea(t *testing.T) {
	cfg := DefaultConfigUnseeded()
	tank := cfg.Models
	tank.UprightResistance = "tank"
	tbl := &testBoat.Cfg.Hull.UprightDragArea
	for i, kn := range tbl.SpeedKn {
		closeTo(t, "dragArea", tableDragArea(tbl, kn*KNOT), tbl.DragAreaM2[i], 12)
	}
	v := 4 * KNOT
	r := hullAt(InitialState(0, v), nil, &tank)
	closeTo(t, "upright", r.Upright, 0.5*cfg.Env.RhoWater*v*v*0.01566, 9)
	closeTo(t, "fx", r.Fx, -r.Upright, 12)
}

func TestDelftResiduaryMatchesEq17(t *testing.T) {
	cfg := DefaultConfigUnseeded()
	r := &ResiduaryJSON
	t2 := &testBoat.Cfg.Hull.Table2
	i := indexOf(r.Fn, 0.4)
	form := r.A1[i]*t2.LcbOverLwl +
		r.A2[i]*t2.Cp +
		r.A3[i]*t2.Vol23OverAw +
		r.A4[i]*t2.BwlOverLwl +
		r.A5[i]*t2.LcbOverLcf +
		r.A6[i]*t2.BwlOverTc +
		r.A7[i]*t2.Cm
	ratio := r.A0[i] + form*t2.Vol13OverLwl
	v := 0.4 * math.Sqrt(G*testBoat.Lwl)
	_, res := DelftUpright(testBoat, v, &cfg.Env)
	closeTo(t, "residuary", res, ratio*testBoat.Volume*cfg.Env.RhoWater*G, 9)
}

func TestDelftResiduaryBlendsBelowFn015(t *testing.T) {
	cfg := DefaultConfigUnseeded()
	residuary := func(v float64) float64 {
		_, r := DelftUpright(testBoat, v, &cfg.Env)
		return r
	}
	v15 := 0.15 * math.Sqrt(G*testBoat.Lwl)
	at := residuary(v15)
	closeTo(t, "continuous", residuary(v15*(1-1e-9)), at, 6)
	closeTo(t, "quadratic", residuary(v15/2), at/4, 9)
	equal(t, "zero", residuary(0), 0)
}

func TestHullOpposesMotionAstern(t *testing.T) {
	greater(t, "fx", hullAt(InitialState(0, -1), nil, nil).Fx, 0)
}

func TestHeelResistanceProportionalToHeel(t *testing.T) {
	cfg := DefaultConfigUnseeded()
	tcT := testBoat.Tc / testBoat.Cfg.Hull.DraughtBoardDown
	bt := testBoat.Cfg.Hull.Table2.BwlOverTc
	closeTo(t, "coefficient", heelResistanceCoefficient(testBoat), (6.747*tcT+2.517*bt+3.71*bt*tcT)*1e-3, 12)
	const v = 2.0
	upright := hullAt(InitialState(0, v), nil, nil)
	equal(t, "upright heelResistance", upright.HeelResistance, 0)
	s10 := InitialState(0, v)
	s10.Heel = 10 * DEG
	s20 := InitialState(0, v)
	s20.Heel = -20 * DEG
	at10 := hullAt(s10, nil, nil)
	at20 := hullAt(s20, nil, nil)
	fn2 := (v * v) / (G * testBoat.Lwl)
	expected := 0.5 * cfg.Env.RhoWater * v * v * testBoat.WettedArea * heelResistanceCoefficient(testBoat) * fn2 * 10 * DEG
	closeTo(t, "at10", at10.HeelResistance, expected, 9)
	closeTo(t, "at20", at20.HeelResistance, 2*at10.HeelResistance, 9)
}

func TestCrossflowResistsSlidingAndYawing(t *testing.T) {
	cfg := DefaultConfigUnseeded()
	slidingState := InitialState(0, 0)
	slidingState.V = 0.5
	less(t, "sliding fy", hullAt(slidingState, nil, nil).Fy, 0)
	yawingState := InitialState(0, 0)
	yawingState.R = 0.5
	less(t, "yawing moment", hullAt(yawingState, nil, nil).YawMoment, 0)
	termsOff := cfg.Terms
	termsOff.CrossflowDrag = false
	equal(t, "off fy", hullAt(slidingState, &termsOff, nil).Fy, 0)
}
