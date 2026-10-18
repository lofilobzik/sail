//go:build js && wasm

package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"strings"
	"syscall/js"

	"sail/server/sim"
)

var stateFields = []struct {
	name string
	get  func(*sim.BoatState) float64
	set  func(*sim.BoatState, float64)
}{
	{"t", func(s *sim.BoatState) float64 { return s.T }, func(s *sim.BoatState, v float64) { s.T = v }},
	{"x", func(s *sim.BoatState) float64 { return s.X }, func(s *sim.BoatState, v float64) { s.X = v }},
	{"z", func(s *sim.BoatState) float64 { return s.Z }, func(s *sim.BoatState, v float64) { s.Z = v }},
	{"heading", func(s *sim.BoatState) float64 { return s.Heading }, func(s *sim.BoatState, v float64) { s.Heading = v }},
	{"u", func(s *sim.BoatState) float64 { return s.U }, func(s *sim.BoatState, v float64) { s.U = v }},
	{"v", func(s *sim.BoatState) float64 { return s.V }, func(s *sim.BoatState, v float64) { s.V = v }},
	{"r", func(s *sim.BoatState) float64 { return s.R }, func(s *sim.BoatState, v float64) { s.R = v }},
	{"heel", func(s *sim.BoatState) float64 { return s.Heel }, func(s *sim.BoatState, v float64) { s.Heel = v }},
	{"p", func(s *sim.BoatState) float64 { return s.P }, func(s *sim.BoatState, v float64) { s.P = v }},
	{"pitch", func(s *sim.BoatState) float64 { return s.Pitch }, func(s *sim.BoatState, v float64) { s.Pitch = v }},
	{"pitchRate", func(s *sim.BoatState) float64 { return s.PitchRate }, func(s *sim.BoatState, v float64) { s.PitchRate = v }},
	{"boom", func(s *sim.BoatState) float64 { return s.Boom }, func(s *sim.BoatState, v float64) { s.Boom = v }},
	{"boomSide", func(s *sim.BoatState) float64 { return float64(s.BoomSide) }, func(s *sim.BoatState, v float64) { s.BoomSide = int(v) }},
	{"crewY", func(s *sim.BoatState) float64 { return s.CrewY }, func(s *sim.BoatState, v float64) { s.CrewY = v }},
	{"moored", func(s *sim.BoatState) float64 {
		if s.Moored {
			return 1
		}
		return 0
	}, func(s *sim.BoatState, v float64) { s.Moored = v != 0 }},
}

var controlFields = []struct {
	name string
	get  func(*sim.Controls) float64
	set  func(*sim.Controls, float64)
}{
	{"tiller", func(c *sim.Controls) float64 { return c.Tiller }, func(c *sim.Controls, v float64) { c.Tiller = v }},
	{"sheet", func(c *sim.Controls) float64 { return c.Sheet }, func(c *sim.Controls, v float64) { c.Sheet = v }},
	{"hike", func(c *sim.Controls) float64 { return c.Hike }, func(c *sim.Controls, v float64) { c.Hike = v }},
}

func jsonResult(value any) string {
	data, err := json.Marshal(value)
	if err != nil {
		return "error: " + err.Error()
	}
	return string(data)
}

// diagEntry is one float64 slot of the flattened Diagnostics, in field walk order. Objects take a
// slot too (1); a nullable section's slot is 1 when present and 0 for null, and its `span`
// descendants follow either way. Parent is the enclosing entry's index, -1 for the root. The
// browser rebuilds the same nested shape the JSON had from this table.
type diagEntry struct {
	Key    string `json:"key"`
	Kind   string `json:"kind"` // object, nullable, number or boolean
	Parent int    `json:"parent"`
	span   int
}

func jsonName(f reflect.StructField) string {
	name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
	return name
}

