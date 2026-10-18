# TODO

- [ ] Update project README (with new deployment commands): push to main → CI publishes ghcr.io `:latest` →
      podman-auto-update on the box (deploy/box/, install.sh) restarts within 5 min; document `?quality=low|high`
      and `?perf=1`

## Physics

- [ ] Profile why a wasm step is ~14× slower than native (~220 vs 15 µs), mostly wave sampling.
      Try computing each wave component's time-dependent terms once per step and reusing them for
      every sample point; check whether Go's pure-Go math implementation in wasm is the cost.

## Rendering

- [ ] Profile on a weak machine (older Intel iGPU) with `?perf=1`; let the per-pass GPU split drive the items below.
      M1 headless baseline: far 4.5 ms, near 3.1 ms, reflection 0.05 ms GPU at 1706x960, high preset
- [ ] Bake the 8 ripples into a tiling normal map; keep the 3 big Gerstner waves analytic (only if profiling says so)
- [ ] Tree impostors (cross billboards) past about 1 km, if trees show up in profiles
- [ ] Check `detectQuality` on real browsers: a hidden GPU name (Firefox resistFingerprinting, some Safari setups)
      falls back to `low`
