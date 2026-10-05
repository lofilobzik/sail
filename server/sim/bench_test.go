package sim

import "testing"

// BenchmarkStep measures one fixed step of the full browser world (waves, gusts, bay), the
// server's per-tick cost per boat.
func BenchmarkStep(b *testing.B) {
	cfg := BrowserConfig(1)
	s := InitialState(90*DEG, 1)
	c := Controls{Tiller: 0, Sheet: 0.4, Hike: 0.3}
	b.ReportAllocs()
	for b.Loop() {
		s = Step(s, c, testBoat, &cfg).State
	}
}
