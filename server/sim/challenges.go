package sim

import "fmt"

// Challenge kinds: how a challenge's steps are reached. Both list buoys of data/buoys.json in Buoys;
// a buoy counts when the boat is near it (BuoyData.ProximityRadius).
const (
	// KindVisitBuoys: every listed buoy once, in any order.
	KindVisitBuoys = "visitBuoys"
	// KindCourse: the listed buoys in order; a buoy may come back later in the list (not twice in a
	// row), and each step counts only once the one before it has.
	KindCourse = "course"
)

// Challenge is one entry of data/challenges.json challenges. The reward is the client's business:
// the server only verifies and stores completion.
type Challenge struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Kind        string   `json:"kind"`
	Buoys       []string `json:"buoys"`
}

// ChallengeParameters is data/challenges.json.
type ChallengeParameters struct {
	Challenges []Challenge `json:"challenges"`
}

// ChallengeParams is data/challenges.json. Read-only.
var ChallengeParams = load[ChallengeParameters]("challenges.json")

// ChallengeStep is one step of one challenge: Challenge indexes ChallengeParams.Challenges, Name is
// the step name stored and sent to clients (StepName), Buoy the BuoyData.Buoys index it is reached
// at, Prev the ChallengeSteps index that must be reached first (-1 for none).
type ChallengeStep struct {
	Challenge int
	Name      string
	Buoy      int
	Prev      int
}

// ChallengeSteps is every step of every challenge, challenge by challenge in data order. Read-only.
var ChallengeSteps = challengeSteps(ChallengeParams, BuoyData)

// StepName is the name of a challenge's step at buoy `buoy`, its `visit`th time in the list (1 for
// the first): the buoy name, then "H1 (2nd)", "H1 (3rd)" and so on, so every step name of a
// challenge is unique (progress is stored by name). TS twin: stepName in src/ui/challengeInfo.ts.
func StepName(buoy string, visit int) string {
	if visit <= 1 {
		return buoy
	}
	suffix := "th"
	switch {
	case visit%100 >= 11 && visit%100 <= 13:
	case visit%10 == 1:
		suffix = "st"
	case visit%10 == 2:
		suffix = "nd"
	case visit%10 == 3:
		suffix = "rd"
	}
	return fmt.Sprintf("%s (%d%s)", buoy, visit, suffix)
}

// challengeSteps flattens p's steps; it panics on data the server cannot verify (an unknown kind or
// buoy, a duplicate id, a buoy repeated where the kind forbids it), so a bad data file fails at
// startup and in tests.
func challengeSteps(p ChallengeParameters, buoys BuoyParameters) []ChallengeStep {
	var steps []ChallengeStep
	ids := map[string]bool{}
	for ci, c := range p.Challenges {
		if c.ID == "" || ids[c.ID] {
			panic(fmt.Sprintf("challenges.json: missing or duplicate id %q", c.ID))
		}
		ids[c.ID] = true
		if c.Kind != KindVisitBuoys && c.Kind != KindCourse {
			panic(fmt.Sprintf("challenges.json: %s: unknown kind %q", c.ID, c.Kind))
		}
		if len(c.Buoys) == 0 {
			panic(fmt.Sprintf("challenges.json: %s: no buoys", c.ID))
		}
		visits := map[string]int{}
		for i, name := range c.Buoys {
			buoy := -1
			for bi, b := range buoys.Buoys {
				if b.Name == name {
					buoy = bi
				}
			}
			if buoy < 0 {
				panic(fmt.Sprintf("challenges.json: %s: unknown buoy %q", c.ID, name))
			}
			repeated := visits[name] > 0
			if (c.Kind == KindVisitBuoys && repeated) || (c.Kind == KindCourse && i > 0 && c.Buoys[i-1] == name) {
				panic(fmt.Sprintf("challenges.json: %s: buoy %q repeated", c.ID, name))
			}
			visits[name]++
			prev := -1
			if c.Kind == KindCourse && i > 0 {
				prev = len(steps) - 1
			}
			steps = append(steps, ChallengeStep{Challenge: ci, Name: StepName(name, visits[name]), Buoy: buoy, Prev: prev})
		}
	}
	return steps
}
