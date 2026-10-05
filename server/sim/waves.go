package sim

import "math"

// Shared CPU/shader Gerstner model (src/sim/waves.ts; the GLSL generator and wavePhaseAt are
// render-only and not ported). GPU Gems ch. 1 §1.2.3 Eq. 9, with y up,
// k = 2 pi / wavelength and omega = sqrt(g k) (Eq. 13). Direction is TO.
// Phase = k dot(direction, label) - omega t + phase0.
// Particle displacement = (Q A D cos(phase), A sin(phase)); its time derivative
// supplies orbital velocity, attenuated by exp(k depth) below the surface.
// Multiple components and the boat response are approximations, not a sea-state VPP.

// WaveComponent is one compiled Gerstner wave.
type WaveComponent struct {
	Dx         float64 `json:"dx"`
	Dz         float64 `json:"dz"`
	K          float64 `json:"k"`
	Omega      float64 `json:"omega"`
	Amplitude  float64 `json:"amplitude"`
	Phase      float64 `json:"phase"`
	Choppiness float64 `json:"choppiness"`
}

// WaveConfig is the sea state (TS WaveConfig).
type WaveConfig struct {
	Enabled        bool    `json:"enabled"`
	AmplitudeScale float64 `json:"amplitudeScale"`
	BigScale       float64 `json:"bigScale"`
	RippleScale    float64 `json:"rippleScale"`
	// Fixed seed for strengths/phases; wind and sea controls never re-roll it.
	Seed uint32 `json:"seed"`
	// Wind driving the compiled sea, updated alongside the true wind by its owner.
	WindSpeedKn float64 `json:"windSpeedKn"`
	// Cached safe overall amplitude multiplier for the compiled components.
	AmplitudeLimit float64 `json:"amplitudeLimit"`
	// Primary broad-wave period at reference wind, seconds.
	PeriodSeconds float64 `json:"periodSeconds"`
	// Primary wave propagation TO compass bearing, degrees.
	DirectionDeg float64 `json:"directionDeg"`
	// Compiled components. Recompiling allocates a new slice, so copies of a WaveConfig may share
	// it; never mutate its elements in place.
	Components []WaveComponent `json:"components"`
}

type waveSpec struct {
	Wavelength         float64 `json:"wavelength"`
	Amplitude          float64 `json:"amplitude"`
	DirectionOffsetDeg float64 `json:"directionOffsetDeg"`
	Phase              float64 `json:"phase"`
	Choppiness         float64 `json:"choppiness"`
}

// WaveParameters mirrors data/waves.json (TS WAVE_PARAMETERS); only the fields the sim reads.
type WaveParameters struct {
	AmplitudeScale    float64 `json:"amplitudeScale"`
	MaxAmplitudeScale float64 `json:"maxAmplitudeScale"`
	MinPeriodSeconds  float64 `json:"minPeriodSeconds"`
	MaxPeriodSeconds  float64 `json:"maxPeriodSeconds"`
	MaxLayerScale     float64 `json:"maxLayerScale"`
	MaxSteepness      float64 `json:"maxSteepness"`
	DirectionDeg      float64 `json:"directionDeg"`
	Variation         struct {
		Seed                     uint32  `json:"seed"`
		AmplitudeSpread          float64 `json:"amplitudeSpread"`
		RippleLengthSpread       float64 `json:"rippleLengthSpread"`
		RippleDirectionSpreadDeg float64 `json:"rippleDirectionSpreadDeg"`
	} `json:"variation"`
	Wind struct {
		ReferenceSpeedKn     float64 `json:"referenceSpeedKn"`
		MinSpeedKn           float64 `json:"minSpeedKn"`
		MaxSpeedKn           float64 `json:"maxSpeedKn"`
		MinLengthRatio       float64 `json:"minLengthRatio"`
		BigHeightExponent    float64 `json:"bigHeightExponent"`
		BigPeriodExponent    float64 `json:"bigPeriodExponent"`
		RippleHeightExponent float64 `json:"rippleHeightExponent"`
		RippleLengthExponent float64 `json:"rippleLengthExponent"`
	} `json:"wind"`
	PitchFrequency    float64    `json:"pitchFrequency"`
	PitchDampingRatio float64    `json:"pitchDampingRatio"`
	PitchLimitDeg     float64    `json:"pitchLimitDeg"`
	BigWaves          []waveSpec `json:"bigWaves"`
	Ripples           []waveSpec `json:"ripples"`
}

// WaveParams is data/waves.json. Read-only.
var WaveParams = load[WaveParameters]("waves.json")

