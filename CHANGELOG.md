## Unreleased

- Port the as-tral/Criterion statistics engine into `assembly/engine.ts` (Apache-2.0 attributed): warmup, auto/linear/flat sampling, bootstrap CIs (mean/median/std dev/MAD/slope), Welch-t + permutation p-value comparison, Tukey outliers. Fixes as-tral's resample-median bug.
- `bench()` now measures for real; `suite()` reports each bench's delta vs the suite's first bench.
- `__asbench` host-import namespace in `lib/as-bs.ts`: `now`, `tune` (settings overrides), progress/result events; `runBenchFile()` runs a compiled bench under WASI with a pluggable reporter.
- `as-bench run` / `as-bench build` implemented: glob → asc (in-process, wasi-shim + transform) → run → criterion-style render; flags `--warmup --measure --samples --resamples --sampling --confidence --verbose`.
- Playground now runs the real engine.

- Scaffold the three build targets (`cli/`→`bin/`, `lib/`→`lib/build/`, `transform/src/`→`transform/lib/`) mirroring as-test.
- Thin runtime-agnostic host (`lib/as-bs.ts`): `instantiate()` for node bindings + WASI, live `now()`, default imports.
- CLI skeleton (`as-bench` / `asb`): `help`/`version` wired; `run`/`profile`/`build`/`init` stubbed.
- AssemblyScript API skeleton (`bench`, `suite`, `set`, `blackbox`) + descriptors/settings; no `run()` — bench files execute at module start (as-tral style).
- No-op `asc` transform plugin skeleton.
- Project plan in `PLAN.md`.
