package sim

import "math"

// One fixed simulation step: state + controls + dt -> new state. Deterministic.
// Forces from each layer are summed in the body frame and integrated with
// semi-implicit Euler over cfg.Substeps substeps (PHYSICS.md section 0). src/sim/step.ts.
//
// Goroutine safety: the TS module keeps scratch wave samples at module level. Here they are
// locals (stack), and the package holds no mutable state, so Step and Evaluate may run
// concurrently for different sessions sharing one *BoatModel and read-only config data.

// WaveDiagnostics is the wave forcing on the boat.
type WaveDiagnostics struct {
	FoilAmbientFlow
	Height      float64 `json:"height"`
	RollTarget  float64 `json:"rollTarget"`
	PitchTarget float64 `json:"pitchTarget"`
	RollMoment  float64 `json:"rollMoment"`
}

// HeelDiagnostics breaks down the heeling moments.
type HeelDiagnostics struct {
	AeroMoment     float64 `json:"aeroMoment"`
	HydroMoment    float64 `json:"hydroMoment"`
	RightingMoment float64 `json:"rightingMoment"`
	CrewY          float64 `json:"crewY"`
	CrewTargetY    float64 `json:"crewTargetY"`
	CrewZ          float64 `json:"crewZ"`
}

// YawDiagnostics breaks down the yaw moments.
type YawDiagnostics struct {
	Sail    float64 `json:"sail"`
	Foils   float64 `json:"foils"`
	Hull    float64 `json:"hull"`
	Munk    float64 `json:"munk"`
	Damping float64 `json:"damping"`
	// Seabed contact damping, N m (0 afloat or with cfg.land off).
	Ground float64 `json:"ground"`
	Total  float64 `json:"total"`
}

// TotalForces is the total body-frame force, N, and moments, N m.
type TotalForces struct {
	Fx   float64 `json:"fx"`
	Fy   float64 `json:"fy"`
	Yaw  float64 `json:"yaw"`
	Heel float64 `json:"heel"`
}

// Diagnostics mirrors TS Diagnostics. Nullable layers are nil when off.
type Diagnostics struct {
	TrueWind Vec2         `json:"trueWind"`
	Apparent ApparentWind `json:"apparent"`
	// nil when the layer is disabled.
	Sail  *SailResult  `json:"sail"`
	Foils *FoilsResult `json:"foils"`
	Hull  *HullResult  `json:"hull"`
	// nil on the exact flat-water path (disabled or zero amplitude).
	Waves *WaveDiagnostics `json:"waves"`
	// nil when the bay is off (cfg.Land).
	Ground *GroundResult   `json:"ground"`
	Heel   HeelDiagnostics `json:"heel"`
	Yaw    YawDiagnostics  `json:"yaw"`
	Total  TotalForces     `json:"total"`
	Speed  float64         `json:"speed"`
	// Leeway angle, rad (+ = sliding to starboard).
	Leeway float64 `json:"leeway"`
	// Velocity made good toward the wind, m/s.
	Vmg float64 `json:"vmg"`
	// Signed target boom angle the boom is swinging to, rad.
	BoomTarget float64  `json:"boomTarget"`
	BoomSide   int      `json:"boomSide"`
	Controls   Controls `json:"controls"`
}

// StepResult is the state after one fixed step and the diagnostics of its first substep.
type StepResult struct {
	State       BoatState   `json:"state"`
	Diagnostics Diagnostics `json:"diagnostics"`
}

// waveDiagnostics returns false on the exact flat-water path.
func waveDiagnostics(state *BoatState, boat *BoatModel, cfg *SimConfig, out *WaveDiagnostics) bool {
	if WaveAmplitude(&cfg.Waves) == 0 {
		return false
	}
	var surface, foilSample WaveSample
	SampleWaves(&cfg.Waves, state.X, state.Z, state.T, 0, &surface)
	height := surface.Y
	sh, ch := math.Sin(state.Heading), math.Cos(state.Heading)
	sp, cp := math.Sin(state.Pitch), math.Cos(state.Pitch)
	sr, cr := math.Sin(state.Heel), math.Cos(state.Heel)
	rollTarget := -math.Atan(surface.SlopeX*ch + surface.SlopeZ*sh)
	pitchTarget := math.Atan(surface.SlopeX*sh - surface.SlopeZ*ch)
	// Replace only hull-form restoring's gravity slope by the local surface slope.
	// Crew weight/height remains gravity-relative (Day 2017 Eq. 18).
	rollMoment := 0.0
	if cfg.Layers.Heel {
		rollMoment = boat.Mass * G * boat.Gm * (math.Sin(state.Heel) - math.Sin(state.Heel-rollTarget))
	}

	var ambient FoilAmbientFlow
	if cfg.Layers.Foils {
		for i := range 2 {
			foil := &boat.Board
			if i == 1 {
				foil = &boat.Rudder
			}
			// Rotation order matches the boat: yaw, bow-up pitch, starboard-down heel.
			forward := foil.X*cp - foil.Z*cr*sp
			starboard := foil.Z * sr
			up := foil.X*sp + foil.Z*cr*cp
			x := state.X + forward*sh + starboard*ch
			z := state.Z - forward*ch + starboard*sh
			SampleWaves(&cfg.Waves, x, z, state.T, 0, &foilSample)
			depth := min(0, height+up-foilSample.Y)
			SampleWaves(&cfg.Waves, x, z, state.T, depth, &foilSample)
			vf := foilSample.VelocityX*sh - foilSample.VelocityZ*ch
			vs := foilSample.VelocityX*ch + foilSample.VelocityZ*sh
			u := vf*cp + foilSample.VelocityY*sp
			v := vs*cr + vf*sr*sp - foilSample.VelocityY*sr*cp
			if i == 0 {
				ambient.BoardU = u
				ambient.BoardV = v
			} else {
				ambient.RudderU = u
				ambient.RudderV = v
			}
		}
	}
	*out = WaveDiagnostics{FoilAmbientFlow: ambient, Height: height, RollTarget: rollTarget, PitchTarget: pitchTarget, RollMoment: rollMoment}
	return true
}

