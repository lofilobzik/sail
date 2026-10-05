package sim

import "math"

// L2 Sail as a foil (PHYSICS.md L2), plus parasitic windage (Day 2017 section 2.5).
// src/sim/layers/sail.ts.
//
// Coefficients: Day 2017 Table 1 (PDF p3), ORC "Low Lift" mainsail CL and viscous CDv
// vs apparent wind angle beta, interpolated by cubic spline (Day p3).
//
// Best-trim envelope (design decision in PHYSICS.md L2, not from the paper):
// the table value at the current apparent wind angle is what a well-trimmed sail
// produces. Trim error costs force:
//   - Under-sheeted (boom eased past best trim) or pinching: luffing. Following Day 2017
//     p5 (SPILL): easing the sail reduces its angle of attack, which acts like a smaller
//     apparent wind angle on the upwind branch of Table 1. The equivalent table angle
//     shrinks in proportion to the angle of attack, so lift follows the table's own
//     0..beta_peak shape. On top of that, luffAmount (PHYSICS.md L2: "It also collapses
//     lift in the model") ramps from 0 at an equivalent angle of luffStartBetaEffDeg to 1
//     at luffFullBetaEffDeg and scales lift by (1 - luffAmount). TUNING GUESS. Viscous drag
//     blends to the beta = 0 value (a flagging sail) with the same factor.
//   - Over-sheeted (boom tighter than best trim): stall. TUNING GUESS shape:
//     k = 1 / (1 + (over / stallWidth)^2); lift and drag blend from the table toward a
//     flat plate with the Table 1 beta = 180 drag (ORC 2023 VPP doc p36: beta = 180
//     approximates an angle of attack of 90 degrees).
//
// Best trim: Day 2017 p5, the sheeting angle for maximum lift does not change from
// beta = 0 up to the angle of maximum lift; above it the boom is eased so the angle
// of attack stays at its value at maximum lift, until the boom reaches its limit.
//
// Total drag: Day 2017 Eq. 1 (PDF p4) / Eq. 6 with actual CL = f CLmax:
//
//	CD = CDv + CDp + CL^2 (1 / (pi AR_E) + CDs)
//
// CDp (parasitic) is modelled as separate windage forces below, not as a coefficient.

// SailCoefficients are the sail coefficients from the best-trim envelope.
type SailCoefficients struct {
	Cl  float64 `json:"cl"`
	Cdv float64 `json:"cdv"`
	// 0 = drawing, 1 = fully luffing.
	LuffAmount float64 `json:"luffAmount"`
	// Visual diagnostic, does not affect forces: 0 = flow attached on the leeward side,
	// 1 = fully separated. Grows with the angle of attack beyond the max-lift angle
	// (over-sheeted, or boom at its limit on a run), same shape and width as the stall
	// falloff: 1 - 1 / (1 + (excess / stallWidth)^2).
	StallAmount float64 `json:"stallAmount"`
	// Boom angle minus best-trim boom angle, rad (+ = eased too far).
	TrimError float64 `json:"trimError"`
	// Angle of attack, rad: apparent wind angle on the sail side minus boom angle.
	Alpha float64 `json:"alpha"`
}

// BoomKinematics is where the boom is going.
type BoomKinematics struct {
	BoomSide int `json:"boomSide"`
	// Signed boom angle the boom is moving toward, rad.
	Target float64 `json:"target"`
}

// Windage is the parasitic air drag of crew, mast and topsides.
type Windage struct {
	Fx         float64 `json:"fx"`
	Fy         float64 `json:"fy"`
	HeelMoment float64 `json:"heelMoment"`
	YawMoment  float64 `json:"yawMoment"`
	Drag       float64 `json:"drag"`
}

// Vec3 is a body-frame point.
type Vec3 struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	Z float64 `json:"z"`
}

// SailResult is the L2 output.
type SailResult struct {
	Fx float64 `json:"fx"`
	Fy float64 `json:"fy"`
	// Heeling moment, N m (+ = heels to starboard).
	HeelMoment float64 `json:"heelMoment"`
	// Yaw moment, N m (+ = bow to starboard).
	YawMoment   float64 `json:"yawMoment"`
	Lift        float64 `json:"lift"`
	Drag        float64 `json:"drag"`
	Cl          float64 `json:"cl"`
	Cd          float64 `json:"cd"`
	Cdv         float64 `json:"cdv"`
	Cdi         float64 `json:"cdi"`
	Alpha       float64 `json:"alpha"`
	LuffAmount  float64 `json:"luffAmount"`
	StallAmount float64 `json:"stallAmount"`
	TrimError   float64 `json:"trimError"`
	// Apparent wind in the heeled plane.
	AwsHeeled float64 `json:"awsHeeled"`
	AwaHeeled float64 `json:"awaHeeled"`
	Ce        Vec3    `json:"ce"`
	Windage   Windage `json:"windage"`
}

