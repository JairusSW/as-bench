# as-bench — Plan

A runtime-agnostic, statistically-aware micro-benchmarker for AssemblyScript.
It composes three existing projects: **as-test** (runtime-agnostic execution
model), **as-tral** (Criterion-style statistics engine, runs entirely in wasm),
and the **playground `jairus/replay`** record/replay system (deterministic runs).

A user writes a `.bench.ts` file; `asc` compiles it **together with the
as-bench assembly library** (the stats engine) under our transform; the thin JS
host (`lib/as-bs.ts`) instantiates it on the chosen runtime, supplies `now()` +
WIPC + (optionally) replay-wrapped imports, drives the run, and the CLI renders
Criterion-style output.

## Architecture

```
as-bench/
├── assembly/                 # ships as-is into consumer projects (AS source)
│   ├── index.ts              # public API: bench(), suite(), set(), blackbox() — no run(); bench() executes at module start (as-tral style)
│   ├── engine.ts             # as-tral stats engine (warmup→sample→bootstrap→outliers→compare)
│   ├── types.ts              # BenchDescriptor, SuiteDescriptor, Settings, Estimates
│   └── util/wipc.ts          # framed binary results/logs out (ported from as-test)
├── lib/as-bs.ts  → lib/build # thin runtime-agnostic host (instantiate + now() + replay glue)
├── cli/          → bin/      # orchestration: build, run, report, baseline diff, profile
├── transform/src → transform/lib
│   ├── index.ts              # afterParse: bench/suite name→id, settings globals
│   └── instrument.ts         # Binaryen pass: per-fn + global instruction counters
├── replay/                   # ported from playground (tape/record/replay/memory/marshal/hash)
├── as-bench.config.json + schema + modes
└── package.json              # 3 build targets, mirrors as-test
```

Three independent build targets, each rebuilt after changes (mirrors as-test):

| Source           | Output           | Role                                              |
| ---------------- | ---------------- | ------------------------------------------------- |
| `cli/`           | `bin/`           | Node CLI — orchestration, config, reporting       |
| `lib/`           | `lib/build/`     | JS host — `instantiate()` for runners             |
| `transform/src/` | `transform/lib/` | ASC compiler plugin — instrumentation             |

## Locked decisions (2026-06-11)

1. **Instruction counting** = instrument the wasm (Binaryen pass injects
   per-function + global instruction counters, exported & dumped). Runs on any
   runtime; no external interpreter.
2. **Record/replay** = "deterministic mode": record host imports once, replay
   every measured iteration so pure wasm-compute timing is stable.
   - The timing import `now()` (and the WIPC channel) are **passthrough** —
     excluded from record/replay, always live. The stock replay wrappers wrap
     *every* function import, so as-bench adds an **exclude-set**.
   - Cursor rewind: **auto-rewind `state.idx = 0` when the tape exhausts** — a
     deterministic routine consumes the same call list each iteration; no
     wasm-side signal needed.
   - Caveat to document: replay-blit (`applyDiffs`) overhead lands inside each
     measured iteration, so the number is "compute + replay cost". Calibrate by
     timing an empty-routine replay if needed.
   - **Open risk** to de-risk early: a tape is recorded against iteration 0's
     memory; if the engine's loop drifts the AS bump allocator between
     iterations, recorded diff offsets could land wrong. Validate with a
     prototype before committing the engine loop shape.
3. **Timing 'heaviest calls'** = both, user picks: default `--heaviest=instr`
   (instruction count as cost proxy, low overhead), opt-in `--heaviest=time`
   (instrumented per-fn `now()` timers).
4. **Structure** = as-test scaffold + as-tral engine embedded as the assembly
   library; bench routine compiled together with the engine (as-tral
   `--exportStart` style).

## Modes / commands

- `as-bench run` — statistical timing (as-tral port). warmup → sampling →
  100k bootstrap → CIs/outliers → WIPC out → Criterion render.
  `--save-baseline` / `--baseline` for Welch-t + permutation-p comparison.
- `as-bench run --deterministic` — record once, replay each iteration.
- `as-bench profile --heaviest=instr` — instrumented build, run once, dump
  counters → total instructions + heaviest calls. (deterministic, no stats)
