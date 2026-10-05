package sim

import "math"

// ittcFriction is the ITTC-1957 friction line (Day 2017 p6; Larsson & Eliasson p64, PDF p80, Fig 5.8):
//
//	Cf = 0.075 / (log10(Rn) - 2)^2
//
// Rn is floored at 1e5 (TUNING GUESS) where the line is not valid. (src/sim/friction.ts)
func ittcFriction(rn float64) float64 {
	l := math.Log10(max(rn, 1e5)) - 2
	return 0.075 / (l * l)
}
