package sim

import "math"

// The bay (src/sim/terrain.ts): one analytic, seeded elevation function shared by physics
// (grounding), the chart and the land mesh. Elevation is metres above mean sea level; negative
// values are water depth. Layout and every constant live in data/bay.json. The baked render grid
// (terrainGrid) is render-only and not ported.

// BayParameters mirrors data/bay.json (TS BAY); only the fields the sim reads.
type BayParameters struct {
	Seed     uint32 `json:"seed"`
	Mainland struct {
		Coast      [][2]float64 `json:"coast"`
		HillHeight float64      `json:"hillHeight"`
		HillRise   float64      `json:"hillRise"`
	} `json:"mainland"`
	Islands []struct {
		Name        string  `json:"name"`
		X           float64 `json:"x"`
		Z           float64 `json:"z"`
		Rx          float64 `json:"rx"`
		Rz          float64 `json:"rz"`
		RotationDeg float64 `json:"rotationDeg"`
		HillHeight  float64 `json:"hillHeight"`
		HillRise    float64 `json:"hillRise"`
	} `json:"islands"`
	Shoals []struct {
		Name     string  `json:"name"`
		X        float64 `json:"x"`
		Z        float64 `json:"z"`
		Radius   float64 `json:"radius"`
		TopDepth float64 `json:"topDepth"`
	} `json:"shoals"`
	CoastNoise struct {
		Amplitude  float64 `json:"amplitude"`
		Wavelength float64 `json:"wavelength"`
		Octaves    int     `json:"octaves"`
	} `json:"coastNoise"`
	ReliefNoise struct {
		Amplitude  float64 `json:"amplitude"`
		Wavelength float64 `json:"wavelength"`
		Octaves    int     `json:"octaves"`
	} `json:"reliefNoise"`
	Beach struct {
		Width  float64 `json:"width"`
		Height float64 `json:"height"`
	} `json:"beach"`
	Seabed struct {
		MaxDepth          float64 `json:"maxDepth"`
		NearshoreSlopeMin float64 `json:"nearshoreSlopeMin"`
		NearshoreSlopeMax float64 `json:"nearshoreSlopeMax"`
		SlopeWavelength   float64 `json:"slopeWavelength"`
	} `json:"seabed"`
	Landmarks []struct {
		Name   string  `json:"name"`
		Kind   string  `json:"kind"`
		X      float64 `json:"x"`
		Z      float64 `json:"z"`
		Height float64 `json:"height"`
		Color  string  `json:"color"`
		Band   string  `json:"band"`
	} `json:"landmarks"`
	Harbour struct {
		Departure struct {
			X          float64 `json:"x"`
			Z          float64 `json:"z"`
			HeadingDeg float64 `json:"headingDeg"`
		} `json:"departure"`
		Reclaimed []HarbourRect `json:"reclaimed"`
		Dredged   []HarbourRect `json:"dredged"`
	} `json:"harbour"`
	Grounding struct {
		PushStiffness  float64 `json:"pushStiffness"`
		Damping        float64 `json:"damping"`
		YawDamping     float64 `json:"yawDamping"`
		MaxPenetration float64 `json:"maxPenetration"`
		GradientStep   float64 `json:"gradientStep"`
	} `json:"grounding"`
}

// HarbourRect is one rectangle of Westcove Harbour (TS HarbourRect). Height is the flat level of a
// reclaimed rectangle, Depth the least depth of a dredged one; Edge is the blend width outside it, m.
type HarbourRect struct {
	X0     float64 `json:"x0"`
	Z0     float64 `json:"z0"`
	X1     float64 `json:"x1"`
	Z1     float64 `json:"z1"`
	Edge   float64 `json:"edge"`
	Height float64 `json:"height"`
	Depth  float64 `json:"depth"`
}

// Bay is data/bay.json. Read-only.
var Bay = load[BayParameters]("bay.json")

// Landmark is a named structure on the shore (TS Landmark).
type Landmark struct {
	Name string  `json:"name"`
	Kind string  `json:"kind"`
	X    float64 `json:"x"`
	Z    float64 `json:"z"`
	// Structure height above its foot, m.
	Height float64 `json:"height"`
	Color  string  `json:"color"`
	Band   string  `json:"band"`
	// Ground elevation at the foot, m.
	Base float64 `json:"base"`
}

