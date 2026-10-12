package sim

import "fmt"

// KindVisitBuoys is the challenge kind whose steps are buoys of data/buoys.json, each reached once
// the boat is near it (BuoyData.ProximityRadius), in any order.
const KindVisitBuoys = "visitBuoys"

// Challenge is one entry of data/challenges.json challenges. The reward is the client's business:
// the server only verifies and stores completion.
type Challenge struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Kind        string `json:"kind"`
	// Buoys are the step names of a KindVisitBuoys challenge.
	Buoys []string `json:"buoys"`
}

// ChallengeParameters is data/challenges.json.
type ChallengeParameters struct {
	Challenges []Challenge `json:"challenges"`
}

// ChallengeParams is data/challenges.json. Read-only.
var ChallengeParams = load[ChallengeParameters]("challenges.json")

// ChallengeStep is one step of one challenge: Challenge indexes ChallengeParams.Challenges, Name is
// the step name stored and sent to clients, Buoy the BuoyData.Buoys index it is reached at.
type ChallengeStep struct {
	Challenge int
	Name      string
	Buoy      int
}

// ChallengeSteps is every step of every challenge, challenge by challenge in data order. Read-only.
var ChallengeSteps = challengeSteps(ChallengeParams, BuoyData)

// challengeSteps flattens p's steps; it panics on data the server cannot verify (an unknown kind,
// an unknown buoy, a duplicate id or step), so a bad data file fails at startup and in tests.
func challengeSteps(p ChallengeParameters, buoys BuoyParameters) []ChallengeStep {
	var steps []ChallengeStep
	ids := map[string]bool{}
	for ci, c := range p.Challenges {
		if c.ID == "" || ids[c.ID] {
			panic(fmt.Sprintf("challenges.json: missing or duplicate id %q", c.ID))
		}
		ids[c.ID] = true
		if c.Kind != KindVisitBuoys {
			panic(fmt.Sprintf("challenges.json: %s: unknown kind %q", c.ID, c.Kind))
		}
		if len(c.Buoys) == 0 {
			panic(fmt.Sprintf("challenges.json: %s: no buoys", c.ID))
		}
		seen := map[string]bool{}
		for _, name := range c.Buoys {
			buoy := -1
			for i, b := range buoys.Buoys {
				if b.Name == name {
					buoy = i
				}
			}
			if buoy < 0 || seen[name] {
				panic(fmt.Sprintf("challenges.json: %s: unknown or repeated buoy %q", c.ID, name))
			}
			seen[name] = true
			steps = append(steps, ChallengeStep{Challenge: ci, Name: name, Buoy: buoy})
		}
	}
	return steps
}
