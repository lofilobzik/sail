package sim

import (
	"math"
)

// Boat model derived from a boat config file (data/laser.json), src/sim/boat.ts. All geometry is
// expressed in the body frame: x forward from the reference point, z up from the waterline, y to
// starboard. The reference point is the longitudinal centre of buoyancy on the centreline at the
// waterline; with the boat in level trim the system CG sits above it.

// FoilJSON is one foil entry of data/laser.json (daggerboard, rudder).
type FoilJSON struct {
	Span                    float64 `json:"span"`
	Chord                   float64 `json:"chord"`
	Thickness               float64 `json:"thickness"`
	SweepDeg                float64 `json:"sweepDeg"`
	TaperRatio              float64 `json:"taperRatio"`
	LeadingEdgeXFromTransom float64 `json:"leadingEdgeXFromTransom"`
	CpDepthFrac             float64 `json:"cpDepthFrac"`
	CpChordFrac             float64 `json:"cpChordFrac"`
}

// DragAreaTable is a {speedKn, dragAreaM2} table (data/laser.json hull.uprightDragArea).
type DragAreaTable struct {
	SpeedKn    []float64 `json:"speedKn"`
	DragAreaM2 []float64 `json:"dragAreaM2"`
}

// BoatConfig mirrors the physics part of data/laser.json (TS BoatConfig); the render-only
// "visual" section and "sources" are not decoded.
type BoatConfig struct {
	Name string `json:"name"`
	Hull struct {
		Loa              float64 `json:"loa"`
		Lwl              float64 `json:"lwl"`
		Beam             float64 `json:"beam"`
		DraughtBoardDown float64 `json:"draughtBoardDown"`
		MassWithoutSail  float64 `json:"massWithoutSail"`
		CgAboveDeck      float64 `json:"cgAboveDeck"`
		DepthDeckToKeel  float64 `json:"depthDeckToKeel"`
		Table2           struct {
			DisplacementKg float64 `json:"displacementKg"`
			LcbOverLwl     float64 `json:"lcbOverLwl"`
			Cp             float64 `json:"cp"`
			Vol23OverAw    float64 `json:"vol23OverAw"`
			BwlOverLwl     float64 `json:"bwlOverLwl"`
			LcbOverLcf     float64 `json:"lcbOverLcf"`
			BwlOverTc      float64 `json:"bwlOverTc"`
			Cm             float64 `json:"cm"`
			Vol13OverLwl   float64 `json:"vol13OverLwl"`
		} `json:"table2"`
		KbBelowWaterlineFracOfTc float64       `json:"kbBelowWaterlineFracOfTc"`
		CrossflowCd              float64       `json:"crossflowCd"`
		TopsidesCd               float64       `json:"topsidesCd"`
		UprightDragArea          DragAreaTable `json:"uprightDragArea"`
		UprightDragAreaDayDelft  DragAreaTable `json:"uprightDragAreaDayDelft"`
		FrictionLengthFrac       float64       `json:"frictionLengthFrac"`
		ResiduaryBlendFn         float64       `json:"residuaryBlendFn"`
		ResiduaryBlendExponent   float64       `json:"residuaryBlendExponent"`
	} `json:"hull"`
	Rig struct {
		SailArea               float64 `json:"sailArea"`
		Luff                   float64 `json:"luff"`
		Foot                   float64 `json:"foot"`
		CeHeightFracOfLuff     float64 `json:"ceHeightFracOfLuff"`
		CeAftFracOfFoot        float64 `json:"ceAftFracOfFoot"`
		MastRakeAtCeDeg        float64 `json:"mastRakeAtCeDeg"`
		GooseneckAboveMastButt float64 `json:"gooseneckAboveMastButt"`
		MastButtBelowDeck      float64 `json:"mastButtBelowDeck"`
		MastXFromTransom       float64 `json:"mastXFromTransom"`
		MastDiameter           float64 `json:"mastDiameter"`
		BareMastCd             float64 `json:"bareMastCd"`
		SleeveMastCd           float64 `json:"sleeveMastCd"`
		EffectiveSpanFactor    float64 `json:"effectiveSpanFactor"`
		SeparationDragCds      float64 `json:"separationDragCds"`
		BoomMinDeg             float64 `json:"boomMinDeg"`
		BoomMaxDeg             float64 `json:"boomMaxDeg"`
		BoomTimeConstant       float64 `json:"boomTimeConstant"`
		GybeByTheLeeDeg        float64 `json:"gybeByTheLeeDeg"`
		LuffStartBetaEffDeg    float64 `json:"luffStartBetaEffDeg"`
		LuffFullBetaEffDeg     float64 `json:"luffFullBetaEffDeg"`
		StallWidthDeg          float64 `json:"stallWidthDeg"`
	} `json:"rig"`
	Crew struct {
		Mass              float64 `json:"mass"`
		Height            float64 `json:"height"`
		CgHeightFrac      float64 `json:"cgHeightFrac"`
		HikeReachFrac     float64 `json:"hikeReachFrac"`
		SitInOffset       float64 `json:"sitInOffset"`
		SitInZAboveHullCg float64 `json:"sitInZAboveHullCg"`
		HikedZAboveHullCg float64 `json:"hikedZAboveHullCg"`
		Dubois            struct {
			Coef      float64 `json:"coef"`
			WeightExp float64 `json:"weightExp"`
			HeightExp float64 `json:"heightExp"`
		} `json:"dubois"`
		FrontalAreaFrac   float64 `json:"frontalAreaFrac"`
		SideAreaFrac      float64 `json:"sideAreaFrac"`
		CdFrontal         float64 `json:"cdFrontal"`
		CdSide            float64 `json:"cdSide"`
		ClothingReduction float64 `json:"clothingReduction"`
		Shielding         float64 `json:"shielding"`
	} `json:"crew"`
	Daggerboard FoilJSON `json:"daggerboard"`
	Rudder      struct {
		FoilJSON
		MaxAngleDeg  float64 `json:"maxAngleDeg"`
		InflowFactor float64 `json:"inflowFactor"`
	} `json:"rudder"`
	Foil struct {
		ClMax          float64 `json:"clMax"`
		FormFactorK    float64 `json:"formFactorK"`
		DownwashA0     float64 `json:"downwashA0"`
		PostStallCdMax float64 `json:"postStallCdMax"`
	} `json:"foil"`
	Dynamics struct {
		SurgeAddedMassFrac         float64 `json:"surgeAddedMassFrac"`
		SwayAddedMass              float64 `json:"swayAddedMass"`
		YawRadiusOfGyrationFracLoa float64 `json:"yawRadiusOfGyrationFracLoa"`
		YawAddedInertiaFrac        float64 `json:"yawAddedInertiaFrac"`
		RollInertia                float64 `json:"rollInertia"`
		RollDamping                float64 `json:"rollDamping"`
		YawDamping                 float64 `json:"yawDamping"`
		HeelLimitDeg               float64 `json:"heelLimitDeg"`
	} `json:"dynamics"`
}

