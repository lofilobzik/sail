# Sailing Sim: Design

Read this file at the start of every session. Read `PHYSICS.md` before touching anything in `sim/`.

## What this is

A first-person, realistic sailing simulator that runs in the browser as a static site.
One sailor, one boat (Laser / ILCA 7), a bay with islands, light gusty wind.
Failure is the teacher: there is no auto-trim and no auto-hiking. The world gives honest
cues (telltales, luffing, heel, water), and the player learns to read them.

Long-term direction (not v1): a cruising / navigation / management layer on a bigger boat.
Keep the boat data-driven so that is possible later.

## v1 scope

- Free sandbox in a bay (see "The bay"): shores, two islands, towns and landmarks, with a few buoys
  to navigate between. Headless runs and the polar sail in endless open water (`cfg.land` off).
- Boat: Laser (ILCA 7), procedurally generated to class dimensions.
- Wind: default 7 knots mean, always read through `getWind(position, time)`. Debug range 0-16 kn;
  6-8 kn remains the intended light-wind sailing range, stronger settings are exploratory.
  In the browser the wind has seeded gusts and slow direction shifts (`?gusts=0` for a constant wind):
  gusts are patches carried downwind by the mean wind, so a patch seen darkening the water arrives at
  the boat later, and the wind direction oscillates a few degrees over minutes. Gusts veer slightly.
  Headless runs and the polar keep the constant wind. Waves and clouds follow the mean wind only.
  All gust and shift numbers are TUNING GUESS values in `data/wind.json`.
- Waves: two data-driven Gerstner bands, broad waves plus fine ripples, shared by physics and rendering.
  Wind speed controls height and length; seeded strengths/phases produce uneven crest groups without
  per-frame randomization. Ripples use eight weaker, downwind-biased components with seeded wavelength
  and direction variation rather than four widely crossing wave trains that formed a regular lattice.
  The browser chooses a new pattern on reload; headless runs stay deterministic.
  Surface slope rocks the boat; orbital flow at each foil can deflect the course. Overall amplitude,
  separate big-wave/ripple multipliers, broad period and direction controls are in the debug menu.
  Spectrum, wind scaling and response tuning are TUNING GUESS, not a calibrated sea-state model.
- No planing, no capsizing. Heel clamps at a limit.
- First-person camera only; vertical cockpit field of view 85 degrees.
- Controls: mouse look, keyboard for tiller / sheet / hiking.
- Navigation: compass plus a paper-style chart with a drifting dead-reckoning marker,
  corrected by bearings to buoys and landmarks ashore.
- Visuals: as realistic as an integrated laptop GPU allows, at one fixed quality level. There are no
  quality tiers: every effect is built cheap enough to run everywhere.

## Non-goals for v1

Full wave/buoyancy dynamics, capsize and recovery, racing and AI boats,
multiplayer, planing, other boats, a cruising or management layer, mobile and touch input,
full sailor body and hiking pose (hands, tiller extension and mainsheet only in v1).

## Stack

Vite + TypeScript + Three.js for the browser (static build output). Go for the authoritative
server (optional: the browser still runs fully offline without it).

## Architecture

```
src/
  sim/      Pure math. NO Three.js imports, no DOM. Deterministic.
            state + inputs + dt -> new state. Offline play and client-side prediction.
  render/   Reads sim state, draws it. Never writes to sim state.
  input/    Keys / mouse -> normalized control values (tiller, sheet, hike, look).
  nav/      Chart, dead reckoning, bearings (reads sim state, own state for DR).
  net/      Browser client for the Go server (joined by default on the built site): input up, snapshots down,
            local TS prediction corrected toward server state.
  debug/    Overlay: apparent wind, force vectors, speed, heel, polar plot.
  ui/       Esc menu, first-time look guides, player preferences (localStorage). Reads render/sim, never writes sim.
  audio/    Procedural Web Audio cues from boat speed, apparent wind and luff. Reads only.
data/       JSON config shared by TS (Vite imports) and Go (data/embed.go, go:embed). No magic numbers in code.
server/     Go module `sail` (go.mod at the repo root).
  sim/      Go port of src/sim: the authoritative simulation (no render helpers). Golden fixtures
            from TS in sim/testdata/golden/ keep the two within tolerance.
  netsim/   WebSocket protocol and per-connection sessions.
  cmd/sailserver/  The server. cmd/polar/  Go port of scripts/polar.ts.
scripts/
  polar.ts         Headless: sails the boat at fixed headings, dumps a polar. Runs in Node.
  goldenTraces.ts  `npm run golden`: writes the TS golden fixtures the Go tests compare against.
docs/   Source papers and rules. See INDEX.md.
```

