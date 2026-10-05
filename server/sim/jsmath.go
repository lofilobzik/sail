package sim

import "math"

// JavaScript Math semantics the TypeScript sim relies on, reproduced so the port follows the
// same arithmetic as V8 where Go's math package differs.

// jsSign is Math.sign: -1, +1, or the argument itself for ±0 and NaN.
func jsSign(x float64) float64 {
	if x > 0 {
		return 1
	}
	if x < 0 {
		return -1
	}
	return x
}

// jsHypot is V8's Math.hypot for two arguments (src/builtins/math.tq): scale by the larger
// magnitude and sum the squares with Kahan compensation. Go's math.Hypot uses a different
// formula and differs in the last ulp.
func jsHypot(a, b float64) float64 {
	a, b = math.Abs(a), math.Abs(b)
	if math.IsInf(a, 0) || math.IsInf(b, 0) {
		return math.Inf(1)
	}
	if math.IsNaN(a) || math.IsNaN(b) {
		return math.NaN()
	}
	m := max(a, b)
	if m == 0 {
		return 0
	}
	sum, compensation := 0.0, 0.0
	for _, x := range [2]float64{a, b} {
		n := x / m
		summand := n*n - compensation
		preliminary := sum + summand
		compensation = (preliminary - sum) - summand
		sum = preliminary
	}
	return math.Sqrt(sum) * m
}

// jsRound is Math.round: the nearest integer, ties toward +Infinity.
func jsRound(x float64) float64 {
	r := math.Floor(x)
	if x-r >= 0.5 {
		r++
	}
	return r
}

// toUint32 is the ECMAScript ToUint32 (equivalently the bits of ToInt32): truncate toward zero,
// then reduce modulo 2^32. NaN and infinities give 0. Used for Math.imul, `| 0` and `>>> 0`.
func toUint32(x float64) uint32 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return 0
	}
	m := math.Mod(math.Trunc(x), 4294967296)
	if m < 0 {
		m += 4294967296
	}
	return uint32(m)
}
