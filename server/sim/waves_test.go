package sim

import (
	"math"
	"testing"
)

// Port of src/sim/waves.test.ts. The two wavePhaseAt tests ("preserves the physical surface after
// distant origins and long elapsed times enter float32", "does not jump the surface when the
// reduced phase wraps across minus pi") test the render-only shader upload helper, which is not
// part of the server port.

func enabledWaves() WaveConfig {
	cfg := DefaultWaves(WaveParams.Variation.Seed)
	cfg.Enabled = true
	return cfg
}

func sampleW(cfg *WaveConfig, x, z, t, depth float64) WaveSample {
	var out WaveSample
	SampleWaves(cfg, x, z, t, depth, &out)
	return out
}

func sampleP(cfg *WaveConfig, x, z, t, depth float64) WaveSample {
	var out WaveSample
	SampleWaveParticle(cfg, x, z, t, depth, &out)
	return out
}

func TestWavesFlatWhenDisabledOrZeroAmplitude(t *testing.T) {
	cfg := enabledWaves()
	off := cfg
	off.Enabled = false
	zero := cfg
	zero.AmplitudeScale = 0
	for _, flat := range []WaveConfig{off, zero} {
		equal(t, "sample", sampleW(&flat, 23, -17, 12, -0.4), WaveSample{X: 23, Y: 0, Z: -17})
	}
}

func TestWavesResolveDisplacedCoordinatesAndSurfaceGradient(t *testing.T) {
	cfg := enabledWaves()
	maxCfg := cfg
	maxCfg.AmplitudeScale = WaveParams.MaxAmplitudeScale
	SetWaveParameters(&maxCfg, WaveParams.MinPeriodSeconds, 90)
	const h = 1e-4
	for _, tt := range []float64{0, 0.7, 3, 20} {
		particle := sampleP(&maxCfg, 2, -3, tt, 0)
		surface := sampleW(&maxCfg, particle.X, particle.Z, tt, 0)
		closeTo(t, "x", surface.X, particle.X, 8)
		closeTo(t, "z", surface.Z, particle.Z, 8)
		closeTo(t, "y", surface.Y, particle.Y, 8)
		px := sampleW(&maxCfg, particle.X+h, particle.Z, tt, 0)
		nx := sampleW(&maxCfg, particle.X-h, particle.Z, tt, 0)
		pz := sampleW(&maxCfg, particle.X, particle.Z+h, tt, 0)
		nz := sampleW(&maxCfg, particle.X, particle.Z-h, tt, 0)
		closeTo(t, "slopeX", surface.SlopeX, (px.Y-nx.Y)/(2*h), 7)
		closeTo(t, "slopeZ", surface.SlopeZ, (pz.Y-nz.Y)/(2*h), 7)
	}
}

func TestOrbitalVelocityIsTimeDerivative(t *testing.T) {
	cfg := enabledWaves()
	const h = 1e-5
	for _, depth := range []float64{0, -0.3, -2} {
		s := sampleP(&cfg, 1, 2, 0.7, depth)
		before := sampleP(&cfg, 1, 2, 0.7-h, depth)
		after := sampleP(&cfg, 1, 2, 0.7+h, depth)
		closeTo(t, "vx", s.VelocityX, (after.X-before.X)/(2*h), 8)
		closeTo(t, "vy", s.VelocityY, (after.Y-before.Y)/(2*h), 8)
		closeTo(t, "vz", s.VelocityZ, (after.Z-before.Z)/(2*h), 8)
	}
}

func TestSingleWaveOrbitsDecayWithDepth(t *testing.T) {
	cfg := enabledWaves()
	single := cfg
	single.Components = cfg.Components[:1]
	surface := sampleP(&single, 0, 0, 0.5, 0)
	deep := sampleP(&single, 0, 0, 0.5, -1)
	factor := math.Exp(-single.Components[0].K)
	closeTo(t, "vx", deep.VelocityX, surface.VelocityX*factor, 12)
	closeTo(t, "vy", deep.VelocityY, surface.VelocityY*factor, 12)
	closeTo(t, "y", deep.Y, surface.Y*factor, 12)
}

func TestWavesCapAmplitudeBeforeOverturning(t *testing.T) {
	cfg := enabledWaves()
	shortest := cfg
	shortest.AmplitudeScale = 100
	SetWaveParameters(&shortest, WaveParams.MinPeriodSeconds, 90)
	scale := WaveAmplitude(&shortest)
	equal(t, "scale", scale, WaveParams.MaxAmplitudeScale)
	steepness := 0.0
	for _, w := range shortest.Components {
		steepness += w.K * w.Amplitude * w.Choppiness * scale
	}
	less(t, "steepness", steepness, 1)
	negative := cfg
	negative.AmplitudeScale = -1
	equal(t, "negative amplitude", WaveAmplitude(&negative), 0)
}

func TestPeriodControlsObeyDispersionAndDirectionIsTo(t *testing.T) {
	cfg := enabledWaves()
	tuned := cfg
	SetWaveParameters(&tuned, 4, 180)
	primary := tuned.Components[0]
	closeTo(t, "period", 2*math.Pi/primary.Omega, 4, 12)
	closeTo(t, "dispersion", math.Pow(primary.Omega, 2)/primary.K, 9.81, 12)
	closeTo(t, "dx", primary.Dx, 0, 12)
	closeTo(t, "dz", primary.Dz, 1, 12)
	equal(t, "amplitude", primary.Amplitude, cfg.Components[0].Amplitude)
	SetWaveParameters(&tuned, 100, -90)
	equal(t, "period clamp", tuned.PeriodSeconds, WaveParams.MaxPeriodSeconds)
	equal(t, "direction", tuned.DirectionDeg, 270)
}

func TestSeededRipplesSurviveControlChangesAndRotate(t *testing.T) {
	ripples := DefaultWaves(7123)
	ripples.Enabled = true
	SetWaveLayers(&ripples, 0, 1)
	SetWaveParameters(&ripples, 4, 0)
	before := sampleP(&ripples, 2.3, -1.7, 0.8, 0)
	SetWaveParameters(&ripples, 8, 0) // broad period must not change ripple spacing or phase
	equal(t, "after period change", sampleP(&ripples, 2.3, -1.7, 0.8, 0), before)
	SetWaveWind(&ripples, 16)
	SetWaveLayers(&ripples, 2, 0)
	SetWaveWind(&ripples, 7)
	SetWaveLayers(&ripples, 0, 1)
	equal(t, "after wind and layer round trip", sampleP(&ripples, 2.3, -1.7, 0.8, 0), before)

	angle := 37 * math.Pi / 180
	c, s := math.Cos(angle), math.Sin(angle)
	SetWaveParameters(&ripples, 8, 37)
	rotated := sampleP(&ripples, c*2.3-s*-1.7, s*2.3+c*-1.7, 0.8, 0)
	closeTo(t, "y", rotated.Y, before.Y, 12)
	closeTo(t, "slopeX", rotated.SlopeX, c*before.SlopeX-s*before.SlopeZ, 12)
	closeTo(t, "slopeZ", rotated.SlopeZ, s*before.SlopeX+c*before.SlopeZ, 12)
	closeTo(t, "velocityX", rotated.VelocityX, c*before.VelocityX-s*before.VelocityZ, 12)
	closeTo(t, "velocityZ", rotated.VelocityZ, s*before.VelocityX+c*before.VelocityZ, 12)
}
