## Unreleased

- `asb run --deterministic`: record/replay of host imports (design from the playground replay system, adapted in-process). The engine announces each routine invocation via a new `iter()` import; the harness keeps iteration 1 live (lazy inits fire), records iteration 2's steady-state call pattern + memory diffs, and replays it for every later iteration with per-iteration verification (import order, tagged args, full tape consumption). Divergence — e.g. a routine whose call pattern or pointer args vary between iterations — fails loudly with the call index. Engine timing stays live: deterministic builds define `AS_BENCH_DETERMINISTIC` to route `timeNow()` through the passthrough `__asbench.now`, leaving the WASI clock recordable for user `Date.now`. The engine's analysis phase drops back to live imports (`analyzing` resets the harness). Per-iteration overhead ~3–5ns — compare deterministic runs with deterministic runs.

- `asb profile` (--heaviest=instr): tier-free work profiling. A binaryen pass injects per-function `calls` + executed-instruction counters (region granularity: function entry, loop bodies, if-arms; exported i64 globals), the engine's new profile mode runs each routine exactly once, and the CLI renders per-bench tables (%, instrs, calls, instrs/call). Engine overhead inside the counted window: 6 instructions. Fully deterministic — identical totals across runs and builds. Validated analytically: fib(20) reports exactly 21,891 calls (= 2·F(21)−1). `--top`, `--all` flags; `--heaviest=time` reserved.
- Profile builds add `--debug` for the name section only — verified bit-identical instruction totals with and without.

- Port the as-tral/Criterion statistics engine into `assembly/engine.ts` (Apache-2.0 attributed): warmup, auto/linear/flat sampling, bootstrap CIs (mean/median/std dev/MAD/slope), Welch-t + permutation p-value comparison, Tukey outliers. Fixes as-tral's resample-median bug.
- `bench()` now measures for real; `suite()` reports each bench's delta vs the suite's first bench.
- `__asbench` host-import namespace in `lib/as-bs.ts`: `now`, `tune` (settings overrides), progress/result events; `runBenchFile()` runs a compiled bench under WASI with a pluggable reporter.
- `as-bench run` / `as-bench build` implemented: glob → asc (in-process, wasi-shim + transform) → run → criterion-style render; flags `--warmup --measure --samples --resamples --sampling --confidence --verbose`.
- Playground now runs the real engine.
- WASI builds time via the shim's `performance.now()` (`clock_time_get(MONOTONIC)`) instead of the `__asbench.now` JS import — no host import on the hot path; `__asbench.now` remains the fallback for non-WASI targets.
- Proper Apache-2.0 vendoring for the engine: full license text in `licenses/as-tral.LICENSE` + `NOTICE` crediting romdotdog/as-tral and Criterion.rs; both ship in the npm package.
- Baseline persistence: `--save-baseline <id>` stores each bench's raw sample (iters + times) in `.as-bench/baselines/<id>.json`; `--baseline <id>` replays it through the engine's Welch-t + permutation comparison and renders `delta: [...] (p = ...) slower than baseline '<id>'`. Engine gains `sampleDone`/`loadBaseline`/`change` host hooks (pull-based baseline injection). Sample-size mismatches skip comparison with a warning. Verified: fib(21) vs fib(20) baseline reports +61.9% (golden ratio predicts +61.8%).
- Delta verdicts now use criterion's rule — "no change" when the entire CI lies inside the noise band (was: only when the CI spanned zero).
- Adaptive warmup: exits early once per-batch met stabilizes (2 consecutive batches within `warmupTolerance`, default 2%, after `warmupMinTime`); `warmupTime` is now a cap and `--warmup-tolerance 0` restores fixed-time warmup. Converged warmups derive met from the stable tail, not the cold-biased cumulative average. New `warmupEnded` event + `--warmup-tolerance`/`--warmup-min` flags. Example bench: 17.1s → 8.7s, identical results.

- Scaffold the three build targets (`cli/`→`bin/`, `lib/`→`lib/build/`, `transform/src/`→`transform/lib/`) mirroring as-test.
- Thin runtime-agnostic host (`lib/as-bs.ts`): `instantiate()` for node bindings + WASI, live `now()`, default imports.
- CLI skeleton (`as-bench` / `asb`): `help`/`version` wired; `run`/`profile`/`build`/`init` stubbed.
- AssemblyScript API skeleton (`bench`, `suite`, `set`, `blackbox`) + descriptors/settings; no `run()` — bench files execute at module start (as-tral style).
- No-op `asc` transform plugin skeleton.
- Project plan in `PLAN.md`.