Rules:
- The sim runs on a **fixed timestep** (start at 60 Hz, raise if unstable). Rendering interpolates.
- `sim/` must run headless under Node, so the polar script and tests work without a browser.
- Boat parameters live in `data/laser.json`, not in code. A second boat should be a new config file.
- Every constant is either sourced from `docs/` or marked `// TUNING GUESS`.
  Do not recall coefficient tables from memory.
- **Two simulations, one model.** `src/sim` (TS) and `server/sim` (Go) implement the same physics.
  The server is authoritative; the TS copy predicts locally and is corrected toward server snapshots.
  They are not bit-identical (V8 and Go math differ in the last bits); `npm run golden` exports TS
  traces and samples, and `go test ./server/sim/...` checks the Go port against them within stated
  tolerances. Any physics change goes into both, then regenerate the fixtures. The server owns the
  seed and config; clients take them from the welcome message.
  **Touch both implementations.** When you change anything under `src/sim/` or `server/sim/`, change
  the matching code on the other side in the same commit:
  1. Edit the TS file and its Go counterpart (`src/sim/layers/foils.ts` ↔ `server/sim/layer_foils.go`,
     `src/sim/step.ts` ↔ `server/sim/step.go`, and so on).
  2. A change to the headless polar goes into both `scripts/polar.ts` (with `scripts/lib/`) and
     `server/cmd/polar/`.
  3. Run `npm run golden`, then `npm test` and `go test ./server/...`. A pure refactor must leave the
     regenerated fixtures byte-identical (`git status` shows no change under `server/sim/testdata/`).
- Water follows the boat continuously, but wave phase stays anchored to world coordinates.
  Only the flat-water debug grid snaps. Filter rendering detail to mesh/pixel resolution.
  A **render-side floating origin** follows the interpolated boat every frame, without threshold jumps.
  Simulation/navigation coordinates stay in logical-world doubles. Boat, cameras, water and debug
  arrows use small render-local coordinates; fixed buoy and land transforms are rebased before GPU upload.
  Reduce each wave's origin/time phase in double precision before the shader adds local spatial phase.
  Wake history is world-anchored: `render/wake/trail.ts` stores logical-world doubles and subtracts this
  same origin only when packing GPU uniforms.

## Server and networking

- Which server a page joins (`src/net/link.ts` `serverChoice`): the **built site** (dinghysail.ing)
  joins its own host's `/ws` by default; **`npm run dev`** sails offline unless `?server` is given
  (`?server=ws://localhost:8080/ws`, or a bare `?server` for the page's own host); **`?offline`**
  always sails locally. A server that refuses, closes or doesn't send its welcome within 5 s (TUNING
  GUESS) gets a short "sailing offline" note and the page plays offline. Run the server locally with
  `npm run server` (Go, `-addr :8080`, optional `-seed`, `-snapshot-hz 20`, `-static dist` to also
  serve a built site). `GET /healthz` answers `ok`.
- **Deployment**: one container image (site plus server) built by GitHub Actions, published to GHCR,
  and pulled by podman-auto-update on the home box behind a Cloudflare Tunnel at dinghysail.ing.
  See `DEPLOY.md`.
- **One public room** (multiplayer v1, `server/netsim/room.go`): one seed and `BrowserConfig` per
  server process, one room clock (`tick`), and every boat stepped in the same fixed-step loop owned by
  one goroutine; connections talk to it over channels. New boats and resets spawn at the room time at
  the first free slot of a 15 m grid around the departure point (TUNING GUESS), all in deep water.
  `-max-boats` (default 32) caps the room ("room full", close 1013). No names, no races, no
  collisions or wind shadow: other boats are visual only. 32 boats cost about 1.1 ms per tick on an
  M1 (about 8% of one core with snapshots).
- **One sim step per input**: each boat queues its inputs (and resets) in seq order and applies
  exactly one input per sim step, so the server's state after input N is exactly the client's
  prediction after input N, whatever the network jitter. A boat with no waiting input does not move,
  so its own clock (`state.t`) runs behind the room clock by the inputs' travel time. Per tick a boat
  earns 1.01 steps (1 % for a client clock that runs a little fast) and may catch up at most 15
  queued inputs at once after a gap; its queue holds 2 s and drops the oldest beyond that, so a
  client sending faster than real time gets lag, not speed. All TUNING GUESS. Through a proxy adding
  80-160 ms of jittered round trip, hard steering gave 0.0 cm corrections and no snaps.
- **Protocol** (WebSocket `/ws`, JSON text frames; `server/netsim/protocol.go`, `src/net/protocol.ts`):
  server sends `welcome` (id, resume token, resumed, seed, full config, dt, tick, state, snapshotHz),
  then `snapshot` (tick, ackSeq, state, applied controls, and `boats`: every other boat's pose,
  controls, apparent wind and luff) at 20 Hz, and `error` for a rejected message (the connection
  stays open). Client sends `input` (strictly increasing seq, controls) every local fixed step, and
  `reset`. Origins: same-origin (the deployed site) plus localhost on any port (Vite dev).
