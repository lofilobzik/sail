package sim

import (
	"math"
	"reflect"
	"testing"
)

// Port of src/sim/waveDynamics.test.ts.

var waveTestControls = Controls{Tiller: 0, Sheet: 0.5, Hike: 0}

func waveTestConfig(t *testing.T, dx, dz, phase float64) SimConfig {
	t.Helper()
	// Deliberate deterministic test sea, not boat response tuning.
	k := 2 * math.Pi / 12
	component := WaveComponent{Dx: dx, Dz: dz, K: k, Omega: math.Sqrt(G * k), Amplitude: 0.12, Phase: phase, Choppiness: 1}
	cfg := mustDisable(t, DefaultConfigUnseeded(), "sail", "hull", "apparentWind")
	cfg.Substeps = 1
	cfg.Wind = WindConfig{SpeedKn: 0, FromDeg: 0}
	cfg.Terms.Downwash = false
	cfg.Terms.ZeroLiftDrift = false
	cfg.Terms.MunkMoment = false
	cfg.Waves.Enabled = true
	cfg.Waves.AmplitudeScale = 1
	cfg.Waves.Components = []WaveComponent{component}
	return cfg
}

func advanceWaves(state BoatState, cfg *SimConfig, count int) BoatState {
	for range count {
		state = Step(state, waveTestControls, testBoat, cfg).State
	}
	return state
}

func TestZeroAmplitudeKeepsExactFlatWaterTrajectory(t *testing.T) {
	off := DefaultConfigUnseeded()
	zero := off
	zero.Waves.Enabled = true
	zero.Waves.AmplitudeScale = 0
	a := InitialState(55*DEG, 2)
	a.Heel, a.P, a.V, a.R = 0.1, -0.02, 0.15, 0.01
	b := a
	for i := range 600 {
		ra := Step(a, waveTestControls, testBoat, &off)
		rb := Step(b, waveTestControls, testBoat, &zero)
		if !reflect.DeepEqual(ra, rb) {
			t.Fatalf("step %d: zero-amplitude result differs from flat water", i)
		}
		if ra.Diagnostics.Waves != nil {
			t.Fatalf("step %d: waves diagnostics not nil on flat water", i)
		}
		a, b = ra.State, rb.State
	}
}

func TestTransverseSlopeAppliesRestoringTorque(t *testing.T) {
	plus := mustDisable(t, waveTestConfig(t, 1, 0, 0), "foils")
	minus := mustDisable(t, waveTestConfig(t, -1, 0, 0), "foils")
	start := InitialState(0, 0)
	a := Step(start, waveTestControls, testBoat, &plus)
	b := Step(start, waveTestControls, testBoat, &minus)
	less(t, "rollTarget", a.Diagnostics.Waves.RollTarget, 0)
	less(t, "rollMoment", a.Diagnostics.Waves.RollMoment, 0)
	steepness := plus.Waves.Components[0].K * plus.Waves.Components[0].Amplitude
	greater(t, "|rollTarget|", math.Abs(a.Diagnostics.Waves.RollTarget), 0.9*steepness)
	less(t, "|rollTarget|", math.Abs(a.Diagnostics.Waves.RollTarget), 1.1*steepness)
	less(t, "p", a.State.P, 0)
	less(t, "heel", a.State.Heel, 0)
	closeTo(t, "mirrored p", b.State.P, -a.State.P, 12)
	closeTo(t, "mirrored heel", b.State.Heel, -a.State.Heel, 12)
}

func TestLongitudinalSlopeDrivesPitch(t *testing.T) {
	plus := mustDisable(t, waveTestConfig(t, 0, -1, 0), "foils")
	minus := mustDisable(t, waveTestConfig(t, 0, 1, 0), "foils")
	a := Step(InitialState(0, 0), waveTestControls, testBoat, &plus)
	b := Step(InitialState(0, 0), waveTestControls, testBoat, &minus)
	greater(t, "pitchTarget", a.Diagnostics.Waves.PitchTarget, 0)
	greater(t, "pitchRate", a.State.PitchRate, 0)
	greater(t, "pitch", a.State.Pitch, 0)
	closeTo(t, "mirrored pitchRate", b.State.PitchRate, -a.State.PitchRate, 12)
	closeTo(t, "mirrored pitch", b.State.Pitch, -a.State.Pitch, 12)
}