// Evaluate evaluates every enabled layer at the current state.
func Evaluate(state BoatState, controls Controls, boat *BoatModel, cfg *SimConfig) Diagnostics {
	return evaluate(&state, &controls, boat, cfg, new(layerResults))
}

// layerResults holds the nullable layer outputs a Diagnostics points into, so one evaluation costs
// at most one allocation (none for the intermediate substeps of Step, whose storage stays on the
// stack).
type layerResults struct {
	sail   SailResult
	foils  FoilsResult
	hull   HullResult
	waves  WaveDiagnostics
	ground GroundResult
}

func evaluate(state *BoatState, controls *Controls, boat *BoatModel, cfg *SimConfig, out *layerResults) Diagnostics {
	L := &cfg.Layers
	var d Diagnostics
	d.TrueWind = GetWind(Vec2{X: state.X, Z: state.Z}, state.T, &cfg.Wind)
	d.Apparent = apparentWind(state, d.TrueWind, L.ApparentWind)
	crew := crewPosition(state, controls, boat, 0)
	if waveDiagnostics(state, boat, cfg, &out.waves) {
		d.Waves = &out.waves
	}

	var sailFx, sailFy, sailHeel, sailYaw float64
	if L.Sail {
		out.sail = sailForces(state, &d.Apparent, crew.Z, boat, &cfg.Env, &cfg.Terms)
		d.Sail = &out.sail
		sail := &out.sail
		sailFx, sailFy, sailHeel, sailYaw = sail.Fx, sail.Fy, sail.HeelMoment, sail.YawMoment
		// luffAmount does not depend on the crew, so the crew target is refined after the sail is
		// evaluated.
		if cfg.Terms.CrewCentresWhenLuffing {
			crew = crewPosition(state, controls, boat, sail.LuffAmount)
		}
	}
	var foilFx, foilFy, foilHeel, foilYaw float64
	if L.Foils {
		var ambient *FoilAmbientFlow
		if d.Waves != nil {
			ambient = &d.Waves.FoilAmbientFlow
		}
		out.foils = foilForces(state, controls, boat, &cfg.Env, &cfg.Terms, &cfg.Models, ambient)
		d.Foils = &out.foils
		foils := &out.foils
		foilFx, foilFy, foilHeel, foilYaw = foils.Fx, foils.Fy, foils.HeelMoment, foils.YawMoment
	}
	var hullFx, hullFy, hullHeel, hullYaw float64
	if L.Hull {
		out.hull = hullForces(state, boat, &cfg.Env, &cfg.Terms, &cfg.Models)
		d.Hull = &out.hull
		hull := &out.hull
		hullFx, hullFy, hullHeel, hullYaw = hull.Fx, hull.Fy, hull.HeelMoment, hull.YawMoment
	}
	var gx, gy, gYaw float64
	if cfg.Land {
		out.ground = groundForces(state, boat)
		d.Ground = &out.ground
		ground := &out.ground
		gx, gy, gYaw = ground.Fx, ground.Fy, ground.YawMoment
	}

	righting := 0.0
	if L.Heel {
		righting = rightingMoment(state.Heel, state.CrewY, crew.Z, boat)
	}
	heelTotal := sailHeel + foilHeel + hullHeel + righting
	if d.Waves != nil {
		heelTotal += d.Waves.RollMoment
	}

	munk := 0.0
	if L.Yaw && cfg.Terms.MunkMoment {
		munk = munkMoment(state, boat, &cfg.Env)
	}
	damping := -boat.Cfg.Dynamics.YawDamping * state.R
	yawTotal := sailYaw + foilYaw + hullYaw + munk + damping + gYaw

	// Boom kinematics run even with the sail layer off so the rig still moves.
	cosHeel := math.Cos(state.Heel)
	awaHeeled := math.Atan2(-d.Apparent.V*cosHeel, -d.Apparent.U)
	boom := boomKinematics(awaHeeled, state, controls.Sheet, boat)

	speed := jsHypot(state.U, state.V)
	vel := BodyToWorld(state.Heading, state.U, state.V)
	windFrom := BearingToWorld(cfg.Wind.FromDeg * DEG)

	d.Heel = HeelDiagnostics{
		AeroMoment:     sailHeel,
		HydroMoment:    foilHeel + hullHeel,
		RightingMoment: righting,
		CrewY:          state.CrewY,
		CrewTargetY:    crew.TargetY,
		CrewZ:          crew.Z,
	}
	d.Yaw = YawDiagnostics{Sail: sailYaw, Foils: foilYaw, Hull: hullYaw, Munk: munk, Damping: damping, Ground: gYaw, Total: yawTotal}
	d.Total = TotalForces{Fx: sailFx + foilFx + hullFx + gx, Fy: sailFy + foilFy + hullFy + gy, Yaw: yawTotal, Heel: heelTotal}
	d.Speed = speed
	if speed > 1e-3 {
		d.Leeway = math.Atan2(state.V, math.Abs(state.U))
	}
	d.Vmg = vel.X*windFrom.X + vel.Z*windFrom.Z
	d.BoomTarget = boom.Target
	d.BoomSide = boom.BoomSide
	d.Controls = *controls
	return d
}