// diagLayout flattens struct type t like encoding/json would: embedded untagged structs inline.
func diagLayout(t reflect.Type, parent int, out []diagEntry) []diagEntry {
	for i := range t.NumField() {
		f := t.Field(i)
		name := jsonName(f)
		if f.Anonymous && name == "" {
			out = diagLayout(f.Type, parent, out)
			continue
		}
		switch f.Type.Kind() {
		case reflect.Float64, reflect.Int:
			out = append(out, diagEntry{Key: name, Kind: "number", Parent: parent})
		case reflect.Bool:
			out = append(out, diagEntry{Key: name, Kind: "boolean", Parent: parent})
		case reflect.Struct:
			index := len(out)
			out = diagLayout(f.Type, index, append(out, diagEntry{Key: name, Kind: "object", Parent: parent}))
		case reflect.Pointer:
			index := len(out)
			out = diagLayout(f.Type.Elem(), index, append(out, diagEntry{Key: name, Kind: "nullable", Parent: parent}))
			out[index].span = len(out) - index - 1
		default:
			panic(fmt.Sprintf("diagnostics field %s: unsupported kind %s", f.Name, f.Type.Kind()))
		}
	}
	return out
}

// encodeDiag writes struct value v into out from slot i, in diagLayout's order; returns the next slot.
func encodeDiag(v reflect.Value, layout []diagEntry, out []byte, i int) int {
	put := func(x float64) { binary.LittleEndian.PutUint64(out[i*8:], math.Float64bits(x)) }
	t := v.Type()
	for f := range t.NumField() {
		field, fv := t.Field(f), v.Field(f)
		if field.Anonymous && jsonName(field) == "" {
			i = encodeDiag(fv, layout, out, i)
			continue
		}
		switch fv.Kind() {
		case reflect.Float64:
			put(fv.Float())
			i++
		case reflect.Int:
			put(float64(fv.Int()))
			i++
		case reflect.Bool:
			put(0)
			if fv.Bool() {
				put(1)
			}
			i++
		case reflect.Struct:
			put(1)
			i = encodeDiag(fv, layout, out, i+1)
		case reflect.Pointer:
			if fv.IsNil() {
				put(0)
				i += 1 + layout[i].span
			} else {
				put(1)
				i = encodeDiag(fv.Elem(), layout, out, i+1)
			}
		}
	}
	return i
}

