package sim

// BuoyTourParameters is buoyTour in data/challenges.json. The reward is the client's business: the
// server only verifies and stores completion.
type BuoyTourParameters struct {
	ID          string  `json:"id"`
	Title       string  `json:"title"`
	Description string  `json:"description"`
	Radius      float64 `json:"radius"`
}

// ChallengeParameters is data/challenges.json.
type ChallengeParameters struct {
	BuoyTour BuoyTourParameters `json:"buoyTour"`
}

// ChallengeParams is data/challenges.json. Read-only.
var ChallengeParams = load[ChallengeParameters]("challenges.json")

// Buoy is one named buoy of data/buoys.json (world x east, z south, m).
type Buoy struct {
	Name string  `json:"name"`
	X    float64 `json:"x"`
	Z    float64 `json:"z"`
}

// BuoyParameters is data/buoys.json.
type BuoyParameters struct {
	Buoys []Buoy `json:"buoys"`
}

// BuoyData is data/buoys.json. Read-only.
var BuoyData = load[BuoyParameters]("buoys.json")
