package sim

import (
	"encoding/json"
	"fmt"

	"sail/data"
)

// load decodes one embedded JSON file from /data (shared with the TypeScript sim). The files are
// compiled into the binary, so a decode error is a build defect and panics at start-up. Used in
// package-level variable initializers so Go orders them by dependency (they run before any
// init function or test-level variable that builds a boat or config).
func load[T any](name string) T {
	var v T
	b, err := data.FS.ReadFile(name)
	if err != nil {
		panic(fmt.Sprintf("sim: read %s: %v", name, err))
	}
	if err := json.Unmarshal(b, &v); err != nil {
		panic(fmt.Sprintf("sim: decode %s: %v", name, err))
	}
	return v
}