// baseComponents are the uncompiled components from data/waves.json. Read-only.
var baseComponents = func() []WaveComponent {
	all := append(append([]waveSpec(nil), WaveParams.BigWaves...), WaveParams.Ripples...)
	out := make([]WaveComponent, len(all))
	for i, w := range all {
		k := 2 * math.Pi / w.Wavelength
		out[i] = WaveComponent{
			Dx: math.Sin(w.DirectionOffsetDeg * DEG), Dz: -math.Cos(w.DirectionOffsetDeg * DEG),
			K: k, Omega: math.Sqrt(G * k), Amplitude: w.Amplitude, Phase: w.Phase, Choppiness: w.Choppiness,
		}
	}
	return out
}()

// DefaultWaves is TS defaultWaves(seed). Headless/flat-water callers retain their existing
// behavior (disabled); the browser config enables waves. The TS default seed is
// WaveParams.Variation.Seed.
func DefaultWaves(seed uint32) WaveConfig {
	cfg := WaveConfig{
		Enabled: false, AmplitudeScale: WaveParams.AmplitudeScale,
		BigScale: 1, RippleScale: 1, WindSpeedKn: WaveParams.Wind.ReferenceSpeedKn,
		Seed:           seed,
		AmplitudeLimit: WaveParams.MaxAmplitudeScale,
		PeriodSeconds:  2 * math.Pi / baseComponents[0].Omega,
		DirectionDeg:   WaveParams.DirectionDeg, Components: baseComponents,
	}
	compileWaves(&cfg)
	return cfg
}

// randomUnit is stateless 32-bit mixing: deterministic variation without per-sample randomness.
// Reproduces the TS Math.imul / `>>>` / `| 0` arithmetic exactly in uint32.
func randomUnit(seed uint32, index int) float64 {
	value := seed + uint32(index+1)*0x9e3779b9
	value = (value ^ (value >> 16)) * 0x21f0aaad
	value = (value ^ (value >> 15)) * 0x735a2d97
	return float64(value^(value>>15)) / 0x100000000
}

// compileWaves recompiles only when wind or sea controls change, never per frame/sample.
func compileWaves(cfg *WaveConfig) {
	p := &WaveParams
	ratio := cfg.WindSpeedKn / p.Wind.ReferenceSpeedKn
	lengthRatio := max(p.Wind.MinLengthRatio, ratio)
	periodRatio := cfg.PeriodSeconds * baseComponents[0].Omega / (2 * math.Pi) *
		math.Pow(lengthRatio, p.Wind.BigPeriodExponent)
	rippleLength := math.Pow(lengthRatio, p.Wind.RippleLengthExponent)
	bigHeight := math.Pow(ratio, p.Wind.BigHeightExponent) * cfg.BigScale
	rippleHeight := math.Pow(ratio, p.Wind.RippleHeightExponent) * cfg.RippleScale
	turn := cfg.DirectionDeg * DEG
	c, s := math.Cos(turn), math.Sin(turn)
	steepness := 0.0
	height := 0.0
	n := len(baseComponents)
	out := make([]WaveComponent, n)
	for i, w := range baseComponents {
		big := i < len(p.BigWaves)
		// TUNING GUESS (waves.json variation): jitter ripple spacing/direction at compilation only.
		// Extra random indices are disjoint from strength/phase, preserving the broad-wave spectrum.
		extra := 2 * (n + i)
		lengthVariation, angleVariation := 1.0, 0.0
		if !big {
			lengthVariation = 1 + p.Variation.RippleLengthSpread*(2*randomUnit(cfg.Seed, extra)-1)
			angleVariation = p.Variation.RippleDirectionSpreadDeg * DEG * (2*randomUnit(cfg.Seed, extra+1) - 1)
		}
		direction := turn + angleVariation
		dc, ds := c, s
		length := periodRatio * periodRatio
		if !big {
			dc, ds = math.Cos(direction), math.Sin(direction)
			length = rippleLength
		}
		length *= lengthVariation
		k := w.K / length
		strength := 1 + p.Variation.AmplitudeSpread*(2*randomUnit(cfg.Seed, i*2)-1)
		layerHeight := rippleHeight
		if big {
			layerHeight = bigHeight
		}
		amplitude := w.Amplitude * layerHeight * strength
		phase := w.Phase + 2*math.Pi*randomUnit(cfg.Seed, i*2+1)
		steepness += k * amplitude * w.Choppiness
		height += amplitude
		out[i] = WaveComponent{
			Dx: w.Dx*dc - w.Dz*ds, Dz: w.Dx*ds + w.Dz*dc,
			K: k, Omega: math.Sqrt(G * k), Amplitude: amplitude, Phase: phase, Choppiness: w.Choppiness,
		}
	}
	cfg.Components = out
	if height == 0 {
		cfg.AmplitudeLimit = 0
	} else {
		cfg.AmplitudeLimit = min(p.MaxAmplitudeScale, p.MaxSteepness/steepness)
	}
}

// SetWaveParameters sets the primary period (clamped) and propagation direction, then recompiles.
func SetWaveParameters(cfg *WaveConfig, periodSeconds, directionDeg float64) {
	cfg.PeriodSeconds = Clamp(periodSeconds, WaveParams.MinPeriodSeconds, WaveParams.MaxPeriodSeconds)
	cfg.DirectionDeg = math.Mod(math.Mod(directionDeg, 360)+360, 360)
	compileWaves(cfg)
}