// SailCoefficientTable is data/sail-coefficients.json (Day 2017 Table 1).
type SailCoefficientTable struct {
	BetaDeg []float64 `json:"betaDeg"`
	Cl      []float64 `json:"cl"`
	Cdv     []float64 `json:"cdv"`
}

type residuaryTable struct {
	Fn []float64 `json:"fn"`
	A0 []float64 `json:"a0"`
	A1 []float64 `json:"a1"`
	A2 []float64 `json:"a2"`
	A3 []float64 `json:"a3"`
	A4 []float64 `json:"a4"`
	A5 []float64 `json:"a5"`
	A6 []float64 `json:"a6"`
	A7 []float64 `json:"a7"`
}

var (
	// LaserJSON is data/laser.json. Read-only; copy it before modifying.
	LaserJSON = load[BoatConfig]("laser.json")
	// SailCoefficients is data/sail-coefficients.json. Read-only.
	SailCoefficientsJSON = load[SailCoefficientTable]("sail-coefficients.json")
	// ResiduaryJSON is data/delft-residuary.json (Keuning & Katgert Table 2). Read-only.
	ResiduaryJSON = load[residuaryTable]("delft-residuary.json")
)

// FoilModel is a daggerboard or rudder derived from its config.
type FoilModel struct {
	Span  float64 `json:"span"`
	Chord float64 `json:"chord"`
	Area  float64 `json:"area"`
	// Day 2017 p6: AR_E = 2 b / c (image in the hull / free surface).
	AspectRatioImage float64 `json:"aspectRatioImage"`
	// Day 2017 Eq. 17 planform efficiency e.
	Efficiency float64 `json:"efficiency"`
	// dCL/dalpha per radian (Day 2017 p6, below Eq. 11), standard form (no outer square).
	LiftSlope float64 `json:"liftSlope"`
	// Same with the outer square as printed on Day p6 (models.liftSlope = "printed").
	LiftSlopePrinted float64 `json:"liftSlopePrinted"`
	// Day 2017 p6: c_hull = 1 + 1.80 (Tc / b).
	CHull float64 `json:"cHull"`
	// Centre of pressure, body frame.
	X         float64 `json:"x"`
	Z         float64 `json:"z"`
	Thickness float64 `json:"thickness"`
}

