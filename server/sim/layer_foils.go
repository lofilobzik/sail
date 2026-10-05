package sim

import "math"

// L3 Hydrodynamic foils: daggerboard and rudder (PHYSICS.md L3), src/sim/layers/foils.ts.
// Equations as transcribed in docs/DAY-EQUATIONS.md from the Day 2017 page images.
//
// Lift, Day 2017 Eqs. 11-12 (PDF p6), after Keuning and Verwerft:
//
//	L_k = dCL/da * c_hull * c_keel * alpha_eff,k * 1/2 rho V_k^2 * A_lat,k
//	L_r = dCL/da * c_hull * c_keel * alpha_eff,r * 1/2 rho V_r^2 * A_lat,r
//
// c_keel is named "Heel influence coefficient" in Day's nomenclature (PDF p2); the p6 text
// gives the heel influence coefficient as c_heel = 1 - 0.382 phi (phi in rad). Same factor,
// two symbols. Applied here with |phi| (assumption: symmetric in heel).
//
//	dCL/da: see boat.go liftSlope (standard form default; printed form via models.liftSlope)
//	AR_E = 2 b / c,  c_hull = 1 + 1.80 (Tc / b)  (rudder: its own span, interpretation)
//	alpha_eff,k = lambda - lambda0,  lambda0 = (0.405 (Bwl/Tc) phi)^2  (no unit printed;
//	  models.lambda0Unit, models.lambda0Sign)
//	alpha_eff,r = lambda - lambda0 - delta_r - Phi,  Phi = a0 sqrt(CL_k / AR_eff,k)
//	  AR_eff,k taken as AR_E e (TUNING GUESS interpretation; not named on the page),
//	  a0 (downwash) TUNING GUESS: no value in Day.
//	V_k = boat speed, V_r = 0.9 boat speed (Day p7)
//
// Stall: CL limited to clMax (Larsson & Eliasson Fig 6.6, approximate), then a
// TUNING GUESS linear decay to zero at 90 degrees plus post-stall pressure drag.
//
// Drag:
//   - Friction, ITTC-1957 line on the mean chord, wetted area 2 A, times a form factor
//     (1 + k), k TUNING GUESS.
//   - Induced, Day 2017 Eq. 16 (PDF p7): CDi = CL^2 / (pi AR_E), AR_E = AR e (Eq. 17),
//     AR including the free-surface image, times cos^2(phi) for heel (Day p7).
//     KNOWN GAP: Day uses the Delft Eq. 15 (effective draft T_E) for the hull + board; its
//     coefficient table (A1-A4, B0, B1 per heel angle) is not in docs/, so Eq. 16 is used
//     for the board too.
//
// Side force from the canoe body is carried by c_hull ("lift carry-over"), as in Day.
// Local inflow at each foil includes yaw rate (r x) and heel rate (p z).

// FoilForce is the force on one foil.
type FoilForce struct {
	Fx   float64 `json:"fx"`
	Fy   float64 `json:"fy"`
	Lift float64 `json:"lift"`
	Drag float64 `json:"drag"`
	Cl   float64 `json:"cl"`
	// Effective angle of attack, rad.
	Alpha   float64 `json:"alpha"`
	Stalled bool    `json:"stalled"`
}

// FoilsResult is the L3 output.
type FoilsResult struct {
	Fx         float64   `json:"fx"`
	Fy         float64   `json:"fy"`
	HeelMoment float64   `json:"heelMoment"`
	YawMoment  float64   `json:"yawMoment"`
	Board      FoilForce `json:"board"`
	Rudder     FoilForce `json:"rudder"`
	// Rudder angle, rad (+ = leading edge to starboard, i.e. tiller to starboard).
	RudderAngle float64 `json:"rudderAngle"`
	// Zero-lift drift angle applied, rad.
	Lambda0  float64 `json:"lambda0"`
	Downwash float64 `json:"downwash"`
}

// FoilAmbientFlow is the local orbital flow projected onto each pitched/heeled foil's axes.
type FoilAmbientFlow struct {
	BoardU  float64 `json:"boardU"`
	BoardV  float64 `json:"boardV"`
	RudderU float64 `json:"rudderU"`
	RudderV float64 `json:"rudderV"`
}

// lineAngle is the incidence of a flow line on the foil's centreline, folded into [-pi/2, pi/2].
func lineAngle(u, v float64) float64 {
	a := math.Atan2(v, u)
	if a > math.Pi/2 {
		a -= math.Pi
	} else if a < -math.Pi/2 {
		a += math.Pi
	}
	return a
}

// zeroLiftDrift is the Day p6 zero-lift drift angle in radians for heel phi (rad).
// The printed (0.405 (Bwl/Tc) phi)^2 is read in unit ("deg" or "rad") and applied with
// sign(phi) * sign.
func zeroLiftDrift(phi, bwlOverTc float64, unit string, sign int) float64 {
	value := math.Pow(0.405*bwlOverTc*phi, 2)
	if unit == "deg" {
		value *= DEG
	}
	return float64(sign) * jsSign(phi) * value
}