// SetWaveWind sets the wind driving the sea and recompiles when it changed.
func SetWaveWind(cfg *WaveConfig, speedKn float64) {
	speed := max(0, speedKn)
	if cfg.WindSpeedKn == speed {
		return
	}
	cfg.WindSpeedKn = speed
	compileWaves(cfg)
}

// SetWaveLayers sets the broad-wave and ripple multipliers (clamped) and recompiles.
func SetWaveLayers(cfg *WaveConfig, bigScale, rippleScale float64) {
	cfg.BigScale = Clamp(bigScale, 0, WaveParams.MaxLayerScale)
	cfg.RippleScale = Clamp(rippleScale, 0, WaveParams.MaxLayerScale)
	compileWaves(cfg)
}

// WaveAmplitude is the effective overall amplitude multiplier (0 when disabled).
func WaveAmplitude(cfg *WaveConfig) float64 {
	if !cfg.Enabled {
		return 0
	}
	return Clamp(cfg.AmplitudeScale, 0, cfg.AmplitudeLimit)
}

// WaveSample is one sample of the wave field.
type WaveSample struct {
	// Displaced world position; y is elevation, not depth.
	X float64 `json:"x"`
	Y float64 `json:"y"`
	Z float64 `json:"z"`
	// Eulerian surface gradients dy/dx, dy/dz.
	SlopeX float64 `json:"slopeX"`
	SlopeZ float64 `json:"slopeZ"`
	// Particle orbital velocity, world axes, m/s.
	VelocityX float64 `json:"velocityX"`
	VelocityY float64 `json:"velocityY"`
	VelocityZ float64 `json:"velocityZ"`
}

// SampleWaveParticle samples a particle label, matching the shader. depth <= 0 is below the local
// surface.
func SampleWaveParticle(cfg *WaveConfig, x, z, t, depth float64, out *WaveSample) {
	scale := WaveAmplitude(cfg)
	px, py, pz := x, 0.0, z
	jxx, jxz, jzz, hx, hz := 1.0, 0.0, 1.0, 0.0, 0.0
	vx, vy, vz := 0.0, 0.0, 0.0
	if scale != 0 {
		for i := range cfg.Components {
			w := &cfg.Components[i]
			a := scale * w.Amplitude * math.Exp(w.K*min(depth, 0))
			phase := w.K*(w.Dx*x+w.Dz*z) - w.Omega*t + w.Phase
			s, c := math.Sin(phase), math.Cos(phase)
			qa := w.Choppiness * a
			px += qa * w.Dx * c
			py += a * s
			pz += qa * w.Dz * c
			horizontalDerivative := -qa * w.K * s
			jxx += horizontalDerivative * w.Dx * w.Dx
			jxz += horizontalDerivative * w.Dx * w.Dz
			jzz += horizontalDerivative * w.Dz * w.Dz
			hx += a * w.K * w.Dx * c
			hz += a * w.K * w.Dz * c
			vx += qa * w.Omega * w.Dx * s
			vy -= a * w.Omega * c
			vz += qa * w.Omega * w.Dz * s
		}
	}
	determinant := jxx*jzz - jxz*jxz
	out.X, out.Y, out.Z = px, py, pz
	out.SlopeX = (hx*jzz - hz*jxz) / determinant
	out.SlopeZ = (hz*jxx - hx*jxz) / determinant
	out.VelocityX, out.VelocityY, out.VelocityZ = vx, vy, vz
}

// SampleWaves is the Eulerian lookup: invert horizontal Gerstner displacement before sampling at
// a boat/foil's world position. Fixed-point iteration is contractive for the supplied waves
// (effective sum Q k A <= 0.6 over sea controls). No per-sample allocation.
func SampleWaves(cfg *WaveConfig, x, z, t, depth float64, out *WaveSample) {
	qx, qz := x, z
	scale := WaveAmplitude(cfg)
	if scale != 0 {
		// Covers the shortest allowed period at maximum amplitude; exits early for light chop.
		for range 48 {
			// Inversion only needs horizontal displacement, not normals or velocity.
			ex, ez := qx-x, qz-z
			for i := range cfg.Components {
				w := &cfg.Components[i]
				qa := scale * w.Amplitude * w.Choppiness * math.Exp(w.K*min(depth, 0))
				c := math.Cos(w.K*(w.Dx*qx+w.Dz*qz) - w.Omega*t + w.Phase)
				ex += qa * w.Dx * c
				ez += qa * w.Dz * c
			}
			qx -= ex
			qz -= ez
			if math.Abs(ex)+math.Abs(ez) < 1e-10 {
				break
			}
		}
	}
	SampleWaveParticle(cfg, qx, qz, t, depth, out)
}