// windOnSailSide is the wind angle measured on the side opposite the boom, wrapped to
// [-pi/2, 3pi/2).
func windOnSailSide(awa float64, boomSide int) float64 {
	w := WrapPi(-float64(boomSide) * awa)
	if w < -math.Pi/2 {
		return w + 2*math.Pi
	}
	return w
}

// boomKinematics: where the boom goes. Quasi-static: the wind pushes the boom to leeward until
// the sheet stops it, or until the sail points into the wind. The boom flips sides when the wind
// crosses the bow (tack) or gets more than gybeByTheLee past dead downwind.
func boomKinematics(awa float64, state *BoatState, sheet float64, boat *BoatModel) BoomKinematics {
	rig := &boat.Cfg.Rig
	side := state.BoomSide
	w := windOnSailSide(awa, side)
	if w < 0 || w > math.Pi+rig.GybeByTheLeeDeg*DEG {
		if side == 1 {
			side = -1
		} else {
			side = 1
		}
		w = windOnSailSide(awa, side)
	}
	limit := (rig.BoomMinDeg + Clamp(sheet, 0, 1)*(rig.BoomMaxDeg-rig.BoomMinDeg)) * DEG
	return BoomKinematics{BoomSide: side, Target: float64(side) * min(limit, max(w, 0))}
}

// sailCoefficients from the best-trim envelope.
// betaW: apparent wind angle on the sail side, rad (0 = head to wind, pi = dead run).
// delta: boom angle away from the wind, rad (>= 0 when the boom is on the leeward side).
func sailCoefficients(boat *BoatModel, betaW, delta float64) SailCoefficients {
	rig := &boat.Cfg.Rig
	betaDeg := Clamp(betaW/DEG, 0, 180)
	clEnv := boat.ClTable.At(betaDeg)
	cdvEnv := boat.CdvTable.At(betaDeg)

	boomMin := rig.BoomMinDeg * DEG
	alphaOpt := boat.BetaPeak - boomMin
	deltaOpt := Clamp(betaW-alphaOpt, boomMin, rig.BoomMaxDeg*DEG)
	alphaBest := betaW - deltaOpt
	alpha := betaW - delta
	trimError := delta - deltaOpt

	// Luffing: equivalent angle on the upwind branch of Table 1.
	branch := min(betaW, boat.BetaPeak)
	ratio := 1.0
	if alpha <= 0 {
		ratio = 0
	} else if trimError > 0 && alphaBest > 0 {
		ratio = min(alpha/alphaBest, 1)
	}
	equivDeg := (ratio * branch) / DEG
	branchCl := boat.ClTable.At(branch / DEG)
	kLuff := 0.0
	if branchCl > 0 {
		kLuff = Clamp(boat.ClTable.At(equivDeg)/branchCl, 0, 1)
	}
	luffAmount := Clamp((rig.LuffStartBetaEffDeg-equivDeg)/(rig.LuffStartBetaEffDeg-rig.LuffFullBetaEffDeg), 0, 1)
	kFill := kLuff * (1 - luffAmount)

	cl := clEnv * kFill
	cdv := kFill*cdvEnv + (1-kFill)*boat.CdvTable.At(0)

	// Stall: over-sheeted.
	if trimError < 0 && alpha > 0 {
		over := -trimError / (rig.StallWidthDeg * DEG)
		kStall := 1 / (1 + over*over)
		plate := boat.CdvTable.At(180)
		cl = kStall*cl + (1-kStall)*plate*math.Sin(alpha)*math.Cos(alpha)
		cdv = kStall*cdv + (1-kStall)*plate*math.Pow(math.Sin(alpha), 2)
	}

	excess := (alpha - alphaOpt) / (rig.StallWidthDeg * DEG)
	stallAmount := 0.0
	if excess > 0 {
		stallAmount = 1 - 1/(1+excess*excess)
	}

	return SailCoefficients{Cl: cl, Cdv: cdv, LuffAmount: luffAmount, StallAmount: stallAmount, TrimError: trimError, Alpha: alpha}
}