func integrate(state *BoatState, d *Diagnostics, boat *BoatModel, cfg *SimConfig, h float64) BoatState {
	dyn := &boat.Cfg.Dynamics
	m := boat.Mass
	mu := m * (1 + dyn.SurgeAddedMassFrac)
	mv := m + dyn.SwayAddedMass
	fx, fy := d.Total.Fx, d.Total.Fy

	u := state.U + ((fx+m*state.V*state.R)/mu)*h
	v := state.V + ((fy-m*state.U*state.R)/mv)*h

	r := 0.0
	if cfg.Layers.Yaw {
		izz := boat.YawInertia * (1 + dyn.YawAddedInertiaFrac)
		r = state.R + (d.Total.Yaw/izz)*h
	}

	pitch := 0.0
	pitchRate := 0.0
	if cfg.Layers.Heel && d.Waves != nil {
		// TUNING GUESS: damped pitch response, parameters documented in waves.json.
		frequency := WaveParams.PitchFrequency
		pitchRate = state.PitchRate + (frequency*frequency*(d.Waves.PitchTarget-state.Pitch)-
			2*WaveParams.PitchDampingRatio*frequency*state.PitchRate)*h
		pitch = state.Pitch + pitchRate*h
		limit := WaveParams.PitchLimitDeg * DEG
		if math.Abs(pitch) > limit {
			pitch = jsSign(pitch) * limit
			if pitchRate*pitch > 0 {
				pitchRate = 0
			}
		}
	}

	heel := 0.0
	p := 0.0
	if cfg.Layers.Heel {
		p = state.P + ((d.Total.Heel-dyn.RollDamping*state.P)/boat.RollInertia)*h
		heel = state.Heel + p*h
		limit := dyn.HeelLimitDeg * DEG
		if math.Abs(heel) > limit {
			heel = jsSign(heel) * limit
			if p*heel > 0 {
				p = 0
			}
		}
	}

	heading := state.Heading + r*h
	vel := BodyToWorld(heading, u, v)

	boomSide := d.BoomSide
	boom := state.Boom + (d.BoomTarget-state.Boom)*(1-math.Exp(-h/boat.Cfg.Rig.BoomTimeConstant))

	maxMove := CrewCrossingSpeed * h
	crewY := state.CrewY + Clamp(d.Heel.CrewTargetY-state.CrewY, -maxMove, maxMove)

	return BoatState{
		T:         state.T + h,
		X:         state.X + vel.X*h,
		Z:         state.Z + vel.Z*h,
		Heading:   heading,
		U:         u,
		V:         v,
		R:         r,
		Heel:      heel,
		P:         p,
		Pitch:     pitch,
		PitchRate: pitchRate,
		Boom:      boom,
		BoomSide:  boomSide,
		CrewY:     crewY,
	}
}

// Step advances one fixed step of cfg.Dt with cfg.Substeps substeps. Controls are clamped to
// their ranges. As in TS, the returned diagnostics are those of the last substep's evaluation.
func Step(state BoatState, controls Controls, boat *BoatModel, cfg *SimConfig) StepResult {
	c := Controls{
		Tiller: Clamp(controls.Tiller, -1, 1),
		Sheet:  Clamp(controls.Sheet, 0, 1),
		Hike:   Clamp(controls.Hike, 0, 1),
	}
	h := cfg.Dt / float64(cfg.Substeps)
	s := state
	// Every substep evaluates then integrates; only the last evaluation is returned (TS reassigns
	// its diagnostics each substep), so the earlier ones use stack storage.
	var scratch layerResults
	for range cfg.Substeps - 1 {
		d := evaluate(&s, &c, boat, cfg, &scratch)
		s = integrate(&s, &d, boat, cfg, h)
	}
	diagnostics := evaluate(&s, &c, boat, cfg, new(layerResults))
	if cfg.Substeps > 0 {
		s = integrate(&s, &diagnostics, boat, cfg, h)
	}
	return StepResult{State: s, Diagnostics: diagnostics}
}
