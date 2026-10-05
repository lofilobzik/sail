package sim

import "errors"

// CubicSpline is a natural cubic spline through tabulated points, clamped to the end values
// outside the table (src/sim/spline.ts). Day 2017 p3: sail coefficients between the tabulated
// apparent wind angles are interpolated "using a cubic spline".
type CubicSpline struct {
	xs, ys []float64
	m      []float64 // second derivatives
}

// NewCubicSpline builds the spline. It needs at least 3 matching points.
func NewCubicSpline(xs, ys []float64) (*CubicSpline, error) {
	if len(xs) != len(ys) || len(xs) < 3 {
		return nil, errors.New("spline needs >= 3 matching points")
	}
	n := len(xs)
	m := make([]float64, n)
	// Tridiagonal solve for natural end conditions (m0 = mn = 0).
	c := make([]float64, n)
	d := make([]float64, n)
	for i := 1; i < n-1; i++ {
		h0 := xs[i] - xs[i-1]
		h1 := xs[i+1] - xs[i]
		a := h0
		b := 2 * (h0 + h1)
		cc := h1
		r := 6 * ((ys[i+1]-ys[i])/h1 - (ys[i]-ys[i-1])/h0)
		denom := b - a*c[i-1]
		c[i] = cc / denom
		d[i] = (r - a*d[i-1]) / denom
	}
	for i := n - 2; i >= 1; i-- {
		m[i] = d[i] - c[i]*m[i+1]
	}
	return &CubicSpline{xs: append([]float64(nil), xs...), ys: append([]float64(nil), ys...), m: m}, nil
}

func mustSpline(xs, ys []float64) *CubicSpline {
	s, err := NewCubicSpline(xs, ys)
	if err != nil {
		panic(err)
	}
	return s
}

// At evaluates the spline.
func (s *CubicSpline) At(x float64) float64 {
	xs := s.xs
	n := len(xs)
	if x <= xs[0] {
		return s.ys[0]
	}
	if x >= xs[n-1] {
		return s.ys[n-1]
	}
	i := 0
	for x > xs[i+1] {
		i++
	}
	h := xs[i+1] - xs[i]
	a := (xs[i+1] - x) / h
	b := (x - xs[i]) / h
	return a*s.ys[i] +
		b*s.ys[i+1] +
		((a*a*a-a)*s.m[i]+(b*b*b-b)*s.m[i+1])*(h*h)/6
}
