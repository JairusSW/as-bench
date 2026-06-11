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

1. **Scaffold the 3 targets** (cli→bin, lib→lib/build, transform→transform/lib)
   mirroring as-test's package.json + tsconfigs. ← _in progress_
2. **Port the stats engine** from `as-tral/assembly/main.ts` into
   `assembly/engine.ts`; wrap in `bench()`/`suite()`/`set()`/`blackbox()`; ship
   results over WIPC. → first working `as-bench run`.
3. **Port `replay/`** verbatim; wire into `lib/as-bs.ts` as deterministic mode;
   add the passthrough exclude-set + auto-rewind; de-risk heap-drift.
4. **Transform instrumentation pass** (Binaryen) → `profile --heaviest=instr`.
5. **`--heaviest=time`** timers + baseline comparison reporting + runtime-matrix
   config modes (node:bindings / node:wasi / wasmtime / browsers).

## Attribution

- `as-tral` is romdotdog's (verify MIT-compatible before vendoring the engine).
- `replay/` is Jairus's own MIT playground code — clean to vendor.
</content>
