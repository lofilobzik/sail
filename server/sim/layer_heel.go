package sim

import "math"

// L5 Heel and hiking (PHYSICS.md L5), src/sim/layers/heel.ts.
//
// Righting moment, Day 2017 Eq. 18 (PDF p8), written as a signed moment for any
// crew position (Day gives the maximum with the crew fully hiked):
//
//	RM = W_hull GZ(phi) + W_crew (GZ(phi) + dYCG_crew cos(phi) - dZCG_crew sin(phi))
//
// GZ(phi) is the righting lever with the crew mass at the hull CG. Hull form
// stability from the small-angle relation GZ = GM sin(phi) (Larsson & Eliasson
// p41, PDF p57, Fig 4.9), GM from boat.go.
//
// Crew position (Day 2017 pp7-8): CG at 55% of standing height; fully hiked, the CG
// is at most 95% of that height out from the centreline (toe strap on the
// centreline). Sitting-in offset and CG heights are TUNING GUESS (laser.json).
// The crew sits on the side opposite the boom and moves across at a limited rate. With the
// crewCentresWhenLuffing term the target offset shrinks as the sail luffs (reach x (1 - luffAmount)).
// The sailor only changes sides once the boom has swung clearly across, so a boom
// flicking about the centreline head to wind does not make the crew rock the boat.
// The sign of CrewY is the sailor's memory of their side, so a fully luffing sail never pulls
// them exactly onto the centreline (minCrewOffset): at exactly 0 the side would come from
// BoomSide, which flips with every apparent-wind crossing head to wind.

// CrewCrossingSpeed is how fast the sailor moves across the boat, m/s. TUNING GUESS.
const CrewCrossingSpeed = 1.5

// crewSwitchBoomAngle is the boom angle past the centreline at which the sailor changes sides.
// TUNING GUESS.
const crewSwitchBoomAngle = 10 * DEG

// minCrewOffset is the smallest target offset, m, so the sign of CrewY (the side) survives a fully
// luffing sail. 1 mm of 80 kg is under 1 N m of heel. TUNING GUESS.
const minCrewOffset = 0.001

// CrewPosition is where the sailor is heading.
type CrewPosition struct {
	// Target transverse offset from the centreline, m (+ = starboard).
	TargetY float64 `json:"targetY"`
	// Height relative to the hull CG, m.
	Z float64 `json:"z"`
	// Maximum hiking reach, m.
	MaxReach float64 `json:"maxReach"`
}

// crewPosition: luffAmount (0..1) pulls the target toward the centreline; pass 0 to keep the full
// offset.
func crewPosition(state *BoatState, controls *Controls, boat *BoatModel, luffAmount float64) CrewPosition {
	c := &boat.Cfg.Crew
	hike := min(max(controls.Hike, 0), 1)
	maxReach := c.HikeReachFrac * c.CgHeightFrac * c.Height
	reach := max((c.SitInOffset+hike*(maxReach-c.SitInOffset))*(1-min(max(luffAmount, 0), 1)), minCrewOffset)
	var side float64
	if math.Abs(state.Boom) > crewSwitchBoomAngle {
		side = -jsSign(state.Boom)
	} else if state.CrewY != 0 {
		side = jsSign(state.CrewY)
	} else {
		side = -float64(state.BoomSide)
	}
	return CrewPosition{
		TargetY:  side * reach,
		Z:        c.SitInZAboveHullCg + hike*(c.HikedZAboveHullCg-c.SitInZAboveHullCg),
		MaxReach: maxReach,
	}
}

// rightingMoment is the signed hydrostatic + crew moment about the roll axis, N m (+ = heels to
// starboard).
func rightingMoment(heel, crewY, crewZ float64, boat *BoatModel) float64 {
	gz := boat.Gm * math.Sin(heel)
	wHull := boat.HullMass * G
	wCrew := boat.CrewMass * G
	// Eq. 18 terms with signs: hull and crew GZ resist heel; crew offset to starboard
	// (crewY > 0) heels to starboard; crew above the hull CG adds to the heel.
	return -(wHull+wCrew)*gz + wCrew*(crewY*math.Cos(heel)+crewZ*math.Sin(heel))
}
