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
	want := []ChallengeStep{{0, "C", 2, -1}, {0, "A", 0, -1}, {1, "A", 0, -1}}
	if !slices.Equal(steps, want) {
		t.Fatalf("steps %v, want %v", steps, want)
	}
}

func TestCourseStepsChainInOrderAndNameReturns(t *testing.T) {
	buoys := BuoyParameters{Buoys: []Buoy{{Name: "A"}, {Name: "B"}}}
	steps := challengeSteps(ChallengeParameters{Challenges: []Challenge{
		{ID: "tour", Kind: KindVisitBuoys, Buoys: []string{"B"}},
		{ID: "course", Kind: KindCourse, Buoys: []string{"A", "B", "A", "B", "A"}},
	}}, buoys)
	want := []ChallengeStep{
		{0, "B", 1, -1},
		{1, "A", 0, -1}, {1, "B", 1, 1}, {1, "A (2nd)", 0, 2}, {1, "B (2nd)", 1, 3}, {1, "A (3rd)", 0, 4},
	}
	if !slices.Equal(steps, want) {
		t.Fatalf("steps %v, want %v", steps, want)
	}
	for visit, name := range map[int]string{1: "H1", 4: "H1 (4th)", 11: "H1 (11th)", 21: "H1 (21st)", 22: "H1 (22nd)", 112: "H1 (112th)"} {
		if got := StepName("H1", visit); got != name {
			t.Errorf("StepName(H1, %d) = %q, want %q", visit, got, name)
		}
	}
}

func TestChallengeStepsRejectUnverifiableData(t *testing.T) {
	buoys := BuoyParameters{Buoys: []Buoy{{Name: "A"}}}
	for name, c := range map[string][]Challenge{
		"unknown kind":            {{ID: "x", Kind: "rounding", Buoys: []string{"A"}}},
		"unknown buoy":            {{ID: "x", Kind: KindVisitBuoys, Buoys: []string{"Z"}}},
		"repeated buoy":           {{ID: "x", Kind: KindVisitBuoys, Buoys: []string{"A", "A"}}},
		"course repeats in a row": {{ID: "x", Kind: KindCourse, Buoys: []string{"A", "A"}}},
		"no buoys":                {{ID: "x", Kind: KindVisitBuoys}},
		"duplicate id":            {{ID: "x", Kind: KindVisitBuoys, Buoys: []string{"A"}}, {ID: "x", Kind: KindVisitBuoys, Buoys: []string{"A"}}},
		"missing id":              {{Kind: KindVisitBuoys, Buoys: []string{"A"}}},
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
