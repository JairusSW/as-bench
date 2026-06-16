# as-bench

Runtime-agnostic, statistically-aware benchmarking for AssemblyScript. Compiles your bench file together with a Criterion-style statistics engine; the CLI runs it on any WASI runtime and renders per-bench timing, CIs, and outlier reports.

## Install

```sh
npm install --save-dev as-bench
# or: bun add -d as-bench
```

## Quick start

```sh
npx asb init          # scaffold as-bench.config.json + example bench
npx asb run           # build + run all benches
npx asb run --mode quick  # faster settings while iterating
```

## Writing benchmarks

```ts
import { bench, suite, blackbox, settings } from "as-bench/assembly/index";

// Optional: override defaults before the first bench()
settings.warmupTime = 500;        // ms
settings.measurementTime = 1000;  // ms

function fib(n: i32): i32 {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

bench("fib(20)", () => {
  blackbox<i32>(fib(blackbox<i32>(20)));
});

suite("fib", () => {
  bench("fib(15)", () => {
    blackbox<i32>(fib(blackbox<i32>(15)));
  });
  bench("fib(20)", () => {
    blackbox<i32>(fib(blackbox<i32>(20)));
  });
});
```

Bench files execute at module start — `bench()` drives the engine immediately when called. There is no `run()`. `blackbox<T>(v)` forces the compiler to treat `v` as live, preventing dead-code elimination of timed work.

## API

| Export | Description |
|--------|-------------|
| `bench(name, fn)` | Measure `fn`: warmup → sampling → bootstrap CIs → outliers. Runs immediately. |
| `suite(name, fn)` | Group benchmarks. Each bench after the first reports its delta vs the first. |
| `blackbox<T>(v): T` | Opaque identity — prevents the optimizer from folding away timed work. |
| `settings` | Mutable `Settings` object; set fields before the first `bench()`. |

### `Settings` fields

| Field | Default | Description |
|-------|---------|-------------|
| `warmupTime` | `3000` | Warmup time cap in ms (adaptive exit may be earlier). |
| `warmupMinTime` | `100` | Minimum warmup time before stability is judged. |
| `warmupTolerance` | `0.02` | Relative met drift considered stable; `0` = fixed-time warmup. |
| `measurementTime` | `5000` | Target measurement window in ms. |
| `sampleSize` | `100` | Samples per bench. |
| `numResamples` | `100000` | Bootstrap resamples for CIs. |
| `samplingMode` | `SamplingMode.Auto` | `Auto` \| `Linear` \| `Flat`. |
| `confidenceLevel` | `0.95` | CI confidence level. |

## CLI

```
asb <command> [files...] [options]
```

All commands accept `--config <path>` and `--mode <name>` (see Config).

### `asb run`

Build and run benchmarks with full statistical analysis.

```sh
asb run                           # all files from config input globs
asb run assembly/__benches__/my.ts   # specific file
asb run --mode quick              # apply a named config overlay
asb run --verbose                 # print all estimates (mean/median/std dev/MAD/slope)
asb run --filter "fib*"           # run only benches whose name matches a pattern
asb run --json                    # machine-readable JSON output (to stdout)
```

**Timing flags** (override config `settings.*`):

| Flag | Description |
|------|-------------|
| `--warmup <ms>` | Warmup time cap |
| `--warmup-tolerance <x>` | Stable-met drift threshold (0 = fixed-time) |
| `--warmup-min <ms>` | Minimum warmup time |
| `--measure <ms>` | Measurement window |
| `--samples <n>` | Sample count |
| `--resamples <n>` | Bootstrap resamples |
| `--sampling auto\|linear\|flat` | Sampling strategy |
| `--confidence <x>` | CI confidence level |

**Baseline flags:**

```sh
asb run --save-baseline main      # save this run's raw samples as 'main'
asb run --baseline main           # compare each bench against 'main' (Welch-t + permutation)
```

**Runtime flags:**

