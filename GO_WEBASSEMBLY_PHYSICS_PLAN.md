# Go physics in the browser via WebAssembly

## Context

The browser predicts its own boat with the TypeScript sim (`src/sim/`), while the server is authoritative with a hand-ported Go copy (`server/sim/`, ~2,980 lines, pure `math` in the physics files). Parity is held by golden traces generated from TS and checked in Go at 1e-9 (V8 vs Go `Math` differ in the last ulps; `server/sim/jsmath.go` emulates `Math.hypot`/`imul`). Goal: compile `server/sim` to WebAssembly (standard Go, `GOOS=js GOARCH=wasm`) and make it the only physics, so prediction and server run the same code; then replace the blend/snap corrector with rewind/replay. Rule for the whole migration: anything that affects gameplay (forces, wind on the sail, grounding, mooring and cast-off, buoy proximity for challenges) comes only from Go; TS keeps copies of waves/wind/terrain sampling and the GLSL generator for drawing only, checked against Go-generated samples (gusts over time included).

### What crosses the boundary today (facts this plan relies on)

- Client fixed step, `src/main.ts:357-375`, `dt` 1/60 (from the welcome online), 4 substeps: sample controls → optional `castOff(curr)` (mutates) → `step(curr, controls, boat, cfg)` → speed over ground → `server.afterStep` (sends `{type:'input', seq, controls:{tiller,sheet,hike}, castOff?:true}`; `Corrector.afterStep` adds the pending blend to `curr` in place and records it by `seq % 256`) → `navigation.advance`.
- Server `Room.step` (`server/netsim/room.go:295-317`): one `sim.Step` per queued input in seq order (clamped controls, credit system), `sim.CastOff` when flagged; 20 Hz snapshot `{tick, ackSeq, state, controls, boats}`; welcome carries the full Go `SimConfig` JSON, `dt`, `tick`, `state`.
- Wind and waves depend only on config + `state.t` (seeded gusts), so both sides see identical forcing for the same seq.
- `Corrector` (`src/net/correction.ts`): error = server − recorded prediction at `ackSeq` (minus corrections applied since); snap above 2 m / 20° / boomSide or moored mismatch, else blend over 0.2 s; no replay (`docs/DESIGN.md:167`, deferred at `:183`).
- Remote boats: interpolation only (`src/net/remote.ts`), unaffected. Offline: `browserConfig(seed)` + URL overrides and the TS step alone.
- Live config: one `SimConfig` object shared by reference; `DebugOverlay.buildPhysics` (`src/debug/overlay.ts:166-231`) mutates layers/terms/models/wind/gusts/land/waves offline (disabled online); `adoptServerConfig` (`src/net/client.ts:238-258`) copies the welcome config field by field and recompiles wave components locally.

## Approach

Each step leaves the game working and the tests green; steps 1-2 change nothing for players. **One commit per step**, made when the step's verification passes (`git add -A && git commit`), with these messages:
- Step 1: `Build the Go sim to WebAssembly with a TS bridge and a boundary test`
- Step 2: `Compare the wasm sim against the TS sim in the running game (?physics=compare)`
- Step 3: `Run the Go physics in the browser via wasm; drop the TS physics`
- Step 3b: `Drop the frozen TS golden fixtures`
- Step 4: `Reconcile prediction by replaying unacked inputs through the Go sim`

**Gate after step 2: STOP.** Do not start step 3. Report to the user: the raw and gzipped size of `public/wasm/sim.wasm`, the mean wasm step time in µs, and the max per-step |Δ| per field (dx, dz, heading, u) from the `physics compare` logs, offline and online. Step 3 deletes the TS physics, so it starts only after the user replies.

**Gate after step 3: STOP** and report the step 3 verification results. Step 3b and step 4 start only after the user approves step 3.

### 1. Build a wasm sim and a TS bridge (no gameplay change)