- **Reconnect**: a dropped boat is parked for 60 s under its resume token (`/ws?resume=…`). The client
  retries after 1, 2, 4, 8, then every 10 s, and also when no data arrives for 3 s (a silent socket).
  Resumed: same boat, navigation kept. Otherwise (expired, or a restarted server with a new seed): a
  fresh spawn, the new config adopted in place, navigation restarted. Leaving the page closes the
  socket at once (`pagehide`), so the boat disappears for others immediately.
- **Client prediction** (`src/net/correction.ts`): the TS sim predicts every step; each snapshot is
  compared with the prediction recorded for its acked input (256-step history), minus corrections
  applied since. Small errors blend out over 0.2 s; over 2 m, 20 degrees or a different boom side the
  state snaps; an ack older than the history resyncs. All TUNING GUESS. No rewind/replay yet.
- **Other boats** (`src/net/remote.ts`, `src/render/remoteBoats.ts`): buffered per boat and drawn
  0.1 s in the past (TUNING GUESS), interpolated with heading wrap, holding the last pose if snapshots
  stop; server time is estimated from arrivals. Each is a full boat mesh on the waves with its cloth
  sail, rudder, boom and crew, but no wake and no first-person arms. Only the nearest 4 sails within
  150 m run the cloth every frame; the others take turns (24 remote boats: about 17 ms per frame in
  headless Chromium).
- **Navigation per player**: the known departure is the spawn the server announces (welcome
  `state`), so `Navigation.reset` and the chart take it instead of the fixed start (offline still
  uses `NAVIGATION.start`). Nobody sees other players' charts or bearings.
- In server mode the debug panel's physics controls are read-only (the server owns config); Reset
  respawns at a free slot. The panel's Network section shows status, round-trip time, the last
  correction, own id, room boat count and reconnect attempts.
- Checked on localhost: two tabs see each other within the 15 m spawn grid; RTT about 8-13 ms;
  corrections about 1 cm with no snaps; a leaving tab disappears at once; a server restart
  reconnects within about 1 s as a fresh spawn in the new world.
  Deferred: remote wakes, extrapolation, names, rooms, collisions, rewind/replay reconciliation.

## Controls

| Input | Action |
|---|---|
| Mouse | Look around (pointer lock) |
| A / D | Tiller (hold to move, stays where released) |
| C | Centre tiller at its normal movement rate |
| W / S | Ease mainsheet / sheet in, holds position |
| Mouse wheel up / down | Sheet in / ease mainsheet in small steps, holds position |
| Shift (hold) | Hike out (lean weight out), release to sit in |
| F (hold) | Take a reading; where you look decides which. Looking astern at the wake (no mark under the crosshair) judges boat speed. Anything else raises the yellow hand-bearing compass for a bearing: the buoy or landmark under the crosshair names itself, and lined up with the bow, tilted down, the bearing is your course. A mark astern is still a bearing |
| B (hold) | Raise the binoculars: the view glides to 10x through a two-lens mask, mouse look slows to match, and lowering them glides back. For checking landmarks from afar; bearings still come from the compass (F), and B is ignored during a reading and F while the glasses are up |
| R | Reckon, with the chart in view: plot bearings taken since the last plot (a fix), otherwise the dead-reckoning leg |
| H | Toggle test instruments (hidden by default) |
| M | Mute / unmute |
| G | Debug free-fly camera: WASD fly along the view, E up, Q down, Shift fast, mouse look turns it in world space. The boat sails on with neutral controls. B (hold) raises the binoculars here too. G or V returns to the cockpit. `?fly=x,z,height[,bearing[,pitch]]` opens already flying |
| Esc | Menu: controls, volume, sail design, respawn, reset hints. The sim keeps running |

Inputs are **continuous with rate limits**: no snapping. A tiller key ramps the tiller over a
fraction of a second and holds its position. Same idea for the sheet.

## Visuals

- **Water:** one Gerstner model in `sim/waves.ts`, with parameters in `data/waves.json`, supplies
  CPU sampling and shader displacement/analytic normals for both broad waves and ripples.
  Unequal lengths/directions and seeded strengths/phases break up wave trains; ripple spacing and
  angles also vary by seed, with nearby wavelengths producing uneven beat groups.
  A uniform near-boat patch and growing
  outer grid follow continuously without moving world-space phase. Mesh-cell filtering prevents
  unresolved displacement; per-pixel normals and footprint/specular filtering prevent distant shimmer.
  Physics responds to slope and foil orbital flow; visual heave follows surface height, without a
  vertical buoyancy-force simulation.
