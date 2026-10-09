package sim

// BuoyTourParameters is buoyTour in data/challenges.json. The reward is the client's business: the
// server only verifies and stores completion. A buoy counts when the boat is near it
// (BuoyData.ProximityRadius).
type BuoyTourParameters struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description"`
}

// ChallengeParameters is data/challenges.json.
type ChallengeParameters struct {
	BuoyTour BuoyTourParameters `json:"buoyTour"`
}

// ChallengeParams is data/challenges.json. Read-only.
var ChallengeParams = load[ChallengeParameters]("challenges.json")