// BoatModel is the derived boat (TS BoatModel). Treat it as read-only once built; it is safe to
// share between goroutines.
type BoatModel struct {
	Cfg *BoatConfig `json:"-"`
	// Masses, kg.
	HullMass float64 `json:"hullMass"`
	CrewMass float64 `json:"crewMass"`
	Mass     float64 `json:"mass"`
	// Hull form (Day 2017 Table 2, 160 kg row).
	Lwl            float64 `json:"lwl"`
	Bwl            float64 `json:"bwl"`
	Tc             float64 `json:"tc"`
	Volume         float64 `json:"volume"`
	WaterplaneArea float64 `json:"waterplaneArea"`
	Cwp            float64 `json:"cwp"`
	WettedArea     float64 `json:"wettedArea"`
	Freeboard      float64 `json:"freeboard"`
	// Hull CG height above the waterline (system CG for Eq. 18 GZ).
	ZHullCg float64 `json:"zHullCg"`
	// Metacentric height, m (Larsson & Eliasson p41, Fig 4.9).
	Gm float64 `json:"gm"`
	// Rig geometry.
	XMast           float64 `json:"xMast"`
	ZBoom           float64 `json:"zBoom"`
	CeAboveBoom     float64 `json:"ceAboveBoom"`
	CeAftOfMast     float64 `json:"ceAftOfMast"`
	SailAspectRatio float64 `json:"sailAspectRatio"`
	BoomAboveDeck   float64 `json:"boomAboveDeck"`
	// Sail coefficient splines vs apparent wind angle in degrees.
	ClTable  *CubicSpline `json:"-"`
	CdvTable *CubicSpline `json:"-"`
	// Keuning & Katgert residuary resistance Rrh / (Vc rho g) vs Froude number, Fn 0.15-0.75.
	ResiduaryRatio *CubicSpline `json:"-"`
	// Apparent wind angle of maximum tabulated lift, rad.
	BetaPeak float64   `json:"betaPeak"`
	Board    FoilModel `json:"board"`
	Rudder   FoilModel `json:"rudder"`
	// Inertias.
	YawInertia  float64 `json:"yawInertia"`
	RollInertia float64 `json:"rollInertia"`
}

// liftSlope of a low aspect ratio foil, Day 2017 p6 (PDF p6), text below Eq. 11:
//
//	printed:  dCL/dalpha = 5.7 AR_E / (1.8 + cos(Lambda) sqrt((AR_E^2 / cos^4(Lambda))^2 + 4))
//	standard: the same without the outer square on AR_E^2/cos^4(Lambda).
//
// The outer square is treated as a probable misprint (docs/DAY-EQUATIONS.md): at AR_E = 4 the
// printed form gives 1.27/rad against about 4.2/rad from lifting-line theory; the standard form
// 3.6/rad.
func liftSlope(arE, sweep float64, printed bool) float64 {
	c := math.Cos(sweep)
	x := (arE * arE) / math.Pow(c, 4)
	if printed {
		x = x * x
	}
	return (5.7 * arE) / (1.8 + c*math.Sqrt(x+4))
}

