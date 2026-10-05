package sim

import "math"

// FixedStep is a fixed-timestep accumulator (src/sim/fixedStep.ts). Feed it real frame time; it
// reports how many fixed steps to run and the interpolation factor between the previous and
// current sim states for rendering (DESIGN.md: fixed timestep, rendering interpolates).
type FixedStep struct {
	Dt float64
	// Frame-time cap so a stalled tab does not trigger a spiral of catch-up steps.
	MaxFrameTime float64
	accumulator  float64
}

// NewFixedStep uses the TS default frame-time cap of 0.25 s.
func NewFixedStep(dt float64) *FixedStep {
	return &FixedStep{Dt: dt, MaxFrameTime: 0.25}
}

// Advance adds elapsed real time (s) and returns the number of fixed steps to run now.
func (f *FixedStep) Advance(frameTime float64) int {
	f.accumulator += min(max(frameTime, 0), f.MaxFrameTime)
	steps := math.Floor(f.accumulator / f.Dt)
	f.accumulator -= steps * f.Dt
	return int(steps)
}

// Alpha is the interpolation factor in [0, 1) between the last two fixed states.
func (f *FixedStep) Alpha() float64 {
	return f.accumulator / f.Dt
}