```sh
asb run --runtime wasmtime        # run under wasmtime (pure-WASI build)
asb run --runtime wasmer          # run under wasmer
asb run --runtime wazero          # run under wazero
asb run --runtime "wazero run <env:-env> <file>"  # custom command
asb run --runtime node --runtime wasmtime  # comparison table across runtimes
asb run --deterministic           # record host imports (iter 2), replay for every later iter
```

For external runtimes the bench wasm streams framed binary events over stdout (WIPC); `--deterministic` requires the node host.

### `asb build`

Compile benchmarks without running.

```sh
asb build                         # compile all input files
asb build assembly/__benches__/my.ts
asb build --runtime wasmtime      # also emit the pure-WASI WIPC build
```

### `asb profile`

Per-function work profile. Builds a debug+instrumented wasm, runs each bench once (or N times), and renders tables.

```sh
asb profile                       # --heaviest=instr (default)
asb profile --heaviest=instr      # rank by cost-weighted instruction count (exact, deterministic)
asb profile --heaviest=time       # rank by wall-clock self time (overhead-corrected, node only)
asb profile --heaviest=alloc      # rank by bytes allocated from the runtime allocator (exact)

asb profile --top 20              # rows per bench (default 10)
asb profile --all                 # include engine/runtime-internal rows
asb profile --iters 20            # (time/alloc) iterations per bench
asb profile --min-instrs 0        # (time) wrap all functions, including trivial ones
```

#### `--heaviest=instr`

Injects per-function call + instruction counters (region granularity: function entry, loop bodies, if-arms). Counts are exact and fully deterministic — identical totals across runs and build flags. Output columns: `% | weighted instrs | raw instrs | calls | wt/call | name`. Weights: ALU/const = 1, int mul 3, load 3/store 2, float 2, call 5/indirect 8, div/sqrt 12–15, `memory.grow` 100.

#### `--heaviest=time`

Outlines each function into a `<name>$tprof_inner` + timing wrapper. Self-time = own duration minus direct wrapped callees; inclusive time is outermost-frame-gated (recursion-safe). Overhead (~2 clock calls per call) is measured per bench and subtracted. Trust self times ≥ ~1µs; below that `--heaviest=instr` is exact. Node host only.

#### `--heaviest=alloc`

Same move-body wrapper as `=time` but reads a monotone byte counter instead of a clock — exact and deterministic (no calibration). Counting point: the deepest allocator layer surviving `-O` inlining. Managed, unmanaged, and realloc moves are counted exactly once. GC frees don't subtract (allocation pressure, not live/peak). Summary line shows managed/unmanaged split, realloc count, and linear-memory page growth.

### `asb watch`

Rebuild and rerun benches on source file change.

```sh
asb watch                         # watch all input files (from config)
asb watch assembly/__benches__/my.ts
asb watch --filter "fib*" --mode quick
```

Accepts all `asb run` flags. Separates runs with a `---` line.

### `asb compare`

Compare two saved baselines without re-running — useful for async CI workflows.

```sh
asb compare main dev              # per-bench delta between baselines 'main' and 'dev'
```

