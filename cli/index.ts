#!/usr/bin/env node
import chalk from "chalk";

// Bumped in lockstep with package.json; the scaffold keeps it inline rather
// than importing JSON to avoid ESM import-assertion friction in the bin.
const VERSION = "0.0.0";

const HELP = `${chalk.bold("as-bench")} — runtime-agnostic, statistically-aware benchmarking for AssemblyScript

${chalk.bold("Usage")}
  as-bench <command> [options]

${chalk.bold("Commands")}
  run                 Build and run benchmarks (statistical timing)
    --deterministic   Record host imports once, replay each measured iteration
    --baseline <id>   Compare against a saved baseline
    --save-baseline   Persist this run as a baseline
  profile             Count work per call
    --heaviest=instr  Rank calls by wasm instruction count (default)
    --heaviest=time   Rank calls by per-function wall-clock (higher overhead)
  build               Compile benchmarks without running
  init                Scaffold an as-bench config in the current project

  help, --help, -h    Show this help
  version, -v         Show the version

${chalk.dim("Scaffold stage — only help/version are wired up so far.")}`;

function notImplemented(cmd: string): void {
  console.log(chalk.yellow(`as-bench ${cmd}: not yet implemented (scaffold)`));
  process.exitCode = 1;
}

function main(argv: string[]): void {
  const cmd = argv[0];
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
    case "profile":
    case "build":
    case "init":
      notImplemented(cmd);
      return;
    default:
      console.error(chalk.red(`unknown command: ${cmd}`));
      console.error(`run ${chalk.bold("as-bench help")} for usage`);
      process.exitCode = 1;
  }
}

main(process.argv.slice(2));