// Landmarks is TS LANDMARKS. Read-only.
var Landmarks = func() []Landmark {
	out := make([]Landmark, len(Bay.Landmarks))
	for i, l := range Bay.Landmarks {
		out[i] = Landmark{
			Name: l.Name, Kind: l.Kind, X: l.X, Z: l.Z, Height: l.Height, Color: l.Color, Band: l.Band,
			Base: max(0, TerrainHeight(l.X, l.Z)),
		}
	}
	return out
}()

type island struct {
	x, z, rx, rz, cos, sin, hillHeight, hillRise float64
}

var coast = func() []Vec2 {
	out := make([]Vec2, len(Bay.Mainland.Coast))
	for i, p := range Bay.Mainland.Coast {
		out[i] = Vec2{X: p[0], Z: p[1]}
	}
	return out
}()

var islands = func() []island {
	out := make([]island, len(Bay.Islands))
	for i, is := range Bay.Islands {
		out[i] = island{
			x: is.X, z: is.Z, rx: is.Rx, rz: is.Rz,
			cos: math.Cos(is.RotationDeg * DEG), sin: math.Sin(is.RotationDeg * DEG),
			hillHeight: is.HillHeight, hillRise: is.HillRise,
		}
	}
	return out
}()

// --- Seeded value noise ---------------------------------------------------------------------

// terrainHash: TS Math.imul / `>>>` on int32, reproduced bit for bit in uint32. [0, 1].
func terrainHash(ix, iz float64, seed uint32) float64 {
	h := toUint32(ix)*0x27d4eb2d ^ toUint32(iz)*0x165667b1 ^ seed*0x9e3779b1
	h = (h ^ (h >> 15)) * 0x85ebca6b
	h = (h ^ (h >> 13)) * 0xc2b2ae35
	return float64(h^(h>>16)) / 0xffffffff
}

// terrainValueNoise is smooth value noise in [-1, 1].
func terrainValueNoise(x, z float64, seed uint32) float64 {
	ix, iz := math.Floor(x), math.Floor(z)
	fx, fz := x-ix, z-iz
	sx, sz := fx*fx*(3-2*fx), fz*fz*(3-2*fz)
	a, b := terrainHash(ix, iz, seed), terrainHash(ix+1, iz, seed)
	c, d := terrainHash(ix, iz+1, seed), terrainHash(ix+1, iz+1, seed)
	return 2*((a+(b-a)*sx)+((c+(d-c)*sx)-(a+(b-a)*sx))*sz) - 1
}

// Fbm is a fractal sum of octaves, normalised to [-1, 1].
func Fbm(x, z float64, octaves int, seed uint32) float64 {
	sum, amplitude, total, frequency := 0.0, 1.0, 0.0, 1.0
	for i := range octaves {
		sum += amplitude * terrainValueNoise(x*frequency, z*frequency, seed+uint32(i*101))
		total += amplitude
		amplitude *= 0.5
		frequency *= 2.03
	}
	return sum / total
}

// --- Shapes -----------------------------------------------------------------------------------

// mainlandDistance is the signed distance to the mainland polygon, positive on land.
func mainlandDistance(x, z float64) float64 {
	best := math.Inf(1)
	inside := false
	for i, j := 0, len(coast)-1; i < len(coast); j, i = i, i+1 {
		a, b := coast[j], coast[i]
		ex, ez := b.X-a.X, b.Z-a.Z
		wx, wz := x-a.X, z-a.Z
		t := max(0, min(1, (wx*ex+wz*ez)/(ex*ex+ez*ez)))
		dx, dz := wx-ex*t, wz-ez*t
		best = min(best, dx*dx+dz*dz)
		if (a.Z > z) != (b.Z > z) && x < a.X+(ex*(z-a.Z))/ez {
			inside = !inside
		}
	}
	d := math.Sqrt(best)
	if inside {
		return d
	}
	return -d
}

// islandDistance is the approximate signed distance to a rotated ellipse, positive inside (exact
// on the axes).
func islandDistance(is *island, x, z float64) float64 {
	dx, dz := x-is.x, z-is.z
	u := dx*is.cos + dz*is.sin
	v := -dx*is.sin + dz*is.cos
	k := jsHypot(u/is.rx, v/is.rz)
	if k == 0 {
		return min(is.rx, is.rz)
	}
	// Distance along the ray through the centre, scaled by the local radius.
	return (1 - k) * jsHypot(u, v) / k
}