- **Shared sim package**: compile `server/sim` as is; do not move or split it (standard Go handles `encoding/json`, `fmt`, `embed`).
- **One control clamp for server and client**: move `clampControls` from `server/netsim/room.go:589-595` into `server/sim` as `func ClampControls(c Controls) Controls`, keeping its exact body (`math.Min(1, math.Max(-1, tiller))`, sheet and hike in [0, 1]). Call it at the only server call site (`room.go:496`, the queue push) and at the top of `sim.Step` (`server/sim/step.go:327-331`, replacing the inline `Clamp` calls), then delete the netsim copy. Before committing, run the golden tests: if they fail on clamping, the old `Clamp` differed from `math.Min/Max`, so keep `Step`'s inline clamp unchanged and use `ClampControls` only where netsim used it.
- **Add `server/cmd/simwasm/main.go`** (`//go:build js && wasm`, `package main`, imports `syscall/js`, `encoding/binary`, `encoding/json`, `math`, `sail/server/sim`). It holds `boat := sim.BuildBoat()`, the current `cfg sim.SimConfig`, the last `sim.Diagnostics`, and one reusable `[]byte` scratch buffer. It sets `js.Global().Set("sailPhysics", obj)` and blocks on `select {}`. Exported functions, all synchronous:
  - `layout(): string`: JSON `{"state":[...],"controls":[...]}`, the field names in buffer order, from one Go table (below).
  - `browserConfig(seed: number): string`: `json.Marshal(sim.BrowserConfig(uint32(seed)))`.
  - `setConfig(json: string): string`: unmarshal into a `sim.SimConfig`, recompute the derived wave fields (`components`, `amplitudeLimit`) from the non-derived wave settings by the same calls `BrowserConfig`/`SetWaveWind`/`SetWaveLayers`/`SetWaveParameters` use (read `server/sim/waves.go` and `config.go` to find which fields are inputs; `SetWaveParameters` may write a package global (unverified, confirm first): if it does, apply it here before recompiling), store it, return the normalized config JSON. On any error return `"error: " + err.Error()`.
  - `step(io: Uint8Array): void`: decode state (15 float64) then controls (3 float64) from `io`, `res := sim.Step(state, controls, boat, &cfg)`, keep `res.Diagnostics`, write the new state into `io[0:15*8]`.
  - `evaluate(io: Uint8Array): void`: decode state + controls, `last = sim.Evaluate(...)`, state untouched.
  - `castOff(io: Uint8Array): void`: state in, `sim.CastOff(state)` out.
  - `mooredAt(berth: number, t: number, io: Uint8Array): void`: `sim.MooredAt(sim.Bay.Harbour.Berths[berth], t, boat, &cfg)` into `io`; out of range writes NaN in `io[0]` (the TS side throws).
  - `diagnostics(): string`: `json.Marshal(last)`. The Go JSON tags already match the TS `Diagnostics` names and null-for-off layers; it is called once per frame, not per step.
  - `clampControls(io: Uint8Array): void`: decode the 3 control floats at the controls offset (`15*8`), `sim.ClampControls`, write them back. The client records and sends exactly these values (step 4).
  - Buffer encoding: float64 little-endian via `binary.LittleEndian` + `math.Float64bits`; `boomSide` as ±1, `moored` as 0/1. One Go table `stateFields = []struct{name string; get func(*sim.BoatState) float64; set func(*sim.BoatState, float64)}` in JSON-tag order (`t,x,z,heading,u,v,r,heel,p,pitch,pitchRate,boom,boomSide,crewY,moored`; confirm against `server/sim/state.go`) drives encode, decode and `layout()`; same for `controlFields` (`tiller,sheet,hike`). Copy with `js.CopyBytesToGo` / `js.CopyBytesToJS`, no per-call allocation.
- **Add `src/physics/`**:
  - `load.ts`: `export async function loadPhysics(wasm: BufferSource | Response): Promise<Physics>`. Imports the generated `./wasm_exec.js` for its side effect (`globalThis.Go`), instantiates (`WebAssembly.instantiateStreaming` for a `Response`, else `instantiate`), `go.run(instance)` without awaiting, then reads `globalThis.sailPhysics`.
  - `bridge.ts`: `class Physics` owning one `Uint8Array` io buffer of `(15 + 3) * 8` bytes. Methods: `step(state: BoatState, controls: Controls): BoatState` (new object), `evaluate(state, controls): Diagnostics`, `diagnostics(): Diagnostics` (`JSON.parse`), `castOff(state): BoatState`, `mooredAt(berthIndex: number, t: number): BoatState`, `clampControls(c: Controls): Controls` (new object), `browserConfig(seed: number): SimConfig`, `setConfig(cfg: SimConfig): SimConfig` (throws on `error:`). The constructor calls `layout()` and throws `physics layout mismatch: <go names> vs <ts names>` if the names differ from the TS field lists, so a renamed field fails at load, not as silent garbage.
  - `types.ts`: move the TS `Diagnostics` (and its layer result types), `StepResult`, `BoatState`, `Controls`, `SimConfig` (+ sub-config types) here unchanged. Re-point every importer (`tsc` lists them; at least `src/main.ts`, `src/net/{protocol,link,client,correction}.ts`, `src/debug/{hud,overlay}.ts`, `src/ui/hints.ts`, `src/render/{vectors,pose}.ts`, `src/input/controls.ts`). `src/sim/index.ts` stops exporting them; no re-export alias.