- **Surf, whitecaps and glow (visual only, `render/water.ts`):** all per-pixel arithmetic on values the
  shader already has, with no extra texture reads, and branched off where they do not apply (measured
  within noise of the old shader: about 13.5 vs 13.0 ms at 2880x1454 on an M-series GPU). Pixels over
  shallows (seabed depth under 2.2 m) get a swash line of foam that breathes up and down the shore plus
  trailing lines; whitecaps break off the highest crests once the wave amplitude scale passes 1.25
  (about 8 kn) and thicken to 2.0; light scatters through crests toward a viewer looking at the sun.
  The sea's surface slope is damped to 40 % toward the horizon, because at grazing angles a degree of
  ripple tilt otherwise streaks the reflected sky with white scratches (`GRAZING_*`). Ripples now fade
  at 14 to 7 samples per wavelength instead of 8 to 4. Constants are VISUAL ESTIMATE / TUNING GUESS.
  `?start=x,z[,heading]` places the boat anywhere offline to look at a shore or shoal.
- **Wake and bow wave (visual only):** the water shader adds a Kelvin wake (transverse and divergent
  waves, 19.47 degree cusp), a bow wave hugging the waterline, and turbulent foam behind the transom
  and on the bow crest. Only new bow emissions follow the foremost hull/sea contact using heave,
  pitch and heel. Each emitted front retains its birth contact in logical-world doubles, propagates
  outward and fades independently; lifting/dropping the bow cannot relocate the older V. Smooth
  birth/expiry and bounded overlap blend successive contributions without a live-anchored V fallback.
  Kelvin sits at `visualGain = 0.8`; bow height uses `bowHeadFrac = 0.30` and `bowLength = 5` for a more prominent
  bow V (1.875x the previous 0.16 height, arms attenuate more slowly). Both are visual TUNING GUESS values; no sim forces change.
  Bow fronts are circular crest/trough packets whose steady-motion envelope forms a V. This is a
  nondispersive visual approximation, not calibrated pressure-wave physics or shoreline breaking.
  `render/wake/bowField.ts` rasterizes a bounded world-grid cache to a reusable float texture; water
  samples it at constant cost, with screen-derivative normals and no per-pixel history search.
  Bow foam uses its emitted front's source height/speed, with continuous crest coverage and the same
  noise patch breakup as stern foam, so both foams share one grain scale. It starts at the bow emission speed
  threshold independently of stern turbulence. Stern foam appearance remains unchanged.
  Height, foam and lifetime/resolution parameters are explicit TUNING GUESS values in `wake.json`.
  Parameters in `data/wake.json`; math in `render/wake/` (no Three.js, tested);
  debug toggles for the three components, "wake: Kelvin waves", "wake: bow V waves" and "wake: foam (bow +
  stern)", each a shader-side switch (the trail and bow field keep their history, so switching back shows
  the true wake), and `?wake=0` to start with the whole wake off.
- **Sky:** one analytic sky function (`render/sky.ts`, adapted from three's examples Sky: Preetham
  daylight scattering, sun disc, procedural clouds) is the sky for everything. The dome shades with
  it, the water reflects it per pixel and the water's distance fog blends toward its horizon colour,
  so the horizon, sun and clouds always agree. Pure atmosphere math, the horizon fog colour and sun
  light tint are in `render/skyModel.ts` (tested); parameters in `data/sky.json`.
  The sun is fixed in play (default elevation 59, bearing 124, the old light direction); set it with
  `?sunElevation=`, `?sunAzimuth=` or the debug panel. Light colour and strength follow the sun
  (warmer and dimmer low, off below the horizon). Clouds drift with the true wind (`?clouds=0..1`
  coverage, debug panel) and are the only moving part. The cloud noise is a seeded 256 px tiling
  texture read with hardware filtering rather than Sky.js's per-pixel hash, which cost about 2.8 ms
  per frame on an M1; the whole sky is about 1 ms. The dome draws last at the far plane so water and
  boat pixels skip it. No screen-space reflections, no heavy post-processing, no renderer tone mapping.
- **Land** (`render/land/`, all VISUAL ESTIMATE): built once at startup from the shared terrain grid.
  The terrain is 64x64-cell tiles (about 360k triangles, culled per tile) with vertex colours for
  seabed sand, wet/dry beach, grass, scrub, woodland floor and rock; about 4.6k instanced trees in
  clumps; about 440 instanced houses with pitched roofs in the three towns and scattered along the
  shore; and the four landmark models. Land draws before the water so hills reject hidden water by
  depth, and fogs toward the sky's horizon colour like the water. The water shader reads a baked
  seabed-height texture and tints the shallows sand/turquoise. To see land across the bay the fog
  runs 0-9 km, the water mesh is 40 km across, the dome radius is 25 km and the far plane 30 km;
  the frame is drawn in two depth passes (near plane 2 m, then 5 cm for the nearest 2 m; see below) so
  distant shorelines do not z-fight. Measured on an M1 the bay adds well under 1 ms per frame (within noise).
