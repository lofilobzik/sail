package sim

import "math"

// L4 Hull resistance (PHYSICS.md L4), src/sim/layers/hull.ts.
//
// Upright, two models (cfg.models.uprightResistance):
//   - "delft" (default): friction + residuary.
//     Friction: ITTC-1957, Rn on 0.7 Lwl, wetted area from Larsson Fig 4.2
//     (Larsson & Eliasson p64, PDF p80, Fig 5.8): R_F = Cf 1/2 rho V^2 Sw.
//     Residuary: Keuning & Katgert Eq. 1.7 / Table 2 (docs/bare_hull_resistance.pdf p6,
//     = Day 2017 Eq. 10, PDF p6) with the Laser form ratios of Day Table 2:
//     Rrh = (Rrh / (Vc rho g))(Fn) * Vc rho g, splined in Fn over 0.15-0.75, held above 0.75.
//     Below Fn 0.15: Rrh(0.15) (Fn/0.15)^2, TUNING GUESS blend to zero.
//   - "tank": Day 2017 Fig. 2 (PDF p7) bare-hull tank drag area at 160 kg level trim;
//     R = 1/2 rho V^2 * dragArea. APPROXIMATE (read off the plot). Linear interpolation,
//     held constant outside 2-9 kn. Day uses this instead of Delft (section 3.2).
//
// Heel: Larsson & Eliasson p83 (PDF p99), Fig 5.26 (Delft):
//
//	C_H = [6.747 (Tc/T) + 2.517 (Bwl/Tc) + 3.710 (Bwl/Tc)(Tc/T)] 1e-3
//	R_H = 1/2 rho V^2 Sw C_H Fn^2 phi      (phi in rad)
//
// Crossflow: TUNING GUESS. Strip-wise drag on the canoe-body lateral area when the
// hull slides sideways (Cd from laser.json), needed when the board is stalled or
// the boat is stopped. Includes the yaw-rate velocity along the hull.

// HullResult is the L4 output.
type HullResult struct {
	Fx         float64 `json:"fx"`
	Fy         float64 `json:"fy"`
	YawMoment  float64 `json:"yawMoment"`
	HeelMoment float64 `json:"heelMoment"`
	Upright    float64 `json:"upright"`
	// Parts of Upright for the "delft" model (0 for "tank").
	Friction       float64 `json:"friction"`
	Residuary      float64 `json:"residuary"`
	HeelResistance float64 `json:"heelResistance"`
	Crossflow      float64 `json:"crossflow"`
}

const crossflowStrips = 8

// tableDragArea is linear interpolation in a {speedKn, dragAreaM2} table, held constant at the
// ends.
func tableDragArea(t *DragAreaTable, speed float64) float64 {
	kn := math.Abs(speed) / KNOT
	xs := t.SpeedKn
	ys := t.DragAreaM2
	if kn <= xs[0] {
		return ys[0]
	}
	last := len(xs) - 1
	if kn >= xs[last] {
		return ys[last]
	}
	i := 0
	for kn > xs[i+1] {
		i++
	}
	f := (kn - xs[i]) / (xs[i+1] - xs[i])
	return ys[i] + f*(ys[i+1]-ys[i])
}

// DelftUpright is the Delft upright resistance split into friction and residuary, N (both >= 0
// for forward speed).
func DelftUpright(boat *BoatModel, speed float64, env *EnvironmentConfig) (friction, residuary float64) {
	v := math.Abs(speed)
	h := &boat.Cfg.Hull
	rn := (v * h.FrictionLengthFrac * boat.Lwl) / env.NuWater
	friction = ittcFriction(rn) * 0.5 * env.RhoWater * v * v * boat.WettedArea
	fn := v / math.Sqrt(G*boat.Lwl)
	weight := boat.Volume * env.RhoWater * G
	fnLow := h.ResiduaryBlendFn
	if fn >= fnLow {
		residuary = boat.ResiduaryRatio.At(fn) * weight
	} else {
		residuary = boat.ResiduaryRatio.At(fnLow) * weight * math.Pow(fn/fnLow, h.ResiduaryBlendExponent)
	}
	return friction, residuary
}

func heelResistanceCoefficient(boat *BoatModel) float64 {
	bwlTc := boat.Cfg.Hull.Table2.BwlOverTc
	tcT := boat.Tc / boat.Cfg.Hull.DraughtBoardDown
	return (6.747*tcT + 2.517*bwlTc + 3.71*bwlTc*tcT) * 1e-3
}

func hullForces(state *BoatState, boat *BoatModel, env *EnvironmentConfig, terms *TermToggles, models *ModelOptions) HullResult {
	rho := env.RhoWater
	u := state.U
	q := 0.5 * rho * u * u
	friction, residuary := 0.0, 0.0
	var upright float64
	if models.UprightResistance == "delft" {
		friction, residuary = DelftUpright(boat, u, env)
		upright = friction + residuary
	} else {
		upright = q * tableDragArea(&boat.Cfg.Hull.UprightDragArea, u)
	}

	heelResistance := 0.0
	if terms.HeelResistance {
		fn2 := (u * u) / (G * boat.Lwl)
		heelResistance = q * boat.WettedArea * heelResistanceCoefficient(boat) * fn2 * math.Abs(state.Heel)
	}

	fy := 0.0
	yawMoment := 0.0
	if terms.CrossflowDrag {
		dx := boat.Lwl / crossflowStrips
		k := 0.5 * rho * boat.Cfg.Hull.CrossflowCd * boat.Tc * dx
		for i := range crossflowStrips {
			x := -boat.Lwl/2 + (float64(i)+0.5)*dx
			vl := state.V + state.R*x
			f := -k * vl * math.Abs(vl)
			fy += f
			yawMoment += x * f
		}
	}

	fx := -jsSign(u) * (upright + heelResistance)
	// Crossflow acts at about half the canoe-body draft.
	return HullResult{
		Fx: fx, Fy: fy, YawMoment: yawMoment, HeelMoment: (-boat.Tc / 2) * fy, Upright: upright,
		Friction: friction, Residuary: residuary, HeelResistance: heelResistance, Crossflow: fy,
	}
}
