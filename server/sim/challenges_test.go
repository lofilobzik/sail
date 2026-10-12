package sim

import (
	"slices"
	"testing"
)

func TestChallengeStepsShareBuoysAcrossChallenges(t *testing.T) {
	buoys := BuoyParameters{Buoys: []Buoy{{Name: "A"}, {Name: "B"}, {Name: "C"}}}
	steps := challengeSteps(ChallengeParameters{Challenges: []Challenge{
		{ID: "one", Kind: KindVisitBuoys, Buoys: []string{"C", "A"}},
		{ID: "two", Kind: KindVisitBuoys, Buoys: []string{"A"}},
	}}, buoys)
	want := []ChallengeStep{{0, "C", 2}, {0, "A", 0}, {1, "A", 0}}
	if !slices.Equal(steps, want) {
		t.Fatalf("steps %v, want %v", steps, want)
	}
}

func TestChallengeStepsRejectUnverifiableData(t *testing.T) {
	buoys := BuoyParameters{Buoys: []Buoy{{Name: "A"}}}
	for name, c := range map[string][]Challenge{
		"unknown kind":  {{ID: "x", Kind: "rounding", Buoys: []string{"A"}}},
		"unknown buoy":  {{ID: "x", Kind: KindVisitBuoys, Buoys: []string{"Z"}}},
		"repeated buoy": {{ID: "x", Kind: KindVisitBuoys, Buoys: []string{"A", "A"}}},
		"no buoys":      {{ID: "x", Kind: KindVisitBuoys}},
		"duplicate id":  {{ID: "x", Kind: KindVisitBuoys, Buoys: []string{"A"}}, {ID: "x", Kind: KindVisitBuoys, Buoys: []string{"A"}}},
		"missing id":    {{Kind: KindVisitBuoys, Buoys: []string{"A"}}},
	} {
		t.Run(name, func(t *testing.T) {
			defer func() {
				if recover() == nil {
					t.Fatal("no panic")
				}
			}()
			challengeSteps(ChallengeParameters{Challenges: c}, buoys)
		})
	}
}