// planformEfficiency, Day 2017 Eq. 17 (PDF p7), after Nita and Scholz (2012):
//
//	e = 1 / (1 + f(TR - dTR) AR)
//	dTR = -0.357 + 0.45 exp(0.0375 Lambda)   (Lambda in degrees)
//	f(TR) = 0.0524 TR^4 - 0.1500 TR^3 + 0.1659 TR^2 - 0.0706 TR + 0.0119
func planformEfficiency(ar, taper, sweepDeg float64) float64 {
	dTr := -0.357 + 0.45*math.Exp(0.0375*sweepDeg)
	t := taper - dTr
	f := 0.0524*math.Pow(t, 4) - 0.15*math.Pow(t, 3) + 0.1659*math.Pow(t, 2) - 0.0706*t + 0.0119
	return 1 / (1 + f*ar)
}

func buildFoil(f *FoilJSON, tc, topDepth, xRefFromTransom float64) FoilModel {
	ar := (2 * f.Span) / f.Chord
	// Day 2017 p7: centre of pressure on the quarter chord at 43% of the total
	// draft of the foil (waterline to the lower extent of the foil).
	lowerExtent := topDepth + f.Span
	return FoilModel{
		Span:             f.Span,
		Chord:            f.Chord,
		Area:             f.Span * f.Chord,
		AspectRatioImage: ar,
		Efficiency:       planformEfficiency(ar, f.TaperRatio, f.SweepDeg),
		LiftSlope:        liftSlope(ar, f.SweepDeg*DEG, false),
		LiftSlopePrinted: liftSlope(ar, f.SweepDeg*DEG, true),
		CHull:            1 + 1.8*(tc/f.Span),
		X:                f.LeadingEdgeXFromTransom - f.CpChordFrac*f.Chord - xRefFromTransom,
		Z:                -f.CpDepthFrac * lowerExtent,
		Thickness:        f.Thickness,
	}
}

// waterplaneInertia is the transverse waterplane inertia I_T = (2/3) * integral of half-beam^3 dx
// (Larsson & Eliasson p39, Fig 4.8). No Laser waterplane offsets exist in docs/, so the half-beam
// is modelled as b(x) = (Bwl/2) (1 - |2x/Lwl|^p) with p chosen to reproduce the waterplane
// coefficient from Day Table 2.
// TUNING GUESS: the shape family itself.
func waterplaneInertia(lwl, bwl, cwp float64) float64 {
	p := cwp / (1 - cwp) // mean of (1 - u^p) over [0,1] is p/(p+1) = Cwp
	const n = 400
	mean3 := 0.0
	for i := range n {
		u := (float64(i) + 0.5) / n
		mean3 += math.Pow(1-math.Pow(u, p), 3)
	}
	mean3 /= n
	return (2.0 / 3) * lwl * math.Pow(bwl/2, 3) * mean3
}

// BuildBoat builds the Laser from data/laser.json and data/sail-coefficients.json.
func BuildBoat() *BoatModel {
	return BuildBoatFrom(LaserJSON, SailCoefficientsJSON)
}