// profile is the elevation of one land shape from its noise-perturbed signed distance d
// (positive on land).
func profile(d, hillHeight, hillRise, x, z float64) float64 {
	beach, seabed, reliefNoise := &Bay.Beach, &Bay.Seabed, &Bay.ReliefNoise
	if d <= 0 {
		n := 0.5 + 0.5*Fbm(x/seabed.SlopeWavelength, z/seabed.SlopeWavelength, 2, Bay.Seed+31)
		slope := seabed.NearshoreSlopeMin + (seabed.NearshoreSlopeMax-seabed.NearshoreSlopeMin)*n
		return -seabed.MaxDepth * (1 - math.Exp((d*slope)/seabed.MaxDepth))
	}
	beachPart := beach.Height * min(d/beach.Width, 1)
	relief := 1 + reliefNoise.Amplitude*Fbm(x/reliefNoise.Wavelength, z/reliefNoise.Wavelength, reliefNoise.Octaves, Bay.Seed+17)
	hills := hillHeight * relief * (1 - math.Exp(-max(0, d-beach.Width)/hillRise))
	return beachPart + hills
}

// rectWeight is 1 inside the rectangle, easing (smoothstep) to 0 over Edge metres outside it.
func rectWeight(r *HarbourRect, x, z float64) float64 {
	dx, dz := max(r.X0-x, 0, x-r.X1), max(r.Z0-z, 0, z-r.Z1)
	t := min(math.Sqrt(dx*dx+dz*dz)/r.Edge, 1)
	return 1 - t*t*(3-2*t)
}

// harbourHeight is Westcove Harbour (data/bay.json harbour): the basin is deepened, then the quay,
// mole and terrace are raised or cut to their flat height.
func harbourHeight(h, x, z float64) float64 {
	for i := range Bay.Harbour.Dredged {
		d := &Bay.Harbour.Dredged[i]
		h += (min(h, -d.Depth) - h) * rectWeight(d, x, z)
	}
	for i := range Bay.Harbour.Reclaimed {
		r := &Bay.Harbour.Reclaimed[i]
		h += (r.Height - h) * rectWeight(r, x, z)
	}
	return h
}

// TerrainHeight is the elevation above mean sea level, m (negative = depth). Deterministic; cheap
// enough per physics substep.
func TerrainHeight(x, z float64) float64 {
	c := &Bay.CoastNoise
	wobble := c.Amplitude * Fbm(x/c.Wavelength, z/c.Wavelength, c.Octaves, Bay.Seed)
	h := profile(mainlandDistance(x, z)+wobble, Bay.Mainland.HillHeight, Bay.Mainland.HillRise, x, z)
	for i := range islands {
		is := &islands[i]
		// Islands are smaller, so their coast wobbles proportionally less.
		scale := min(1, min(is.rx, is.rz)/c.Wavelength)
		d := islandDistance(is, x, z) + wobble*scale
		h = max(h, profile(d, is.hillHeight, is.hillRise, x, z))
	}
	maxDepth := Bay.Seabed.MaxDepth
	for _, s := range Bay.Shoals {
		r2 := (math.Pow(x-s.X, 2) + math.Pow(z-s.Z, 2)) / (s.Radius * s.Radius)
		h = max(h, -maxDepth+(maxDepth-s.TopDepth)*math.Exp(-r2))
	}
	return harbourHeight(h, x, z)
}

// TerrainGradient is the horizontal gradient of the elevation (finite difference), per metre,
// with the data/bay.json grounding.gradientStep (the TS default step).
func TerrainGradient(x, z float64) Vec2 {
	return TerrainGradientStep(x, z, Bay.Grounding.GradientStep)
}

// TerrainGradientStep is TerrainGradient with an explicit finite-difference step, m.
func TerrainGradientStep(x, z, step float64) Vec2 {
	return Vec2{
		X: (TerrainHeight(x+step, z) - TerrainHeight(x-step, z)) / (2 * step),
		Z: (TerrainHeight(x, z+step) - TerrainHeight(x, z-step)) / (2 * step),
	}
}