func main() {
	boat := sim.BuildBoat()
	cfg := sim.BrowserConfig(1)
	var last sim.Diagnostics
	// The exports are synchronous. Reuse both the transfer bytes and the table targets.
	var state sim.BoatState
	var controls sim.Controls
	stateBytes := len(stateFields) * 8
	ioBytes := stateBytes + len(controlFields)*8
	scratch := make([]byte, ioBytes)
	diagFields := diagLayout(reflect.TypeFor[sim.Diagnostics](), -1, nil)
	diagBytes := make([]byte, len(diagFields)*8)
	layout := struct {
		State       []string    `json:"state"`
		Controls    []string    `json:"controls"`
		Diagnostics []diagEntry `json:"diagnostics"`
	}{State: make([]string, len(stateFields)), Controls: make([]string, len(controlFields)), Diagnostics: diagFields}
	for i, field := range stateFields {
		layout.State[i] = field.name
	}
	for i, field := range controlFields {
		layout.Controls[i] = field.name
	}
	layoutJSON := jsonResult(layout)
	decodeState := func() {
		for i, field := range stateFields {
			field.set(&state, math.Float64frombits(binary.LittleEndian.Uint64(scratch[i*8:])))
		}
	}
	decodeControls := func(offset int) {
		for i, field := range controlFields {
			field.set(&controls, math.Float64frombits(binary.LittleEndian.Uint64(scratch[offset+i*8:])))
		}
	}
	writeState := func(io js.Value) {
		for i, field := range stateFields {
			binary.LittleEndian.PutUint64(scratch[i*8:], math.Float64bits(field.get(&state)))
		}
		js.CopyBytesToJS(io, scratch[:stateBytes])
	}
	obj := js.Global().Get("Object").New()
	obj.Set("layout", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		return layoutJSON
	}))
	obj.Set("browserConfig", js.FuncOf(func(_ js.Value, args []js.Value) any {
		return jsonResult(sim.BrowserConfig(uint32(args[0].Float())))
	}))
	obj.Set("setConfig", js.FuncOf(func(_ js.Value, args []js.Value) any {
		var next sim.SimConfig
		if err := json.Unmarshal([]byte(args[0].String()), &next); err != nil {
			return "error: " + err.Error()
		}
		// Match SetWaveWind/SetWaveLayers input normalization before a single
		// unconditional SetWaveParameters compile. Wave wind is its own input,
		// not necessarily the current true wind; incoming derived caches are ignored.
		waves := &next.Waves
		waves.WindSpeedKn = math.Max(0, waves.WindSpeedKn)
		waves.BigScale = sim.Clamp(waves.BigScale, 0, sim.WaveParams.MaxLayerScale)
		waves.RippleScale = sim.Clamp(waves.RippleScale, 0, sim.WaveParams.MaxLayerScale)
		sim.SetWaveParameters(waves, waves.PeriodSeconds, waves.DirectionDeg)
		data, err := json.Marshal(next)
		if err != nil {
			return "error: " + err.Error()
		}
		cfg = next
		return string(data)
	}))
	// Writes back the state and the controls actually applied: sim.Step clamps exactly like the
	// server's queue boundary (sim.ClampControls), so the caller can send and record these.
	obj.Set("step", js.FuncOf(func(_ js.Value, args []js.Value) any {
		js.CopyBytesToGo(scratch[:ioBytes], args[0])
		decodeState()
		decodeControls(stateBytes)
		result := sim.Step(state, controls, boat, &cfg)
		state, last = result.State, result.Diagnostics
		controls = sim.ClampControls(controls)
		for i, field := range controlFields {
			binary.LittleEndian.PutUint64(scratch[stateBytes+i*8:], math.Float64bits(field.get(&controls)))
		}
		for i, field := range stateFields {
			binary.LittleEndian.PutUint64(scratch[i*8:], math.Float64bits(field.get(&state)))
		}
		js.CopyBytesToJS(args[0], scratch[:ioBytes])
		return nil
	}))
	// Batch consecutive controls for replay without paying a JS/Go crossing per input.
	obj.Set("stepMany", js.FuncOf(func(_ js.Value, args []js.Value) any {
		count := args[1].Int()
		size := stateBytes + count*len(controlFields)*8
		if size > len(scratch) {
			scratch = make([]byte, size)
		}
		js.CopyBytesToGo(scratch[:size], args[0])
		decodeState()
		for i := range count {
			decodeControls(stateBytes + i*len(controlFields)*8)
			result := sim.Step(state, controls, boat, &cfg)
			state, last = result.State, result.Diagnostics
		}
		writeState(args[0])
		return nil
	}))
	obj.Set("evaluate", js.FuncOf(func(_ js.Value, args []js.Value) any {
		js.CopyBytesToGo(scratch[:ioBytes], args[0])
		decodeState()
		decodeControls(stateBytes)
		last = sim.Evaluate(state, controls, boat, &cfg)
		return nil
	}))
	obj.Set("castOff", js.FuncOf(func(_ js.Value, args []js.Value) any {
		js.CopyBytesToGo(scratch[:stateBytes], args[0])
		decodeState()
		state = sim.CastOff(state)
		writeState(args[0])
		return nil
	}))
	obj.Set("mooredAt", js.FuncOf(func(_ js.Value, args []js.Value) any {
		berth := args[0].Float()
		if math.IsNaN(berth) || berth < 0 || berth >= float64(len(sim.Bay.Harbour.Berths)) || math.Trunc(berth) != berth {
			binary.LittleEndian.PutUint64(scratch, math.Float64bits(math.NaN()))
			js.CopyBytesToJS(args[2], scratch[:8])
			return nil
		}
		state = sim.MooredAt(sim.Bay.Harbour.Berths[int(berth)], args[1].Float(), boat, &cfg)
		writeState(args[2])
		return nil
	}))
	// Fills the given buffer with the last step's or evaluation's diagnostics, laid out as in layout().diagnostics.
	lastValue := reflect.ValueOf(&last).Elem()
	obj.Set("diagnostics", js.FuncOf(func(_ js.Value, args []js.Value) any {
		encodeDiag(lastValue, diagFields, diagBytes, 0)
		js.CopyBytesToJS(args[0], diagBytes)
		return nil
	}))
	js.Global().Set("sailPhysics", obj)
	select {}
}