- **Build wiring**:
  - `package.json`: `"build:wasm": "mkdir -p public/wasm && GOOS=js GOARCH=wasm go build -trimpath -ldflags='-s -w' -o public/wasm/sim.wasm ./server/cmd/simwasm && cp \"$(go env GOROOT)/lib/wasm/wasm_exec.js\" src/physics/wasm_exec.js"` (the path exists in this Go 1.27 install, verified). Prefix `dev`, `build` and `test` with `npm run build:wasm &&`. Add `public/wasm/` and `src/physics/wasm_exec.js` to `.gitignore`.
  - `vite.config.ts`: a small inline plugin (`configureServer`) that watches `server/sim/**/*.go` and `server/cmd/simwasm/**/*.go` and rebuilds with a debounce: each change resets a 300 ms timer; when it fires, run `npm run build:wasm` (child process), then send a full reload. Never run two builds at once: a change during a build only sets a `dirty` flag, and when the build finishes with `dirty` set, the plugin clears it and starts one more build. On a failed build, log the compiler output to the vite terminal and skip the reload; the previous `sim.wasm` stays in place.
  - Browser loading: `fetch(new URL('wasm/sim.wasm', document.baseURI))` (vite `base` is `./`; `public/` is served and copied to `dist/` as is).
  - `.github/workflows/deploy.yml` job `test`: add `run: npm run build:wasm` before `npm run typecheck`, plus `GOOS=js GOARCH=wasm go vet ./server/sim ./server/cmd/simwasm`.
  - `Containerfile`: new stage `FROM --platform=$BUILDPLATFORM golang:1.27 AS wasm` that copies `go.mod go.sum data server`, runs the same `go build` into `/out/sim.wasm` and copies `wasm_exec.js` to `/out/`. In `site`, before `npx vite build`: `COPY --from=wasm /out/sim.wasm public/wasm/sim.wasm` and `COPY --from=wasm /out/wasm_exec.js src/physics/wasm_exec.js`. wasm is platform independent, so one build serves amd64 and arm64.
- **Boundary test** `src/physics/wasm.test.ts` (vitest, Node): read `public/wasm/sim.wasm` with `fs`, `loadPhysics`, `setConfig` from the fixture's config, replay the first 600 steps of the `browser` golden trace (`server/sim/testdata/golden/trace-browser.json`; read `server/sim/golden_test.go` for the fixture shape) through `Physics.step`, and compare every recorded state field and the final `diagnostics()` within `1e-9 + 1e-9*|want|`. It also checks that `mooredAt(0, 0)` returns `moored === true`.

### 2. Shadow comparison in the running game (no gameplay change)

- `src/main.ts`: only when `?physics=compare` is set, load the wasm before the first frame: `const physics = urlParams.physicsCompare ? await loadPhysics(await fetch(...)).catch(...) : null` (top-level await; build target es2022). Without the flag nothing is fetched and normal play is unchanged. In compare mode a load failure logs `physics compare: wasm failed to load: <error>` to the console, sets `physics = null`, and the game runs on the TS sim alone.
- Behind `?physics=compare` only (parse in `src/debug/urlParams.ts` as `physicsCompare: boolean`): both sims must see the same config, state, controls and cast-off.
  - **Config**: call `physics.setConfig(cfg)` once the config is final, offline after the URL overrides (`main.ts:60-82`) and online after `configFromWelcome`. Call it again after every change:
    - every debug-overlay control, through a new `onConfigChange(): void` option on `DebugOverlay`, called after its existing `setWave*` mutation;
    - a non-resumed rewelcome's `adoptServerConfig` (`link.ts:51`).
    This hook stays in step 3, where it replaces the TS `setWave*` calls.
  - **State and cast-off**: each fixed step, copy the pre-step state before the TS `castOff`. If this step casts off, the wasm side runs `physics.castOff(copy)` too. Then run `physics.step(copy, controls)` with the same `controls` object the TS step used.
  - **Compare**: compare against the TS `result.state` right after `step(...)`, before `server.afterStep` (the online corrector's blend mutates `curr` afterwards and would show as a false difference). Take the field-wise max |Δ|, with heading via `wrapPi`. Time each wasm step with `performance.now()`. Once every 5 s, `console.log` `physics compare: max dx <m> dz <m> heading <rad> u <m/s> over <n> steps, wasm step <µs> mean`.
  - **Config shape**: TS `cfg.wind.gusts` is optional while Go's `GustConfig` is a value with `Enabled`. Before `setConfig`, send `gusts: cfg.wind.gusts ?? { enabled: false }` (Go's zero value means the same). Any other field Go cannot read shows up as a nonzero |Δ| in the first compare line; fix it the same way, in the TS-to-JSON step only.
  - The TS sim stays authoritative; the wasm result is thrown away each step (no accumulated drift).
- Exit criterion: max per-step |Δ| ≤ 1e-9 over a few minutes of play (waves and gusts on), and the mean wasm step time recorded. Then the gate above.

### 3. Cutover: wasm drives prediction and offline play

- `src/main.ts`:
  - Wasm loading becomes mandatory: before the first frame, `const physics = await loadPhysics(await fetch(new URL('wasm/sim.wasm', document.baseURI)))`. On failure, show the existing connection-style banner text `Physics failed to load. Reload the page.` and stop; no TS fallback.
  - The fixed step calls `physics.castOff` and `physics.step`. Keep today's cast-off handshake: when it casts off, it also sets `castOffRequested = false`, so a request is used once and cannot fire again when the boat is moored later.
  - `resetBoat` uses `physics.evaluate`.
  - `harbourStart` uses `physics.mooredAt(0, 0)`; `?start=` keeps `initialState(...)` from `src/sim/state.ts` as plain data.
  - Read diagnostics once per frame via `physics.diagnostics()` after the steps, for pose, sound, hints, HUD, vectors and overlay. Read them only when at least one step ran this frame, else keep the previous object. (Step 4 adds a refresh after reconciliation.)
  - Offline config = `physics.browserConfig(seed)`, then the existing URL overrides on that object, then `cfg = physics.setConfig(cfg)`.