- **Boat:** procedural hull lofted from a few cross-sections using class dimensions,
  plus spars and fittings. Low triangle count.
- **Sail:** cloth-like visual (small Verlet grid, around 20x12 points, pinned along luff / foot).
  **It is visual only.** Sail forces come from the foil model in `sim/`. The sim exposes a
  `luffAmount` value (0 = trimmed, 1 = fully luffing) and the cloth reads it to flutter.
  The cloth never feeds back into forces.
  **Sail designs:** printed sails are generated procedurally, never loaded from an image. Each design in
  `data/sail-designs.json` is a stack of layers (fill, gradient, polygon, stripes, rays, star, circle,
  tiled pattern) in sail space (x across from the luff, y from the foot up), drawn once onto a canvas by
  `render/sailDesign.ts` and cached by `render/sailPaint.ts`. The cloth grid carries UVs in true cloth
  metres, so a circle stays round as the cloth moves. A design may set its own opacity and glow; a seeded
  panel-seam and speckle finish goes over all of them. Pick one with the debug panel's "sail design"
  dropdown or `?sail=<id>`; edit or add designs in the JSON (a typo throws an error naming the design and
  layer). Printed cloth is mirrored on its reverse side, as real printed sailcloth is, so text such as
  `:3` reads backwards when seen from the other side. The default is the plain white class sail.
- **Sailor:** v1 shows hands, tiller extension and sheet. Full body and hiking pose come later.

## The bay

- **Layout** (`data/bay.json`, all VISUAL ESTIMATE): a horseshoe bay about 3.9 km east-west and
  4.4 km north-south, open to the south through a 2.6 km mouth between two headlands. Great Holm
  (about 1.3 x 0.7 km, 75 m hill with a stone tower) lies in the north-west of the bay, Little Holm
  (about 380 x 280 m) toward the mouth in the east. Two shoals (Holm Spit, Little Holm Ledge) rise to
  0.3-0.5 m. Westcove Harbour (below) is the departure; every buoy is in 10-21 m of water.
