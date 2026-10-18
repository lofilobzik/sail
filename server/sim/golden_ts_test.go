package sim

import "testing"

// MIGRATION-ONLY: frozen TS sim output; delete in step 3b once step 3 is approved.
func TestFrozenTSGolden(t *testing.T) {
	t.Run("samples", func(t *testing.T) { compareGoldenSamples(t, "testdata/golden-ts", false) })
	t.Run("traces", func(t *testing.T) { compareGoldenTraces(t, "testdata/golden-ts") })
}