- `src/net/client.ts`: replace `adoptServerConfig`'s field copy and wave recompile with `physics.setConfig(welcome.config)`, keeping `dt` from the welcome, and copy the returned config into the shared `cfg` object (`Object.assign` per sub-object, so `SceneView`'s references to `cfg.waves`/`cfg.env`/`cfg.wind` stay valid). `configFromWelcome` becomes `physics.setConfig(w.config)`.
- `src/debug/overlay.ts`: gets an `onConfigChange(): void` option; every control that mutates `cfg` calls it after mutating, instead of `setWaveWind`/`setWaveLayers`/`setWaveParameters`. `main.ts` wires it to `Object.assign` the result of `physics.setConfig(cfg)` back into `cfg`, so render reads Go's recompiled wave components.
- **Delete the TS physics**:
  - `src/sim/step.ts`, `src/sim/layers/` (with its tests), `src/sim/friction.ts`, `src/sim/step.test.ts`, `src/sim/waveDynamics.test.ts`, `src/sim/mooring.test.ts`.
  - The compute parts of `src/sim/mooring.ts` (`mooredAt`, `castOff`); keep `BERTHS` and `berthIndexAt` for `render/scene.ts` and `land/floatingDocks.ts`.
  - The compute parts of `src/sim/config.ts` (`defaultConfig`, `browserConfig`, `withDisabledLayers`); keep `LAYER_IDS` only if a remaining file imports it.
  - The wave recompile functions in `src/sim/waves.ts` (`setWaveWind`, `setWaveLayers`, `setWaveParameters`) once nothing imports them.
  - `src/sim/boat.ts` stays as is: render geometry uses it (`render/boatLayout.ts`, `wake/contact.ts`).