func TestSideWaveOrbitalFlowReversesFoilForce(t *testing.T) {
	plus := mustDisable(t, waveTestConfig(t, 1, 0, math.Pi/2), "heel")
	minus := mustDisable(t, waveTestConfig(t, -1, 0, math.Pi/2), "heel")
	start := InitialState(0, 2)
	da := Evaluate(start, waveTestControls, testBoat, &plus)
	db := Evaluate(start, waveTestControls, testBoat, &minus)
	greater(t, "boardV", da.Waves.BoardV, 0)
	primary := plus.Waves.Components[0]
	closeTo(t, "boardV", da.Waves.BoardV, primary.Amplitude*primary.Omega*math.Exp(primary.K*testBoat.Board.Z), 10)
	greater(t, "foils.fy", da.Foils.Fy, 0)
	greater(t, "|foils.yawMoment|", math.Abs(da.Foils.YawMoment), 1e-3)
	closeTo(t, "mirrored fy", db.Foils.Fy, -da.Foils.Fy, 10)
	closeTo(t, "mirrored yawMoment", db.Foils.YawMoment, -da.Foils.YawMoment, 10)
	a := advanceWaves(start, &plus, 30)
	b := advanceWaves(start, &minus, 30)
	greater(t, "v", a.V, 0)
	greater(t, "|heading|", math.Abs(a.Heading), 1e-5)
	closeTo(t, "mirrored v", b.V, -a.V, 10)
	closeTo(t, "mirrored heading", b.Heading, -a.Heading, 10)
	closeTo(t, "mirrored x", b.X, -a.X, 10)
}

func TestDeeperBoardLosesOrbitalForcingOnly(t *testing.T) {
	cfg := mustDisable(t, waveTestConfig(t, 1, 0, math.Pi/2), "heel")
	start := InitialState(0, 2)
	shallow := Evaluate(start, waveTestControls, testBoat, &cfg)
	deeperBoat := *testBoat
	deeperBoat.Board.Z = testBoat.Board.Z - 1
	deep := Evaluate(start, waveTestControls, &deeperBoat, &cfg)
	closeTo(t, "boardV ratio", deep.Waves.BoardV/shallow.Waves.BoardV, math.Exp(-cfg.Waves.Components[0].K), 10)
	less(t, "|deep board fy|", math.Abs(deep.Foils.Board.Fy), math.Abs(shallow.Foils.Board.Fy))
	equal(t, "rudder", deep.Foils.Rudder, shallow.Foils.Rudder)
	equal(t, "rudderV", deep.Waves.RudderV, shallow.Waves.RudderV)
}

func TestHalfWavelengthSeparationReversesFoilLoad(t *testing.T) {
	cfg := mustDisable(t, waveTestConfig(t, 0, -1, math.Pi/2), "heel")
	// Oblique heading exposes both the fore/aft phase difference and lateral flow.
	c0 := cfg.Waves.Components[0]
	c0.Dx, c0.Dz = 1, 0
	cfg.Waves.Components = []WaveComponent{c0}
	start := InitialState(math.Pi/4, 2)
	base := Evaluate(start, waveTestControls, testBoat, &cfg)
	shiftedBoat := *testBoat
	shiftedBoat.Rudder.X = testBoat.Rudder.X + 6/math.Sin(start.Heading)
	shifted := Evaluate(start, waveTestControls, &shiftedBoat, &cfg)
	equal(t, "board", shifted.Foils.Board, base.Foils.Board)
	less(t, "rudderV product", base.Waves.RudderV*shifted.Waves.RudderV, 0)
	less(t, "rudder fy product", base.Foils.Rudder.Fy*shifted.Foils.Rudder.Fy, 0)
}

func TestHeelPitchGeometryAndDisabledLayers(t *testing.T) {
	cfg := waveTestConfig(t, 1, 0, 0)
	start := InitialState(0.3, 2)
	start.Heel, start.Pitch, start.PitchRate = 0.2, 0.15, 0.1
	tilted := Evaluate(start, waveTestControls, testBoat, &cfg)
	levelState := start
	levelState.Heel, levelState.Pitch, levelState.PitchRate = 0, 0, 0
	level := Evaluate(levelState, waveTestControls, testBoat, &cfg)
	greater(t, "boardV change", math.Abs(tilted.Waves.BoardV-level.Waves.BoardV), 1e-3)
	greater(t, "board fx change", math.Abs(tilted.Foils.Board.Fx-level.Foils.Board.Fx), 1e-3)
	snapshot := *tilted.Waves
	later := start
	later.T = 5
	Evaluate(later, waveTestControls, testBoat, &cfg)
	equal(t, "waves snapshot", *tilted.Waves, snapshot)
	disabled := mustDisable(t, cfg, "heel", "yaw", "foils")
	result := Step(start, waveTestControls, testBoat, &disabled)
	if result.Diagnostics.Foils != nil {
		t.Error("foils diagnostics not nil with the layer off")
	}
	equal(t, "rollMoment", result.Diagnostics.Waves.RollMoment, 0)
	equal(t, "heel", result.State.Heel, 0)
	equal(t, "pitch", result.State.Pitch, 0)
	equal(t, "r", result.State.R, 0)
	equal(t, "heading", result.State.Heading, start.Heading)
}