func windage(state *BoatState, boat *BoatModel, q, flowAngle, betaW, crewZ float64) Windage {
	cfg := boat.Cfg
	heel := math.Abs(state.Heel)
	sinB := math.Abs(math.Sin(betaW))
	fwx := math.Cos(flowAngle)
	fwy := math.Sin(flowAngle)
	var w Windage
	add := func(cdA, x, y, z float64) {
		f := q * cdA
		w.Fx += f * fwx
		w.Fy += f * fwy
		w.HeelMoment += z * f * fwy
		w.YawMoment += x*f*fwy - y*f*fwx
		w.Drag += f
	}

	// Crew: Day 2017 Eqs. 8-9 (PDF p5). W in newtons, H in metres.
	c := &cfg.Crew
	aDu := c.Dubois.Coef * math.Pow(boat.CrewMass*G, c.Dubois.WeightExp) * math.Pow(c.Height, c.Dubois.HeightExp)
	keep := (1 - c.ClothingReduction) * (1 - c.Shielding) // Day p5: -10% Cd, -20% area
	cdAFront := c.CdFrontal * c.FrontalAreaFrac * aDu * keep
	cdASide := c.CdSide * c.SideAreaFrac * aDu * keep
	// Projection between frontal and side: sinusoidal as Day does for the hull (Eq. 7).
	add(cdAFront+(cdASide-cdAFront)*sinB, 0, state.CrewY, boat.ZHullCg+crewZ)

	// Bare mast between deck and boom, Cd 0.8; sleeve part Cd 0.15 upwind only (Day p5).
	rig := &cfg.Rig
	add(rig.BareMastCd*rig.MastDiameter*boat.BoomAboveDeck, boat.XMast, 0, boat.Freeboard+boat.BoomAboveDeck/2)
	if betaW < math.Pi/2 {
		add(rig.SleeveMastCd*rig.MastDiameter*rig.Luff, boat.XMast, 0, boat.ZBoom+rig.Luff/2)
	}

	// Topsides: Day 2017 Eq. 7 (PDF p5).
	//   A_F = B_OA FA,  A_S = L_OA (FA + 0.5 B_OA C_WP sin(phi))
	//   A(beta) = A_F + (A_S - A_F) sin(beta),  Z_CE = 0.66 (FA + 0.5 B_OA C_WP sin(phi))
	fa := boat.Freeboard
	h := &cfg.Hull
	heelRise := 0.5 * h.Beam * boat.Cwp * math.Sin(heel)
	aF := h.Beam * fa
	aS := h.Loa * (fa + heelRise)
	add(h.TopsidesCd*(aF+(aS-aF)*sinB), 0, 0, 0.66*(fa+heelRise))

	return w
}

func sailForces(state *BoatState, aw *ApparentWind, crewZ float64, boat *BoatModel, env *EnvironmentConfig, terms *TermToggles) SailResult {
	rig := &boat.Cfg.Rig
	// Apparent wind in the heeled plane: the cross component is reduced by cos(heel).
	uH := aw.U
	vH := aw.V * math.Cos(state.Heel)
	awsHeeled := jsHypot(uH, vH)
	awaHeeled := math.Atan2(-vH, -uH)

	side := state.BoomSide
	betaW := windOnSailSide(awaHeeled, side)
	delta := float64(side) * state.Boom
	coef := sailCoefficients(boat, betaW, delta)

	cdi := 0.0
	if terms.SailInducedDrag {
		cdi = coef.Cl * coef.Cl * (1/(math.Pi*boat.SailAspectRatio) + rig.SeparationDragCds)
	}
	cd := coef.Cdv + cdi
	q := 0.5 * env.RhoAir * awsHeeled * awsHeeled
	lift := q * rig.SailArea * coef.Cl
	drag := q * rig.SailArea * cd

	// Flow direction (where the air goes) and lift direction, body angles.
	flowAngle := awaHeeled + math.Pi
	liftAngle := flowAngle - float64(side)*(math.Pi/2)
	fx := lift*math.Cos(liftAngle) + drag*math.Cos(flowAngle)
	fyHeeled := lift*math.Sin(liftAngle) + drag*math.Sin(flowAngle)

	// Centre of effort: along the boom from the mast, at CE height above the boom.
	ceX := boat.XMast - boat.CeAftOfMast*math.Cos(state.Boom)
	ceY := boat.CeAftOfMast * math.Sin(state.Boom)
	ceZ := boat.ZBoom + boat.CeAboveBoom

	var wind Windage
	if terms.Windage {
		wind = windage(state, boat, q, flowAngle, betaW, crewZ)
	}

	cosHeel := math.Cos(state.Heel)
	fy := fyHeeled * cosHeel
	return SailResult{
		Fx:          fx + wind.Fx,
		Fy:          fy + wind.Fy*cosHeel,
		HeelMoment:  ceZ*fyHeeled + wind.HeelMoment,
		YawMoment:   ceX*fy - ceY*fx + wind.YawMoment*cosHeel,
		Lift:        lift,
		Drag:        drag,
		Cl:          coef.Cl,
		Cd:          cd,
		Cdv:         coef.Cdv,
		Cdi:         cdi,
		Alpha:       coef.Alpha,
		LuffAmount:  coef.LuffAmount,
		StallAmount: coef.StallAmount,
		TrimError:   coef.TrimError,
		AwsHeeled:   awsHeeled,
		AwaHeeled:   awaHeeled,
		Ce:          Vec3{X: ceX, Y: ceY, Z: ceZ},
		Windage:     wind,
	}
}
