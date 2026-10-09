package sim

// Buoy is one named buoy of data/buoys.json (world x east, z south, m).
type Buoy struct {
	Name string  `json:"name"`
	X    float64 `json:"x"`
	Z    float64 `json:"z"`
}

// BuoyParameters is data/buoys.json.
type BuoyParameters struct {
	Buoys []Buoy `json:"buoys"`
	// ProximityRadius is how close a boat must come to a buoy to be near it, m.
	ProximityRadius float64 `json:"proximityRadius"`
}

// BuoyData is data/buoys.json. Read-only.
var BuoyData = load[BuoyParameters]("buoys.json")
