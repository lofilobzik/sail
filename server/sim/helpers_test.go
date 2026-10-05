package sim

import (
	"math"
	"testing"
)

// Helpers mirroring the vitest matchers used by src/sim/**/*.test.ts.

// closeTo is vitest toBeCloseTo(want, digits): |got - want| < 10^-digits / 2.
func closeTo(t *testing.T, name string, got, want float64, digits int) {
	t.Helper()
	if !(math.Abs(got-want) < math.Pow(10, -float64(digits))/2) {
		t.Errorf("%s: got %.17g, want %.17g (to %d digits)", name, got, want, digits)
	}
}

func less(t *testing.T, name string, got, bound float64) {
	t.Helper()
	if !(got < bound) {
		t.Errorf("%s: got %.17g, want < %.17g", name, got, bound)
	}
}

func lessEq(t *testing.T, name string, got, bound float64) {
	t.Helper()
	if !(got <= bound) {
		t.Errorf("%s: got %.17g, want <= %.17g", name, got, bound)
	}
}

func greater(t *testing.T, name string, got, bound float64) {
	t.Helper()
	if !(got > bound) {
		t.Errorf("%s: got %.17g, want > %.17g", name, got, bound)
	}
}

func greaterEq(t *testing.T, name string, got, bound float64) {
	t.Helper()
	if !(got >= bound) {
		t.Errorf("%s: got %.17g, want >= %.17g", name, got, bound)
	}
}

func equal[T comparable](t *testing.T, name string, got, want T) {
	t.Helper()
	if got != want {
		t.Errorf("%s: got %v, want %v", name, got, want)
	}
}

func mustDisable(t *testing.T, base SimConfig, names ...string) SimConfig {
	t.Helper()
	cfg, err := WithDisabledLayers(base, names)
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

// indexOf is Array.prototype.indexOf for a float table.
func indexOf(xs []float64, x float64) int {
	for i, v := range xs {
		if v == x {
			return i
		}
	}
	return -1
}

var testBoat = BuildBoat()