- **Render-only TS that stays**: `waves.ts` (`sampleWaves`, `waveAmplitude`, `createWaveSample`, `gerstnerGLSL`, `rippleCutoff`, `wavePhaseAt`), `wind.ts` (`windSpeedFactor`, `meanWind`, `getWind`), `terrain.ts`, `frames.ts`, `spline.ts`, `fixedStep.ts`, `state.ts` (`initialState`, `NEUTRAL_CONTROLS`). Put this header on `waves.ts`, `wind.ts` and `terrain.ts`: `Render-only copy of server/sim/<file>.go: drawing only. Gameplay (forces, wind on the sail, grounding, buoy checks) comes from the Go physics (src/physics). Kept equal by src/sim/renderParity.test.ts.`
- **Client-only, unchanged**: sail cloth (`render/cloth`), telltales, wake/bow field, water shader, gust map texture, remote-boat interpolation, navigation (fed speed over ground), hints and quest distances (UI triggers only; challenge progress stays server-side Go proximity).
- **Golden fixtures flip to Go, with a frozen TS reference during the migration**:
  - First, before regenerating anything: copy the current TS-generated `server/sim/testdata/golden/` to `server/sim/testdata/golden-ts/`, unchanged. Add `TestFrozenTSGolden` in `server/sim/golden_ts_test.go`, which runs the existing trace and sample comparisons (reuse `golden_test.go`'s helpers with the directory as a parameter) against `golden-ts/`. In `src/physics/wasm.test.ts`, add a second case running the same 600-step `browser` trace against `golden-ts/`. Both start with the comment `// MIGRATION-ONLY: frozen TS sim output; delete in step 3b once step 3 is approved.` Tolerance as now: `1e-9 + 1e-9*|want|`.
  - Then port the scenario and control schedules of `scripts/goldenTraces.ts` verbatim into `server/sim/golden_gen_test.go`, behind `var update = flag.Bool("update", false, ...)`. `go test ./server/sim -run TestGolden -update` rewrites `server/sim/testdata/golden/` (not `golden-ts/`) from native Go. If `goldenTraces.ts` imports `scripts/lib/autopilot.ts`, port that function too (unverified, confirm first).
  - Extend the samples fixture with gusts over time: `getWind` and `windSpeedFactor` at 5 positions (berth 0, the departure, buoys N, E, S) × t = 0..600 s every 30 s × seeds `1` and `0x9e3779b9`, gusts on.
  - `TestGoldenTraces` / `TestGoldenSamples` then compare against these fixtures as regression snapshots (same 1e-9 tolerance), and fail rather than skip when fixtures are missing.
  - Add `src/sim/renderParity.test.ts`: load `samples.json` and check the TS `sampleWaves`, `getWind`, `windSpeedFactor`, `terrainHeight` and `LANDMARKS` within 1e-9.
- **Scripts move to Go**:
  - `package.json` `"polar": "go run ./server/cmd/polar"`; its flags already match the TS script (`--tws --twa-step --disable --disable-terms --enable-terms --model --set --quiet --waves --wave-amplitude --wave-period --wave-direction --out`).
  - `"golden": "go test ./server/sim -run TestGolden -update"`.
  - Delete `scripts/polar.ts`, `scripts/goldenTraces.ts`, `scripts/goldenTraces.test.ts`, `scripts/lib/steadyState.ts`, `scripts/lib/autopilot.ts`, and `scripts/lib/svgPolar.ts` if nothing else imports it.
  - `scripts/renderMap.ts` and `scripts/renderChart.ts` stay (they use the render-only terrain).
  - Drop `scripts` from `tsconfig.sim.json`'s include if nothing headless remains there.
- Remove the `?physics=compare` code from step 2 (TS step no longer exists) and its URL option.
- Keep the `Corrector` as is in this step; with identical code its blends should be ~0.

### 3b. Remove the frozen TS fixtures (after the user approves step 3)

- Delete `server/sim/testdata/golden-ts/`, `server/sim/golden_ts_test.go` and the `golden-ts` case in `src/physics/wasm.test.ts`. Afterwards `grep -rn "MIGRATION-ONLY" server src` returns nothing.

### 4. Rewind/replay instead of blend/snap

Prediction and server run the same code on the same inputs. First compare the snapshot with the recorded prediction at `ackSeq`: when every field matches within 1e-9, acknowledge it without replay. Only a mismatch (or an unavailable acknowledged prediction) needs rewind/replay. Replaying unacked inputs from the authoritative state then reproduces the server. The mismatch-path cost is about (RTT × 60 + 3) steps per snapshot, ~10 steps at 100 ms RTT; matching snapshots cost only the state comparison.

- `src/net/correction.ts` → `class Reconciler`, same file:
  - Ring of 256 entries keyed by `seq % 256`: `seqs: Int32Array`, `controls: Float64Array(256*3)`, `castOff: Uint8Array`, and a copied prediction for every state field after each input (not a reference to mutable `curr`).
  - `record(seq, controls, castOff, state)` is called from `ServerLink.afterStep` and stores both the applied input and its resulting predicted state.
  - **Recorded controls are the server's, clamped before the local step.** The clamp moves into `main.ts`'s fixed step, ahead of `physics.step`, in this order:
    ```ts
    const controls = view.mode === 'fly' ? (input.reset(), { ...NEUTRAL_CONTROLS }) : input.update(cfg.dt);
    const applied = server ? physics.clampControls(controls) : controls;
    if (castingOff) {
      curr = physics.castOff(curr);
      castOffRequested = false;
    }
    const next = physics.step(curr, applied);
    prev = curr;
    curr = next;
    lastApplied = applied;
    server?.afterStep(curr, applied, castingOff);
    ```
    `ServerLink.afterStep(state, applied, castOff)` only transmits (`client.sendInput(applied, castOff)`) and records (`reconciler.record(seq, applied, castOff, state)`); it never clamps and never changes `state`. `physics.clampControls` is the Go `sim.ClampControls` the server runs at the queue boundary, so the local step, the sent input and the recorded replay input are the same values. Offline needs no clamp call: `sim.Step` clamps internally. `let lastApplied: Controls = { ...NEUTRAL_CONTROLS }` is a new `main.ts` variable, used for the diagnostics refresh below.
  - Fields: `minAck` (acks below it are ignored: inputs sent before a reset, welcome or resync), `lastAck` (highest ack processed, including matching snapshots; starts at 0).
  - `reconcile(snapshot, latestSeq): Timeline | null`, with `type Timeline = { prev: BoatState; curr: BoatState }`:
    - Stale or reordered: if `snapshot.ackSeq < minAck` or `snapshot.ackSeq <= lastAck`, return null (no replay, no change). This covers old acks after a reset and snapshots arriving out of order. `NetClient.takeSnapshot` already keeps only the newest untaken one per frame.
    - Before dropping the acknowledged ring entry, compare its recorded prediction with `snapshot.state`: absolute error ≤ 1e-9 for **every numeric state field**, heading difference via `wrapPi`, and exact equality for `moored` and `boomSide`. Non-finite values never match. Set `lastAck = snapshot.ackSeq` and drop ring entries with seq ≤ `snapshot.ackSeq`; they are acknowledged and never replayed.
    - Missing history: if any seq in `ackSeq+1..latestSeq` is missing from the ring, adopt `snapshot.state` as both `prev` and `curr`, reset the baseline (`minAck = latestSeq + 1`, `lastAck = snapshot.ackSeq`), keep the ring for seqs > latestSeq (recording continues), and report `resync`.
    - Matching prediction, with complete unacked history: return null without calling `physics.step` or `physics.castOff`, changing the current timeline, refreshing diagnostics, or replacing the visual offset. The ack still advances and acknowledged history is pruned.
    - Otherwise replay (mismatch, or acknowledged prediction missing): `s = snapshot.state`, `p = snapshot.state`; for each seq in order: `p = s`; if `castOff[seq]` then `s = physics.castOff(s)`; `s = physics.step(s, controls[seq])`. Replace that seq's recorded prediction with the replayed state, so later acknowledgements compare against the corrected timeline rather than stale predictions. Return `{ prev: p, curr: s }`, kind `replay`. When there is nothing to replay (`ackSeq === latestSeq`), `prev = curr = snapshot.state`.
  - `reset(nextSeq)`: clears the ring, `minAck = nextSeq`, `lastAck = 0`.
  - **Inputs the server delays or drops**:
    - Out of credit (`room.go`: `if b.credit < 1 { break }`): the input is not skipped. It stays queued and is applied on a later tick, in seq order, from the same state. The server's `state.t` advances per applied input, not per wall-clock tick, and wind/waves depend only on `state.t`, so a late input gives the same result. The snapshot's `ackSeq` just lags, the replay window gets longer, and nothing else changes.
    - Queue overflow (`inputQueue.push`, `room.go:139-145`, 120 entries, drops the oldest): those seqs are never applied, and a later `ackSeq` passes them. They lie at or below `ackSeq`, so the replay never includes them. The reconciled state is the server's truth without them, and the client sees one larger correction (visual offset, below).
    - Inputs numbered while disconnected are never sent, so they behave like dropped inputs; the reconnect's welcome resets (below).
  - `castOffSeq`, `noteCastOff`, `forgetCastOff` go away: the replay carries the cast-off flag itself.
- **`ServerLink.sync` keeps every transition it has today** (`link.ts:41-67`). New signature: `sync(prev: BoatState, curr: BoatState, shown: ShownPose | null, alpha: number): SyncResult`, with `type ShownPose = { x: number; z: number; heading: number }` (the pose drawn last frame, i.e. `lastPose` in `main.ts`, offset included) and `type SyncResult = { kind: 'steady' } | { kind: 'respawned' } | { kind: 'moved'; prev: BoatState; curr: BoatState }`. Handled in this order each frame:
  1. **Rewelcome, new boat** (`!w.resumed`: a fresh spawn, maybe a restarted server): `welcome = w`, `respawnSeq = 0`, adopt its config (`physics.setConfig`, as in step 3), `reconciler.reset(c.nextSeq)`, `spawn = { ...w.state }`, zero the offset, return `respawned`. `main.ts` then calls `resetBoat(server.spawn)` as now.
  2. **Rewelcome, resumed** (reconnect to the same boat): `welcome = w`, `respawnSeq = 0`, `reconciler.reset(c.nextSeq)` (drop all predictions; inputs sent on the old connection never applied), and adopt `w.state` as both `prev` and `curr`. Compute the offset (below), report `resync`, and continue to the snapshot check: a snapshot from the new connection may already be waiting.
  3. **Server respawn after our reset** (`respawnSeq` set and `snap.ackSeq >= respawnSeq`): `respawnSeq = 0`, `reconciler.reset(c.nextSeq)`, `spawn = { ...snap.state }`, zero the offset, return `respawned`. Acks below `respawnSeq` cannot undo the reset: `reset()` already set `minAck = respawnSeq`, so `reconcile` returns null for them.
  4. **Snapshot**: `reconcile(snap, c.nextSeq - 1)`. Null → `steady` (or `moved` with the welcome timeline if step 2 adopted one). A timeline → compute the offset, return `moved`.
  - `ServerLink.reset()` (Esc menu respawn) keeps `sendReset`, `respawnSeq = c.nextSeq`, `reconciler.reset(respawnSeq)`.
  - The very first welcome is handled by the constructor as today (`spawn = welcome.state`, fresh `Reconciler` with `minAck = 0`).
- **`main.ts` on `moved`**: set both `prev = r.prev` and `curr = r.curr`, so interpolation runs entirely on the reconciled timeline. Interpolation and the offset then never correct the same error twice. On `respawned`, `resetBoat(server.spawn)` as now (it already evaluates).
- **Diagnostics after reconciliation**: a `moved` result changes `curr` without a local step (an adopted snapshot or welcome, or a zero-length replay). Right after handling it, set `diagnostics = physics.evaluate(curr, lastApplied)`, so the HUD, force vectors, sail luff/stall and sound match the reconciled state. Steps run later in the same frame overwrite it as usual.
- **Visual offset, computed against what was on screen**:
  - Inside `sync`, with `alpha` = the `fixed.alpha` the last frame was drawn with (unchanged until this frame's `fixed.advance`), let `candidate` = the reconciled timeline interpolated at that alpha (`lerp` x/z, heading `prev + wrapPi(curr − prev) * alpha`).
  - `offset = { dx: shown.x − candidate.x, dz: shown.z − candidate.z, dHeading: wrapPi(shown.heading − candidate.heading) }`. Use `wrapPi` from `src/sim/frames.ts` for every heading difference. `shown === null` (no frame drawn yet) gives a zero offset.
  - If `hypot(dx, dz) > 2` m or `|dHeading| > 20°` (the old `SNAP_DISTANCE`/`SNAP_HEADING`), zero the offset (a snap) and count it. Otherwise it replaces the previous offset; it already includes the old remainder, because `shown` did.
  - Each frame, `ServerLink.decay(dt)` multiplies the offset by `exp(-dt / OFFSET_TAU)`, with `OFFSET_TAU = 0.2` s (replacing `BLEND_SECONDS`). This is exponential smoothing, not a fixed-length glide: about 37% of the offset is left after 0.2 s and 5% after 0.6 s. Below 1 mm and 0.001 rad it is set to exactly zero. Offline the offset is a constant zero.
  - The sim state is always the reconciled one; the offset is render-only.
- **Apply the offset in one place, the render pose**: `interpolatePose` (`src/render/pose.ts`) takes a new last parameter `offset: Readonly<{ dx: number; dz: number; dHeading: number }>` and adds it to the returned `x`, `z` and `heading`. `main.ts` passes `server ? server.offset : ZERO_OFFSET`. Every boat-attached visual reads that pose, so all of them move together:
  - The hull, rig, sail cloth and telltales: `SceneView.render` places the boat group from `pose.x/z/heading` (`scene.ts:215-221`), and they are children of it (`b.update(pose)`).
  - The cockpit camera, the lap chart and the hand compass: they hang off the sailor's eye, which is inside the boat group (`scene.ts:167` `this.boat.sailor.eye.add(this.camera)`).
  - The outside orbit camera (`scene.ts:265`, from `pose.heading` and the boat position).
  - The wake stem, the bow emitter and the hull contact (`render/wake.ts:126-168`, `render/wake/contact.ts:48-79`), the mooring lines (`scene.ts:234`), the gust map centre (`scene.ts:243`) and the remote-boat ranking (`scene.ts:231`).
  - Do not apply it to sim-side readers of `curr` (navigation speed over ground, hints, quest distances), which must see the true state.
- `ServerLink.describe` reports `last correction <replay|resync>[ snap] <cm> <deg>` (the offset size at reconcile time, before any snap zeroing), plus counts of replays, resyncs and snaps.
- Rewrite `src/net/correction.test.ts` (Reconciler) and add `src/net/link.test.ts` (ServerLink with a stub `NetClient` exposing `takeRewelcome`, `takeSnapshot`, `nextSeq`, `sendInput`, `sendReset`), using the real `Physics` loaded from `public/wasm/sim.wasm` (same loader as `wasm.test.ts`). Cases:
  - (a) no-loss snapshot matches the recorded prediction: no physics calls and no timeline/offset change; ack advances and old entries are pruned. Cover equality, the 1e-9 boundary, a just-outside mismatch, wrapped heading, boolean/boom-side mismatch, and non-finite fields;
  - (b) a mismatching snapshot from before a cast-off is replayed through it, and the boat stays unmoored; matching pre-cast-off snapshots skip replay and also leave it unmoored;
  - (c) a gap in the ring adopts the snapshot, sets `minAck`, and later recorded seqs still replay;
  - (d) after `reset()`, acks below `respawnSeq` return null and the first ack ≥ `respawnSeq` returns `respawned` with `spawn = snap.state`;
  - (e) recorded controls are clamped: recording `{tiller: 1.7, sheet: -0.2, hike: 2}` stores `{1, 0, 1}`;
  - (f) an `ackSeq` that skips over seqs (queue overflow) replays only the seqs after it;
  - (g) a stale snapshot (`ackSeq <= lastAck`) and a reordered one are ignored;
  - (h) a non-resumed rewelcome returns `respawned`; a resumed one returns `moved` with the welcome state and a fresh ring;
  - (i) a `shown` pose 0.5 m off the reconciled candidate gives offset 0.5 m; 3 m gives zero offset plus a snap count; a heading difference across ±π is wrapped (e.g. 179° vs −179° gives 2°).
  - (j) replay replaces recorded predictions: the next matching snapshot skips replay; an absent acknowledged prediction with complete unacked inputs takes the replay path, not a false match.

## Critical files & anchors

- `server/sim/step.go`: `Step` (l.326), `Evaluate` (l.134); JSON-tagged `Diagnostics`. The bridge wraps exactly these.
- `server/sim/waves.go`, `server/sim/config.go`: which wave fields are inputs vs derived (`components`, `amplitudeLimit`), and whether `SetWaveParameters` mutates a package global. Decides `setConfig`'s normalization.
- `src/main.ts:50-125, 355-425`: config choice, `resetBoat`, the fixed-step loop and every per-frame diagnostics consumer.
- `src/net/correction.ts`, `src/net/link.ts:40-110`: corrector and `afterStep`/`sync`, replaced in step 4.
- `scripts/goldenTraces.ts`, `server/sim/golden_test.go`: scenario definitions to port and the fixture format the wasm test reads.

## Verification

- **Step 1**:
  - `npm run build:wasm` produces `public/wasm/sim.wasm`. Record its size (`ls -l`) and gzip size (`gzip -c public/wasm/sim.wasm | wc -c`).
  - `npx vitest run src/physics/wasm.test.ts` passes, comparing wasm against the Go fixture.
  - Renaming a state field in the Go table makes the bridge throw `physics layout mismatch`; revert after the check.
  - `npm run build && go run ./server/cmd/sailserver -static dist` serves `wasm/sim.wasm`; `curl -sI localhost:8080/wasm/sim.wasm` shows `Content-Type: application/wasm` (unverified, confirm first; if it shows another type, register it with `mime.AddExtensionType(".wasm", "application/wasm")` at sailserver start-up).
  - `go test ./server/...` passes after the `ClampControls` move (golden traces unchanged).
  - With `npm run dev` running, save a `server/sim/*.go` file three times within a second: the vite terminal shows exactly one wasm build and one reload. A syntax error in the save shows the Go error and no reload.
- **Step 2**: `npm run dev`, open `http://localhost:5173/?physics=compare&offline`, sail 3 minutes with waves and gusts on, cast off from the berth once, and toggle two debug-overlay physics controls (e.g. a layer and the wave amplitude). The console's `physics compare` lines stay at max |Δ| ≤ 1e-9 throughout, including the cast-off step and after each overlay change (a jump there means the config or cast-off sync is missing). Repeat against `npm run server` with `?server=ws://localhost:8080/ws`. Then stop and report the numbers (see the gate under Approach).
- **Step 3**:
  - `npm run typecheck && npm run lint && npm test && go test ./server/...` all pass, including the migration-only `TestFrozenTSGolden` and the `golden-ts` wasm case (native Go and wasm still match the frozen TS output).
  - `src/sim/renderParity.test.ts` passes, including gusts over time.
  - `npm run polar -- --tws 9` writes `polar-out/polar.csv` and prints the 9 kn Day comparison as before.
  - In the game (online and offline): cast off, sail to H1, grounding near the shore and the debug overlay layer toggles (offline) behave as before.
  - The overlay's Network section shows corrections at ~0 cm with no snaps on localhost. Then stop for the step 3 gate.
- **Step 3b**: `go test ./server/...` and `npm test` pass; `grep -rn "MIGRATION-ONLY" server src` prints nothing.
- **Step 4**:
  - `npx vitest run src/net/correction.test.ts src/net/link.test.ts` passes, with cases (a)-(j) above.
  - Add a `src/render/pose.test.ts` case: with an offset `{dx: 1, dz: -2, dHeading: 0.1}`, `interpolatePose` returns x/z/heading shifted by exactly that, and the sim-state values it was given are unchanged.
  - Against the server through an 80-160 ms jittered proxy (the setup `docs/DESIGN.md:139` describes), matching snapshots cause no replay and no visual correction; genuinely mismatching snapshots replay, with no snaps while sailing normally. Verify that the matching fast path makes zero physics calls.
  - Short drop: block the socket for under a second; on reconnect the readout shows one `resync` under 2 m. The boat eases into place, most of the way within about half a second (exponential, 0.2 s time constant). The HUD speed and sail luff readouts update in the same frame as the resync, not one step later.
  - Long drop: keep the socket closed for 10 s or more while sailing. On reconnect the readout shows one `resync snap`, and the boat jumps to the server position at once with no glide (the error is over 2 m; that is the intended behaviour).
  - During the short-drop easing, in cockpit and outside view: the camera, sail cloth, telltales, wake start and mooring lines move with the hull, with no part lagging or jumping separately.

## Assumptions & contingencies

- **Frozen TS fixtures** are small JSON files. They are removed in step 3b only when the user approves step 3; if the user prefers to keep them longer, skip step 3b and leave the `MIGRATION-ONLY` tests running.

- **Bit-identical native vs wasm is not assumed.** The Go compiler fuses `x*y+z` into FMA on arm64 (dev Mac, arm64 server image) but not in wasm or amd64, so results can differ in the last bits. All parity checks use 1e-9; step 4's replay keeps any drift to a few steps. If step 2 shows per-step |Δ| above 1e-9, find the expression (largest Δ field first) and wrap its products in explicit `float64(...)` conversions (Go's spec forbids fusing across an explicit conversion), then regenerate fixtures.
- **Download size**: standard Go wasm is expected around 2-3 MB raw, ~0.6-1 MB gzipped (estimate). If gzipped exceeds 1.5 MB, keep standard Go but check what pulls size in (`go tool nm -size -sort size`); moving `challenges.go`/`buoys.go` out of `server/sim` into the server packages is the first cut. TinyGo is not a fallback: it would break the "same compiler as the server" goal and `encoding/json` loading.
- **Per-step call cost**: if step 2's mean wasm step exceeds 100 µs, batch: add `stepMany(io, n)` taking n control triples and returning the final state, used by the replay; the fixed step keeps single calls.
- **Load failure**: no TS physics remains after step 3, so a browser without WebAssembly gets the error banner instead of a degraded game (all target browsers support wasm).
- **Server code is unchanged**: `server/netsim` and `server/sim` behave the same; the only Go additions are `server/cmd/simwasm` and the golden generator test.