- `as-bench profile --heaviest=time` — per-fn `now()` timers (opt-in, higher
  overhead).

## Roadmap

1. ~~**Scaffold the 3 targets**~~ — done.
2. ~~**Port the stats engine**~~ — done. `assembly/engine.ts` (Apache-2.0
   attributed) + `bench()`/`suite()`/`blackbox()` + mutable `settings`;
   results flow over the `__asbench` host-import namespace (string names as
   UTF-16 ptr/len) rather than WIPC for now — WIPC becomes the transport when
   the runtime matrix lands (step 5), since pure-CLI runtimes (wasmtime) can't
   supply rich imports. CLI `run`/`build` work end-to-end with criterion-style
   rendering and `--warmup/--measure/--samples/--resamples/--sampling/
   --confidence/--verbose` overrides via the engine's `tune` import.
2b. ~~**Baseline persistence**~~ — done. `--save-baseline <id>` /
   `--baseline <id>`; raw samples in `.as-bench/baselines/<id>.json`;
   pull-based `loadBaseline` host hook feeds the engine's existing compare().
3. ~~**Deterministic mode**~~ — done (`lib/replay.ts`), with a design change
   from the original two-phase plan: recording happens IN-PROCESS during the
   measured run (live iter 1 for lazy inits → record iter 2 → replay iter 3+,
   signaled by the engine's `iter()` import), so record and replay share one
   memory layout and the heap-drift risk collapses into loud divergence
   errors (pointer-arg mismatch). `__asbench` is the passthrough exclude-set;
   `AS_BENCH_DETERMINISTIC` builds time via host.now so the WASI clock is
   recordable; `analyzing()` returns the harness to live for the engine's own
   bootstrap randomness. The playground branch's binary tape format
   (sha-bound, on-disk) remains future work for cross-runtime replay oracles.
4. ~~**Instrumentation pass** → `profile --heaviest=instr`~~ — done (lives in
   `cli/instrument.ts` as a post-compile binaryen.js pass, not an asc
   transform; binaryen resolved from the installed assemblyscript's pin).
   Region-granular counting (function entry / loop body / if-arm); known
   imprecision: early `br`/`return` still pays its region's full weight.
   Engine `profileMode` (tune kind 8) runs routines exactly once.
   Finding while validating: asc `--optimize` does NOT inline StaticArray
   bounds-checked accessors — `__get` was 55% of bubble sort's instructions.
5. **Runtime matrix** — core done: `--runtime wasmtime|wasmer|wazero|<template>`
   runs pure-WASI WIPC builds (framed stdout events, env-var tunes; module
   imports = wasi_snapshot_preview1 only). Config-file + modes done:
   `as-bench.config.json` + schema, `--config`/`--mode`, precedence
   defaults < config < mode < flags; `asb init` scaffolds. Remaining:
   browsers, node:bindings target.
6. **`--heaviest=time`** — design settled (2026-06-12), see below.
   `--heaviest=instr` covers exact attribution meanwhile.

## Design: `profile --heaviest=time` (2026-06-12)

Per-function wall-time with **exact self-time** (recursion-safe) and
**outermost-only inclusive time**, via wrapper outlining + child-time
subtraction. No shadow stack in memory; the real call stack carries the
bookkeeping in wrapper locals.

**Accounting.** One shared mutable i64 global `__tprof_child`; per function
`k`: exported `__tprof_self_<k>` (i64 ns), `__tprof_incl_<k>` (i64 ns),
`__tprof_d_<k>` (i32 depth). Wrapper for `k`:

```
t0 = tnow(); saved = child; child = 0; d_k += 1
r  = call $k$inner(...args)
dur = tnow() - t0
self_k += dur - child          ; subtract direct instrumented callees → self
d_k -= 1; if d_k == 0: incl_k += dur   ; outermost frame only → no recursion double-count
child = saved + dur            ; my whole duration is child-time to MY caller
return r
```

Self-time is exact relative to instrumented callees; time in *skipped* or
imported callees accrues to the caller (documented). Traps/abort leak one
frame — run is over anyway.

**Why outlining, not body injection:** epilogue-on-every-exit needs all
`return`s rewritten and new locals added; a wrapper needs neither. The pass
renames `k` → `k$inner`, creates the wrapper under the original name, then
re-points **exports** and **element segments** (call_indirect — bench
callbacks are function refs!) at the wrapper. Direct calls follow the name
automatically.

**Clock:** new injected import `__asbench.tnow(): i64` (ns), supplied by the
node host as `process.hrtime.bigint()` — avoids `clock_time_get`'s
pointer-to-memory result, which would need scratch memory the AS bump
allocator doesn't know to avoid. =time is node-only for now; external
runtimes would need the wasi-clock + reserved-scratch variant (future).

**Overhead control & correction:**
- ~2 host clock calls + 1 extra frame per call ≈ O(100ns)/call — fatal for
  nano-functions if uncorrected. The pass also injects an exported empty
  wrapped function `__tprof_calib`; the host calls it ~100k times, derives
  per-call overhead, and subtracts `calls_k × overhead` per function
  (floor 0). Render notes "overhead-corrected".
- `--min-instrs <w>` (default ~16): reuse the instr pass's static region
  weights to **skip wrapping trivial functions** (accessors etc.) — their
  time folds into callers, slashing call volume. `--min-instrs 0` wraps all.
- `--iters <n>` (default 10): new tune kind (next free: 10) loops the routine
  n times in profileMode; percentages are n-independent, per-call divides.
  Single-run times are clock-granularity noise for short routines.

**Render:** per bench — total, then `%self  self  incl  calls  self/call
name`, sorted by self, `isInternal` filter as in =instr. Caveat line: =time
suits functions ≥ ~1µs self; below that =instr is the honest tool.

**Validation:**
1. `fib(20)`: incl ≈ self ≈ 100% (self-recursive — proves depth gating; naive
   inclusive would report ~F(21)× over-attribution).
2. empty function × 1M calls: corrected self ≈ 0 (calibration sanity).
3. bubble sort: `__get` 55% by instrs — time% should correlate; with default
   `--min-instrs` its time folds into the sort (document the contrast).
4. a memory-thrashing bench where time% ≠ instr% (cache misses) — the
   feature's reason to exist.

**Steps:** (1) `instrumentTime()` in cli/instrument.ts (outline pass: rename,
wrapper, exports + elem segments, calib fn); (2) `tnow` in benchImports;
(3) engine profileIters tune (kind 10); (4) cli/profile.ts =time branch:
instrument → run → calibrate → corrected table; (5) changelog + caveats.

## Attribution

- `as-tral` is romdotdog's, **Apache-2.0** — vendored into `assembly/engine.ts`
  with an SPDX header + attribution; full license text in
  `licenses/as-tral.LICENSE`, credited in `NOTICE` (one-way compatible into
  this MIT project; that file stays Apache-2.0). Port fixes as-tral's
  resample-median bug.
- Timing source: WASI builds use the wasi-shim's `performance.now()`
  (`clock_time_get(MONOTONIC)`, ns-sourced) — no JS import on the hot path and
  ready for pure-CLI runtimes; `__asbench.now` is the non-WASI fallback.
- `replay/` is Jairus's own MIT playground code — clean to vendor.

## Resolved: the "--optimize 2× slower" anomaly (2026-06-11)

Reproduced standalone (no engine involved) — as-bench measures correctly.
The cause is **V8 execution-tier steady states**, not the wasm: with a pinned
tier (`--liftoff-only`) O0 and O3 builds run identically (69µs), but under
default tiering, `-O2`/`-O3` (shrinkLevel 0 — which is what `asc --optimize`
emits) builds settle into a stable partial-tier equilibrium ~2× slower
(38µs) than what O0/O1/shrink≥1 builds reach (19–22µs, full TurboFan +
feedback inlining). The slow state is *stable* — adaptive warmup converges on
it with tight CIs — it's just not peak. Affects call-heavy and loop-heavy code
alike (fib AND bubble sort, both ~2.1×).

Consequences:
- Wall-clock numbers under node/V8 are a property of (asc flags × V8 tier
  heuristics), not of the wasm alone. Document loudly.
- Strengthens the case for the roadmap's tier-free modes: wasmtime/AOT
  runtimes (step 5) and instruction-count profiling (step 4) are the
  tier-independent ground truth.
- Keep `--optimize` as the build default (it's what users ship), but make
  build flags configurable so flag-sensitivity is testable.
</content>