// effectiveSlope is the effective lift slope per rad: dCL/da * c_hull * c_keel.
func effectiveSlope(foil *FoilModel, cHeel float64, models *ModelOptions) float64 {
	slope := foil.LiftSlope
	if models.LiftSlope == "printed" {
		slope = foil.LiftSlopePrinted
	}
	return slope * foil.CHull * cHeel
}

func foilLiftCoefficient(slope, alpha, clMax float64) (cl float64, stalled bool) {
	linear := slope * alpha
	if math.Abs(linear) <= clMax {
		return linear, false
	}
	alphaStall := clMax / slope
	decay := max(0, 1-(math.Abs(alpha)-alphaStall)/(math.Pi/2-alphaStall))
	return jsSign(alpha) * clMax * decay, true
}

func foilForce(foil *FoilModel, slope, u, vLocal, speedFactor, incidenceOffset, heel float64, boat *BoatModel, env *EnvironmentConfig) FoilForce {
	fc := &boat.Cfg.Foil
	flowSpeed := jsHypot(u, vLocal)
	if flowSpeed < 1e-6 {
		return FoilForce{}
	}
	speed := flowSpeed * speedFactor
	alpha := lineAngle(u, vLocal) - incidenceOffset
	cl, stalled := foilLiftCoefficient(slope, alpha, fc.ClMax)

	q := 0.5 * env.RhoWater * speed * speed
	cf := ittcFriction((speed * foil.Chord) / env.NuWater)
	cdFriction := 2 * cf * (1 + fc.FormFactorK)
	cdInduced := (cl * cl) / (math.Pi * foil.AspectRatioImage * foil.Efficiency * math.Pow(math.Cos(heel), 2))
	alphaStall := fc.ClMax / slope
	cdStall := 0.0
	if stalled {
		cdStall = fc.PostStallCdMax * (math.Pow(math.Sin(alpha), 2) - math.Pow(math.Sin(alphaStall), 2))
	}
	lift := q * foil.Area * cl
	drag := q * foil.Area * (cdFriction + cdInduced + max(cdStall, 0))

	// Flow direction relative to the boat and the lift direction (rotated +90 deg).
	fxDir := -u / flowSpeed
	fyDir := -vLocal / flowSpeed
	return FoilForce{
		Fx:      lift*-fyDir + drag*fxDir,
		Fy:      lift*fxDir + drag*fyDir,
		Lift:    lift,
		Drag:    drag,
		Cl:      cl,
		Alpha:   alpha,
		Stalled: stalled,
	}
}

// foilForces evaluates both foils. ambient is nil on the flat-water path.
func foilForces(state *BoatState, controls *Controls, boat *BoatModel, env *EnvironmentConfig, terms *TermToggles, models *ModelOptions, ambient *FoilAmbientFlow) FoilsResult {
	heel := state.Heel
	cHeel := 1 - 0.382*math.Abs(heel)
	lambda0 := 0.0
	if terms.ZeroLiftDrift {
		lambda0 = zeroLiftDrift(heel, boat.Cfg.Hull.Table2.BwlOverTc, models.Lambda0Unit, models.Lambda0Sign)
	}

	b := &boat.Board
	uBoard := state.U
	vBoard := state.V + state.R*b.X + state.P*b.Z
	if ambient != nil {
		uBoard -= state.PitchRate*b.Z*math.Cos(heel) + ambient.BoardU
		vBoard -= ambient.BoardV
	}
	board := foilForce(b, effectiveSlope(b, cHeel, models), uBoard, vBoard, 1, lambda0, heel, boat, env)

	downwash := 0.0
	if terms.Downwash {
		downwash = jsSign(board.Cl) * boat.Cfg.Foil.DownwashA0 * math.Sqrt(math.Abs(board.Cl)/(b.AspectRatioImage*b.Efficiency))
	}
	rd := &boat.Rudder
	rudderAngle := controls.Tiller * boat.Cfg.Rudder.MaxAngleDeg * DEG
	uRudder := state.U
	vRudder := state.V + state.R*rd.X + state.P*rd.Z
	if ambient != nil {
		uRudder -= state.PitchRate*rd.Z*math.Cos(heel) + ambient.RudderU
		vRudder -= ambient.RudderV
	}
	rudder := foilForce(
		rd,
		effectiveSlope(rd, cHeel, models),
		uRudder,
		vRudder,
		boat.Cfg.Rudder.InflowFactor,
		lambda0+rudderAngle+downwash,
		heel,
		boat,
		env,
	)

	return FoilsResult{
		Fx:          board.Fx + rudder.Fx,
		Fy:          board.Fy + rudder.Fy,
		HeelMoment:  b.Z*board.Fy + rd.Z*rudder.Fy,
		YawMoment:   b.X*board.Fy + rd.X*rudder.Fy,
		Board:       board,
		Rudder:      rudder,
		RudderAngle: rudderAngle,
		Lambda0:     lambda0,
		Downwash:    downwash,
	}
}
