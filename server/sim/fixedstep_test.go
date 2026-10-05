package sim

import "testing"

// Port of src/sim/fixedStep.test.ts.

func TestFixedStepRunsWholeStepsAndCarriesRemainder(t *testing.T) {
	f := NewFixedStep(0.01)
	equal(t, "advance(0.025)", f.Advance(0.025), 2)
	closeTo(t, "alpha", f.Alpha(), 0.5, 9)
	equal(t, "advance(0.005)", f.Advance(0.005), 1)
	closeTo(t, "alpha", f.Alpha(), 0, 9)
}

func TestFixedStepCapsLongFrame(t *testing.T) {
	f := &FixedStep{Dt: 0.01, MaxFrameTime: 0.1}
	equal(t, "advance(5)", f.Advance(5), 10)
}

func TestCubicSplinePassesThroughKnotsAndClamps(t *testing.T) {
	s, err := NewCubicSpline([]float64{0, 1, 3, 4}, []float64{0, 2, 1, 5})
	if err != nil {
		t.Fatal(err)
	}
	closeTo(t, "at(1)", s.At(1), 2, 12)
	closeTo(t, "at(3)", s.At(3), 1, 12)
	equal(t, "at(-1)", s.At(-1), 0)
	equal(t, "at(9)", s.At(9), 5)
}
