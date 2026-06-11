#!/usr/bin/env node
import chalk from "chalk";
import { executeRun, executeBuild } from "./run.js";
// Bumped in lockstep with package.json; the scaffold keeps it inline rather
// than importing JSON to avoid ESM import-assertion friction in the bin.
const VERSION = "0.0.0";
const HELP = `${chalk.bold("as-bench")} — runtime-agnostic, statistically-aware benchmarking for AssemblyScript

${chalk.bold("Usage")}
  as-bench <command> [files...] [options]

${chalk.bold("Commands")}
  run                 Build and run benchmarks (statistical timing)
    --warmup <ms>       Override warmup time
    --measure <ms>      Override measurement time
    --samples <n>       Override sample count
    --resamples <n>     Override bootstrap resamples
    --sampling <m>      auto | linear | flat
    --confidence <x>    Confidence level (default 0.95)
    --verbose, -V       Print all estimates (mean/median/std dev/MAD/slope)
  build               Compile benchmarks without running
  profile             Count work per call (not yet implemented)
    --heaviest=instr    Rank calls by wasm instruction count (default)
    --heaviest=time     Rank calls by per-function wall-clock
  init                Scaffold an as-bench config (not yet implemented)

  help, --help, -h    Show this help
  version, -v         Show the version

Benchmark files default to ${chalk.dim("assembly/__benches__/**/*.ts")}.`;
function notImplemented(cmd) {
  console.log(chalk.yellow(`as-bench ${cmd}: not yet implemented`));
  process.exitCode = 1;
}
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
    case "init":
      notImplemented(cmd);
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