// BuildBoatFrom is TS buildBoat(cfg, table) for a modified boat config (e.g. polar --set).
func BuildBoatFrom(cfg BoatConfig, table SailCoefficientTable) *BoatModel {
	h := &cfg.Hull
	t2 := &h.Table2
	// Day 2017 Table 2 (p7), 160 kg level trim.
	lwl := h.Lwl
	bwl := t2.BwlOverLwl * lwl
	tc := bwl / t2.BwlOverTc
	volume := math.Pow(t2.Vol13OverLwl*lwl, 3)
	waterplaneArea := math.Pow(volume, 2.0/3) / t2.Vol23OverAw
	cwp := waterplaneArea / (lwl * bwl)
	// Larsson & Eliasson p33 (PDF p49), Fig 4.2, empirical wetted surface:
	//   Sw = (1.97 + 0.171 Bwl/Tc) sqrt(Vc Lwl) (0.65 / Cm)^(1/3)
	wettedArea := (1.97 + 0.171*t2.BwlOverTc) * math.Sqrt(volume*lwl) * math.Cbrt(0.65/t2.Cm)

	// Reference point: LCB. Day Table 2 gives LCB/Lwl from the forward perpendicular.
	// TUNING GUESS: the aft end of the waterline is taken to be at the transom.
	xRefFromTransom := lwl * (1 - t2.LcbOverLwl)

	freeboard := h.DepthDeckToKeel - tc  // depth is a web source, see laser.json
	zHullCg := freeboard + h.CgAboveDeck // Day 2017 p8: CG 12 cm above deck
	kb := -h.KbBelowWaterlineFracOfTc * tc
	// Larsson & Eliasson p41 (PDF p57), Fig 4.9: BM = I_T / V, GM = BM - BG.
	bm := waterplaneInertia(lwl, bwl, cwp) / volume
	gm := bm - (zHullCg - kb)

	rig := &cfg.Rig
	boomAboveDeck := rig.GooseneckAboveMastButt - rig.MastButtBelowDeck
	zBoom := freeboard + boomAboveDeck
	ceAboveBoom := rig.CeHeightFracOfLuff * rig.Luff // Day 2017 p4
	// Day 2017 p4: CE 33% of the foot aft of the luff, plus the aft shift of an
	// 11 deg equivalent mast rake at CE height.
	ceAftOfMast := rig.CeAftFracOfFoot*rig.Foot + ceAboveBoom*math.Tan(rig.MastRakeAtCeDeg*DEG)
	// ORC VPP Documentation 2023 Eq. 5.45 form: heff = cheff (P + BAS + HBI); AR = heff^2 / A.
	heff := rig.EffectiveSpanFactor * (rig.Luff + boomAboveDeck + freeboard)
	sailAspectRatio := (heff * heff) / rig.SailArea

	clTable := mustSpline(table.BetaDeg, table.Cl)
	cdvTable := mustSpline(table.BetaDeg, table.Cdv)
	betaPeak := 0.0
	clPeak := math.Inf(-1)
	for b := 0.0; b <= 180; b += 0.1 {
		cl := clTable.At(b)
		if cl > clPeak {
			clPeak = cl
			betaPeak = b
		}
	}

	board := buildFoil(&cfg.Daggerboard, tc, tc, xRefFromTransom)

	// Keuning & Katgert Eq. 1.7 (docs/bare_hull_resistance.pdf p6), = Day 2017 Eq. 10, evaluated
	// for this hull at each tabulated Fn, then splined in Fn (Day p3 uses splines for tabulated
	// data).
	r := &ResiduaryJSON
	ratios := make([]float64, len(r.Fn))
	for i := range r.Fn {
		form := r.A1[i]*t2.LcbOverLwl +
			r.A2[i]*t2.Cp +
			r.A3[i]*t2.Vol23OverAw +
			r.A4[i]*t2.BwlOverLwl +
			r.A5[i]*t2.LcbOverLcf +
			r.A6[i]*t2.BwlOverTc +
			r.A7[i]*t2.Cm
		ratios[i] = r.A0[i] + form*t2.Vol13OverLwl
	}
	residuaryRatio := mustSpline(r.Fn, ratios)
	// The rudder hangs off the transom from (about) the waterline.
	rudder := buildFoil(&cfg.Rudder.FoilJSON, tc, 0, xRefFromTransom)

	hullMass := h.MassWithoutSail
	crewMass := cfg.Crew.Mass
	mass := hullMass + crewMass
	d := &cfg.Dynamics
	yawInertia := mass * math.Pow(d.YawRadiusOfGyrationFracLoa*h.Loa, 2)

	return &BoatModel{
		Cfg:             &cfg,
		HullMass:        hullMass,
		CrewMass:        crewMass,
		Mass:            mass,
		Lwl:             lwl,
		Bwl:             bwl,
		Tc:              tc,
		Volume:          volume,
		WaterplaneArea:  waterplaneArea,
		Cwp:             cwp,
		WettedArea:      wettedArea,
		Freeboard:       freeboard,
		ZHullCg:         zHullCg,
		Gm:              gm,
		XMast:           rig.MastXFromTransom - xRefFromTransom,
		ZBoom:           zBoom,
		CeAboveBoom:     ceAboveBoom,
		CeAftOfMast:     ceAftOfMast,
		SailAspectRatio: sailAspectRatio,
		BoomAboveDeck:   boomAboveDeck,
		ClTable:         clTable,
		CdvTable:        cdvTable,
		ResiduaryRatio:  residuaryRatio,
		BetaPeak:        betaPeak * DEG,
		Board:           board,
		Rudder:          rudder,
		YawInertia:      yawInertia,
		RollInertia:     d.RollInertia,
	}
}