Shows delta %, p-value (Welch's t-test), and a faster/slower/no-change verdict for each bench that appears in both baselines.

### `asb init`

Scaffold a starter config and example bench.

```sh
asb init                          # creates as-bench.config.json + assembly/__benches__/example.ts
asb init --force                  # overwrite existing files
```

## Configuration

`as-bench.config.json` is auto-discovered in the current directory. A JSON schema ships at `node_modules/as-bench/as-bench.config.schema.json` for editor autocomplete.

```json
{
  "$schema": "node_modules/as-bench/as-bench.config.schema.json",
  "input": ["assembly/__benches__/**/*.ts"],
  "outDir": ".as-bench/build",
  "baselineDir": ".as-bench/baselines",
  "runtime": "node",
  "verbose": false,
  "deterministic": false,
  "settings": {
    "warmupTime": 3000,
    "measurementTime": 5000,
    "sampleSize": 100,
    "numResamples": 100000
  },
  "render": {
    "significanceLevel": 0.05,
    "noiseThreshold": 0.01
  },
  "buildOptions": {
    "optimize": true,
    "debug": false,
    "args": []
  },
  "profile": {
    "top": 10,
    "all": false,
    "iters": 10,
    "minInstrs": 4
  },
  "modes": {
    "quick": {
      "settings": {
        "warmupTime": 250,
        "measurementTime": 500,
        "numResamples": 20000
      }
    },
    "wasmtime": { "runtime": "wasmtime" },
    "compare": {
      "runOptions": {
        "runtime": ["node", "wasmtime", "wasmer"]
      }
    }
  }
}
```

### `runOptions.runtime`

For more control than the top-level `runtime` shorthand, use `runOptions.runtime` with a `{cmd, name}` object or a list:

```json
{
  "runOptions": {
    "runtime": [
      "node",
      "wasmtime",
      { "cmd": "wazero run <env:-env> <file>", "name": "wazero" }
    ]
  }
}
```

- `<file>` → replaced with the bench wasm path (appended as the last arg when omitted)
- `<env:PREFIX>` → expands `AS_BENCH_TUNE_*` settings pairs as runtime env flags (trailing `=` fuses: `<env:--env=>` → `--env=K=V`)

## Baselines

```sh
asb run --save-baseline main        # save current run as 'main'
git commit .as-bench/baselines/     # commit baselines alongside code

asb run --baseline main             # compare live run against 'main'
asb compare main dev                # diff two saved baselines
```

Comparison uses Welch's t-test + permutation p-value. The verdict follows Criterion's rule: "no change" when the result is not statistically significant **or** when the entire CI lies inside the configured noise band (±1% by default).

## Deterministic mode

```sh
asb run --deterministic
```

Records all host imports during iteration 2 of each bench (iteration 1 is live for lazy initialization), then replays the recorded call pattern for every subsequent iteration. Neutralizes nondeterministic host behavior (I/O, clocks, random numbers) so timing reflects pure wasm compute.

Overhead: ~3–5 ns/iter. Compare deterministic runs only with other deterministic runs.

## JSON output

```sh
asb run --json > results.json
```

Outputs a JSON document to stdout (all terminal output is suppressed). Shape:

```json
{
  "version": 1,
  "benches": [
    {
      "file": "assembly/__benches__/example.ts",
      "runtime": "node",
      "suite": null,
      "name": "fib(20)",
      "key": "fib(20)",
      "result": { "lb": 1.23e-3, "point": 1.30e-3, "hb": 1.37e-3 },
      "delta": {
        "lb": -0.02, "point": 0.015, "hb": 0.05,
        "pValue": 0.32, "verdict": "no change", "vs": "baseline 'main'"
      },
      "outliers": { "lowSevere": 0, "lowMild": 0, "highMild": 2, "highSevere": 0 },
      "warnings": []
    }
  ]
}
```

Times are in milliseconds.

## Architecture notes

- The statistics engine runs entirely inside wasm (ported from [as-tral](https://github.com/romdotdog/as-tral), Apache-2.0); the JS host only supplies `now()`, settings overrides, and the reporting channel.
- WIPC builds stream all engine events as framed binary messages over stdout so any WASI runtime can run them without custom imports.
- Instruction-count profiling is a post-compile Binaryen pass — it instruments the wasm binary directly, not the source.
- Wall-clock numbers under node/V8 are a property of (asc flags × V8 tier heuristics); tier-free modes (wasmtime, `--heaviest=instr`) are the ground truth for compile-flag comparisons.

## Attribution

The statistics engine (`assembly/engine.ts`) is ported from [as-tral](https://github.com/romdotdog/as-tral) (© romdotdog, Apache-2.0), itself a port of [Criterion.rs](https://github.com/bheisler/criterion.rs). Full license text in `licenses/as-tral.LICENSE`; credited in `NOTICE`.

## License

MIT
