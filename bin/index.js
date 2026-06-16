#!/usr/bin/env node
import chalk from "chalk";
import { executeRun, executeBuild } from "./run.js";
import { executeProfile } from "./profile.js";
import { executeInit } from "./init.js";
import { executeWatch } from "./watch.js";
import { executeCompare } from "./compare.js";
// Bumped in lockstep with package.json; the scaffold keeps it inline rather
// than importing JSON to avoid ESM import-assertion friction in the bin.
const VERSION = "0.0.0";
const HELP = `${chalk.bold("as-bench")} — runtime-agnostic, statistically-aware benchmarking for AssemblyScript

${chalk.bold("Usage")}
  as-bench <command> [files...] [options]

${chalk.bold("Commands")}
  run                 Build and run benchmarks (statistical timing)
    --warmup <ms>       Override warmup time cap
    --warmup-tolerance <x>  Stable-met drift for early warmup exit (0 = fixed-time)
    --warmup-min <ms>   Earliest the warmup may converge
    --measure <ms>      Override measurement time (default 3000)
    --samples <n>       Override sample count (default auto-sized from warmup)
    --resamples <n>     Override bootstrap resamples
    --sampling <m>      auto | linear | flat
    --confidence <x>    Confidence level (default 0.95)
    --filter <pattern>  Only run benches whose name matches (substring or glob; repeatable)
    --json              Emit machine-readable JSON to stdout instead of human output
    --save-baseline <id>  Save this run's samples as a named baseline
    --baseline <id>     Compare each bench against a saved baseline
    --deterministic     Record host imports once (iteration 2), replay them for
                        every later iteration — neutralizes host nondeterminism
    --runtime <r>       node (default) | wasmtime | wasmer | wazero | any
                        command, e.g. "wazero run <env:-env> <file>" — <file>
                        is the bench wasm (appended when omitted), <env:PREFIX>
                        expands settings as env flags; external runtimes run a
                        pure-WASI build reporting over framed stdout (WIPC);
                        also configurable as runOptions.runtime.cmd
    --verbose, -V       Print all estimates (mean/median/std dev/MAD/slope)
  build               Compile benchmarks without running
  profile             Per-function work profile (instruction counts or wall-clock)
    --heaviest=instr    Rank by cost-weighted instruction count (default; counts
                        exact + deterministic, weights from a static cost table)
    --heaviest=time     Rank by wall-clock self time (overhead-corrected, recursion-safe)
    --heaviest=alloc    Rank by bytes allocated (exact; self/incl + allocs + pages grown)
    --top <n>           Rows per bench (default 10)
    --all               Include engine/runtime-internal rows
    --iters <n>         (time/alloc) Iterations per bench
    --min-instrs <w>    (time) Don't wrap functions under w static instructions —
                        their time folds into callers (default 4)
  watch               Rebuild and rerun benchmarks on source file change
                      Accepts all run flags (--filter, --mode, etc.)
  compare <a> <b>     Compare two saved baselines without re-running
                      Shows per-bench delta, p-value (Welch's t-test), and verdict
  init                Scaffold as-bench.config.json + an example bench (--force overwrites)

${chalk.bold("Configuration")} (run/build/profile/watch)
  --config <path>     Config file (default ${chalk.dim("as-bench.config.json")} when present)
  --mode <name>       Apply a named overlay from the config's "modes"
  Precedence: defaults < config < mode < CLI flags. Schema:
  ${chalk.dim("node_modules/as-bench/as-bench.config.schema.json")}

  help, --help, -h    Show this help
  version, -v         Show the version

Benchmark files default to the config's input globs (${chalk.dim("assembly/__benches__/**/*.ts")}).`;
async function main(argv) {
  const cmd = argv[0];
  const rest = argv.slice(1);
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      return;
    case "run":
      await executeRun(rest);
      return;
    case "build":
      await executeBuild(rest);
      return;
    case "profile":
      await executeProfile(rest);
      return;
    case "watch":
      await executeWatch(rest);
      return;
    case "compare":
      await executeCompare(rest);
      return;
    case "init":
      await executeInit(rest);
      return;
    default:
      console.error(chalk.red(`unknown command: ${cmd}`));
      console.error(`run ${chalk.bold("as-bench help")} for usage`);
      process.exitCode = 1;
  }
}
main(process.argv.slice(2)).catch((err) => {
  console.error(chalk.red(err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