- **Window and door fade** (`render/land/detailFade.ts`): once a metre spans fewer than 6 pixels on
  screen, a house's windows, doors and their trim blend toward the wall colour, gone by 2.5 pixels. Smaller
  than that a dark pane in a pale frame cannot be sampled cleanly and breaks up into jagged shapes as the
  camera moves. Every house vertex carries a `baseColor` (the wall's for details, its own otherwise) and a
  vertex-shader hook on the buildings material blends toward it by on-screen size, so the binoculars bring
  the detail back. `?detailfade=0` turns it off.
- **Faceted look without `flatShading`**: houses and trees get their per-face normals baked into the
  geometry (`faceted` in `render/land/parts.ts`) and their materials do not use `flatShading`. Three's flat
  shading guesses each pixel's normal from screen-space derivatives of the position, which shimmers on
  faces only a few pixels across: bright far houses and broadleaf trees blinked through binoculars while
  the dark firs, on dark ground, hid it. Baked normals look the same and cost less.
- **Trees and the forest belt** (`render/land/trees.ts`, `forest.ts`): trees cover all the land, from a
  jittered 15 m lattice over the mainland and islands within 2.2 km of the water (about 83k trees, 81 %
  conifers). Density is about half on open ground, up to full in woods and the belt, with meadow clearings,
  none within 20 m of the water, thinner inside towns, and never on the beach, bare rock, steep ground,
  roads, house plots or within 25 m of the harbour works. Conifers are narrow, fir-like and dark; broadleaves
  fill the lowlands. The belt is a dense wall of tall (13 to 24 m, taller uphill), narrow, darker conifers that
  begins 22 m (ragged by 14 m) uphill of Hill Road, clearing the uphill houses, climbs the hill, thins
  out between 380 and 520 m up and fades at both ends of the road; it also darkens the ground. Trees are
  grouped per 500 m square into LOD objects (full model within 1000 m of a square's centre, a trunkless
  two-tier cone or an octahedron beyond; the far conifer keeps the near one's silhouette so the swap is hard to
  see, even through binoculars), so off-screen forest is skipped. Measured about +0.9 ms over the houses; 810k triangles
  and 290 draw calls looking east, 365k and 106 looking at the town.
- **Houses and roads** (`render/land/houses.ts`, `houseModels.ts`, `roads.ts`): Westcove has
  `layout: "roads"` in `data/bay.json`, so its houses stand in clusters along its two roads, Harbour Road
  (8 m contour) and Hill Road (20 m contour), set back 5-9 m, every front facing downhill toward the water.
  The roads are contour lines of the baked terrain, smoothed and stored as data, drawn as gravel ribbons
  0.1 m above the terrain mesh. Clusters come from seeded noise along each road side (about 55 % built,
  the water side more than the uphill side). The other towns and the scattered shore houses still place
  at random. Each house is built from a spec (cottage, two-storey or cabin; gable, hip, saltbox or lean-to
  roof; plinth, door, windows on all four faces, optional chimney and porch) into one vertex-coloured
  geometry; the bay's houses merge into one mesh per 800 m square. Palette: weathered Pacific Northwest
  (cedar and silver greys, faded sage, slate blue, rust, ochre) with a few saturated accents (barn red,
  mustard, teal, cobalt) on 8 % of walls and most doors. The quay, mole and terrace, plus 12 m around
  them, stay clear for the hand-built harbour front. Cost measured at 2880x1566: about 16.0 ms against
  14.75 ms before (+1.25 ms), 492k vs 474k triangles in the default view.
- **Westcove Harbour** (`data/bay.json` `harbour`): the starting town on the west shore, where every
  boat spawns (offline and on the server) at `harbour.departure` (-1740, 760), bow east, in a basin a
  breakwater mole shelters. The same elevation function carves it: `dredged` rectangles deepen the
  basin, `reclaimed` ones are flattened to a quay, the mole and a terrace for houses behind them
  (smoothstep blend of `edge` metres, applied in order; identical in `sim/terrain.ts` and
  `server/sim/terrain.go`). `render/land/harbour.ts` draws crisp paved slabs over the quay and mole
  (the 20 m grid alone rounds their faces into a short ramp), bollards, lamps, four finger pontoons
  and the Harbour Office, Sail Loft (the future shop and customisation) and Boat Shed with painted
  signs. PIER is the green-banded light on the mole head, a landmark for bearings. Buoys N, NE, E, SE
  and S are 0.65-1.1 km out from the harbour. `NAVIGATION.start` equals the departure (tested).
  Pontoons, buildings and moored boats are visual only: no collisions, and no shop UI yet.
- **One elevation function** (`sim/terrain.ts`, pure and seeded): a mainland polygon and island
  ellipses as signed distances, their coasts perturbed by fractal noise; beaches, then low hills
  modulated by noise ashore; a seeded 1:60-1:20 nearshore slope saturating at 28 m offshore.
  Physics evaluates it directly; the land mesh, the water's shallow tint and the chart use one grid
  baked from it at startup (`terrainGrid()`), so the chart, the land and grounding always agree.
- **Grounding** (`sim/layers/ground.ts`, PHYSICS.md "Grounding"): the seabed touching the daggerboard
  tip pushes the boat toward deeper water and damps it, so it stops within a few metres in the
  shallows and slides off again when the sheet is eased or it turns away. Toggle with `cfg.land`
  ("seabed grounding (bay)" in the debug panel); the debug panel shows depth and AGROUND.
- **Landmarks** for bearings: LIGHT (lighthouse on the east headland), SPIRE (church in Northhaven),
  TOWER (on Great Holm), MAST (radio mast in the western hills) and PIER (the harbour light). Towns (Northhaven, Westcove,
  Eastport) and scattered houses line the shore; trees clump on the grass. All of it is visual only:
  land does not shelter the wind or shorten the sea.

## In-world cues (no HUD)

Telltales on the sail, sail luffing and flutter, a masthead fly or burgee, water ripples
and cat's-paws showing wind direction, heel angle, and sound (luff flap, water rush).
The debug overlay is a developer tool, not a player aid, and is toggled off by default.

- **Sound** (`src/audio/sound.ts`): procedural, no samples. Water rush rises with boat speed, wind
  with apparent wind, and the sail flogs as loud as `luffAmount`, so a luffing sail is heard before
  it is seen. Starts on the first click or key press (browser autoplay rules); `M` or the menu mutes.
- **First-time guidance** (`src/ui/lookGuide.ts`) shows where to look, never what to think: a
  "click to look" mouse glyph while the pointer is free, then one guide at a time, a chevron at the
  screen edge or a steady ring when on screen, each with one plain word naming what the part is for
  (*tiller*, *wind*, *sail trim*). Triggers: the tiller after it is first pushed well over (it goes
  first and may interrupt a waiting wind guide, so the answer to "why did it turn that way?" arrives
  while the boat is still turning); the Windex after a few seconds of looking around; the telltales
  when the sail goes soft (the luff starts to flutter) for a couple of seconds, or after the player's
  first trim (W/S or the wheel; respawns never count), only while the boat is moving (stopped head to
  wind the Windex is the answer, and a stall looks normal, so it never triggers one). No text tips, no wind
  streaks or arrows in the world. A guide completes once its ring has been on screen for two seconds,
  is remembered in localStorage, and can be reset from the Esc menu. A guide ignored for 30 s steps
  back for a minute rather than nagging. Chevrons stay above the lap chart.
- **Esc menu** (`src/ui/menu.ts`) lists the sailing controls, with the instruments, outside view and
  debug panel set apart under Developer; the boat keeps sailing behind it.

## Navigation

- A physical paper-style chart on the sailor's lap, following the sailor between sides and while
  hiking. It is always there: look down to see it. No minimap, chart overlay, automatic camera
  movement or chart raised into view. It is read-only and driven entirely by the keyboard: the mouse
  only looks around (and clicks the debug panel). The chart frames the marker, its track, the course
  line, all the buoys and any landmark the next plot will use by itself. The bay is printed around
  them: buff land with a coastline, faint 50 and 100 m height contours, blue shallows inside the 2 m
  contour (where the board touches), 5 and 10 m depth contours, and the names of towns, islands and
  shoals. A landmark beyond the paper gets a pointer at the edge with its bearing and distance.
- **No instrument tells you where you are.** The boat has no log, GPS or deck compass. The only
  instruments are a yellow hand-bearing compass (modelled on a Plastimo Iris 50) and the sailor's
  eyes. There is no live position: the chart shows only the last position pencilled onto it, how
  long ago, and the sailor's doubt about it in metres (no circle is drawn).
- **Readings take time.** Hold `F` to raise the compass and hold it on a mark (a ring fills; pointing
  at the sky, or straying more than 10 degrees from your own recent mean aim, restarts it) to record
  a bearing. The boat rocks in the waves, which swings the aim a few degrees either way; the
  recorded bearing is the mean over the last 1.5 s, so a slow track on a mark works. The mark that
  was under the crosshair for most of the hold (at least 30% of it, so a rocking boat is forgiven)
  is named automatically. Lining the compass up with the boat's centreline, tilted down at least 8
  degrees toward the bow for most of the hold, takes a bow bearing, which is remembered as the
  course. Speed comes from the wake: press `F` looking astern (within about 50 degrees of straight
  back) with no mark under the crosshair; the kind of reading is fixed when the key goes down, and
  turning away from the wake restarts the ring. A remembered speed older than two minutes is flagged
  OLD on the chart, so the sailor knows to look at the wake again. A value is only taken when the
  ring completes, is not repeated until the key is released, and is kept with its age.
- **Remembered values are shown as faint text** in the lower-right corner (course, speed, and each
  bearing with its mark), never as an instrument. They are exactly true for now; no instrument
  error, magnetic variation or deviation is modelled.
- **One reckoning key.** `R`, with the chart in view, plots the bearings taken since the last plot if
  there are any named ones (a fix, about 4 s per line), and otherwise the dead-reckoning leg
  (about 5 s). Pencil work only progresses while you look at the paper; looking away pauses it
  where it was. A leg carries the last pencilled position forward by the remembered course and
  speed over the time since the last plot, ignoring leeway and anything that changed since the
  readings. A fix takes the newest named note of each mark, up to two: one projects the marker onto
  its line, leaving along-line error; two adequately separated bearings give an intersection fix.
  The marker only moves when the pencil work finishes. The doubt figure in the header grows with the
  length of each leg plotted on memory and shrinks again on a fix.
- **What the chart tells you, and nothing more.** The last plotted position is a simple pencil dot.
  Every earlier plotted position stays as a dot on a thin pencilled
  track. A dashed course line runs ahead of the dot with ticks at 1, 2 and 5 minutes at the
  remembered speed, and a little triangle points where the last bow reading says we are heading.
  Every mark always shows the bearing and distance from the last plotted position, so the chart says
  what to steer for; those figures go stale as the boat sails on until the next plot. Bearing lines
  are drawn only for notes the next plot will use; plotted ones are rubbed out. There are no grid
  numbers, track times or arrival times.
- **Marks identify themselves to the eye.** A sailor can read the painted ID of the buoy they are
  looking at, or recognise a landmark's shape, so a mark within 7 degrees of the line of sight counts
  as under the crosshair (buoys at half height, landmarks at 60% of their height). This uses only
  what the eye sees: the bearing still comes from the compass, and the boat's position is never
  used. There is no manual selection: a note taken with no mark under the crosshair stays unnamed
  and is not used for fixes. Buoys have matching physical painted IDs, distinctive colours and
  topmarks; buoys and landmarks are sandbox marks, not an IALA-marked course. The chart key shows
  every mark's symbol.
- **Bearing lines on the chart.** Each named note draws a pencil line from its mark back along the
  bearing, labelled with its angle; the ones the next plot will use are darker, and where two of
  them cross the crossing is marked. Lines are advanced by the remembered course and speed, so
  sailing between sightings is accounted for. Bearings expire after 180 simulated seconds;
  near-parallel lines (within 15 degrees), unnamed notes and bearings pointing away from their
  chosen marks cannot provide a fix. These limits are TUNING GUESS values.
- There is no "you are here" marker for the true position (a debug toggle may show it).
  The navigation estimator receives only instrument readings, never the true boat position;
  logical navigation coordinates are independent of the render-side floating origin.

## Milestones

One milestone per session. Commit after each working one.

0. **Scaffold:** Vite + TS + Three.js, folder structure, fixed-timestep loop, empty scene, lint/test setup.
1. **Full physics core on flat water (one big pass):** all of layers L1-L6 from `PHYSICS.md`: apparent wind,
   sail foil using the best-trim envelope from Day Table 1, daggerboard and rudder, hull resistance, heel
   and hiking, yaw dynamics. Optional extras behind toggles: sail twist (a few vertical slices), fore/aft crew weight.
   Box placeholder boat. **Every layer has a config toggle, a debug-overlay toggle, and a unit test.** The headless
   polar script must run with any layers disabled, so a wrong result can be bisected by layer.
2. **Tuning and validation:** run the polar, compare against Day (9 kn VPP, Figs 4-7), fix the sail falloff first,
   then foils, then drag, then yaw. Do not add features in this session.
3. **Boat graphics and test HUD:** procedural Laser (hull, deck, daggerboard, rudder, tiller and extension, mast, boom, sail,
   mainsheet), hands on the tiller extension and sheet, an instrument HUD (DOM overlay), and a minimal environment so motion
   is visible: a flat plane that follows the boat on a snapped grid, a plain sky colour, and a few buoys.
4. **Cloth sail:** visual cloth driven by `luffAmount`, telltales, masthead fly. Done.
5. **Water and sky:** shared Gerstner waves with physical rocking and orbital foil cross-flow implemented.
   Wind-responsive broad waves/ripples, separate layer controls and seeded magnitude variation implemented.
   Render-side floating origin and precision-safe world-anchored wave phases implemented.
   Analytic sky (sun, clouds, water reflection, horizon fog) implemented.
6. **Navigation:** yellow hand-bearing compass, wake speed reading, timed readings and plotting, faint
   remembered values, physical lap chart with doubt circle and bearing lines, identifiable buoys.
   Pure navigation tests cover timed holds, remembered values, leg plotting, bearing geometry, fixes and
   chart projection. Browser smoke checked pointer-locked readings, the memory text, plotting and lines.
   **Bay:** horseshoe bay with two islands, beaches and low hills, towns, houses and trees, four
   landmarks usable for bearings, a shallow-water tint, grounding on the seabed, and a chart printed
   with land, coastline, depth/height contours and place names. Tests cover fixes on landmarks and
   grounding (stops within a few metres, afloat, slides off when eased).
7. **Sailor body and hiking pose (post-v1, as scoped above).**
8. **Polish:** sound, tuning against the polar.

Later: full wave/buoyancy response, wind gradient with height and gusts that build the sea,
capsize, planing and stronger wind, third-person camera, cruising / management layer.

## Working agreement for the coding agent

- Read `DESIGN.md` and `PHYSICS.md` first. Do only the requested milestone.
- Keep `sim/` pure. If a change needs Three.js inside `sim/`, stop and ask.
- No invented constants. Cite a reference file or mark `// TUNING GUESS`.
- Keep a debug overlay up to date with whatever you add to the physics.
- After a physics change, run `scripts/polar.ts` and report the result.
- Every physics layer must be individually toggleable. Never merge two layers into one function that cannot be disabled.
- Prefer small files with clear names over large mixed ones.

## Open questions

- Lap chart placement/readability and navigation drift tuning await player feedback on the preview.
- Heel clamp value and what the clamp feels like at the limit.
- Wave response magnitudes are sanity-checked, not calibrated against measured Laser wave data.
  Tune by feel for now; measured response would be needed for calibration.
- Bay: grounding feel (push/damping are TUNING GUESS), chart framing (buoys plus landmarks in use,
  others pointed at from the edge) and landmark visibility (the spire is small from mid-bay) await
  player feedback. Depth is split in two passes (`render/scene.ts`): everything beyond 2 m is drawn with the near
  plane at 2 m, then depth is cleared and everything within 2 m (hands, compass, chart, near hull and a small
  water patch under the camera) is drawn again with the near plane at 5 cm, without the sky dome or the colour
  background (three clears colour whenever the background is a colour). One depth range from 5 cm to 30 km
  cannot be precise far away in a fixed-point depth buffer (reversed depth needs a float one and
  EXT_clip_control, which Firefox lacks; a float-depth render target fixed it in Chrome but was slow): window
  panes 3 cm proud of their walls z-fought into jagged shapes and far houses and trees flickered against the
  hillside. The renderer uses the standard depth mapping everywhere.
