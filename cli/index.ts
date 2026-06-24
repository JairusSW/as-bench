#!/usr/bin/env node
import chalk from "chalk";
import { executeRun, executeBuild } from "./run.js";
import { executeProfile } from "./profile.js";
import { executeInit } from "./init.js";
import { executeWatch } from "./watch.js";
import { executeCompare } from "./compare.js";
import { executeDoctor } from "./doctor.js";
import { executeClean } from "./clean.js";

// Bumped in lockstep with package.json; the scaffold keeps it inline rather
// than importing JSON to avoid ESM import-assertion friction in the bin.
const VERSION = "0.1.0";

// Help palette mirrors as-test: brand + working commands in bold blueBright,
// lifecycle commands in bold magentaBright, headers bold, hints/version dim,
// flags bold blue, links blue. Padding is applied to the plain text before
// coloring so the columns stay aligned (ANSI codes are zero-width).
const hc = {
  core: chalk.bold.blueBright,
  setup: chalk.bold.magentaBright,
  head: chalk.bold,
  dim: chalk.dim,
  flag: chalk.bold.blue,
  link: chalk.blue,
};
const cmdRow = (color: (s: string) => string, name: string, hint: string, desc: string): string => `  ${color(name.padEnd(8))}${hc.dim(hint.padEnd(15))} ${desc}`;
const flagRow = (name: string, desc: string): string => `  ${hc.flag(name.padEnd(23))} ${desc}`;
const linkRow = (label: string, url: string): string => `${label.padEnd(26)}${hc.link(url)}`;

const HELP = [
  `${hc.core("as-bench")} is a runtime-agnostic, statistically-aware benchmarking framework for AssemblyScript. ${hc.dim(`(v${VERSION})`)}`,
  ``,
  `${hc.head("Usage: as-bench")} ${hc.dim("<command>")} ${hc.core("[...flags]")} ${hc.head("[...args]")} ${hc.dim("(alias: asb)")}`,
  ``,
  `${hc.head("Commands:")}`,
  cmdRow(hc.core, "run", "<./**/*.ts>", "Build and run benchmarks with statistical timing"),
  cmdRow(hc.core, "build", "<./**/*.ts>", "Compile benchmarks without running"),
  cmdRow(hc.core, "profile", "<./**/*.ts>", "Per-function work profile (--instr | --time | --alloc)"),
  ``,
  cmdRow(hc.core, "compare", "<a> <b>", "Compare two saved baselines (Welch's t-test)"),
  cmdRow(hc.core, "watch", "<./**/*.ts>", "Rebuild and rerun benchmarks on change"),
  ``,
  cmdRow(hc.setup, "init", "<./dir>", "Scaffold as-bench.config.json + an example bench"),
  cmdRow(hc.setup, "doctor", "<--mode x>", "Validate config, dependencies, globs, and runtimes"),
  cmdRow(hc.setup, "clean", "<--mode x>", "Remove generated build/chart outputs"),
  ``,
  `${hc.head("Flags:")}`,
  flagRow("--config <path>", "Config file (default as-bench.config.json)"),
  flagRow("--mode <name>", "Apply a named config overlay"),
  flagRow("--version, -v", "Print current cli version"),
  flagRow("--help, -h", "Show help menu"),
  ``,
  hc.dim("If this tool provides value, please consider sponsoring my open-source work! https://github.com/sponsors/JairusSW"),
  ``,
  linkRow("View the docs:", "https://docs.jairus.dev/as-bench"),
  linkRow("View the repo:", "https://github.com/JairusSW/as-bench"),
  ``,
  hc.dim("Per-command flags (--measure, --samples, --filter, --json, --runtime, …) are in the README."),
].join("\n");

async function main(argv: string[]): Promise<void> {
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
      if (rest[0] === "help" || rest[0] === "--help" || rest[0] === "-h") {
        console.log(HELP);
        return;
      }
      await executeRun(rest);
      return;
    case "build":
      if (rest[0] === "help" || rest[0] === "--help" || rest[0] === "-h") {
        console.log(HELP);
        return;
      }
      await executeBuild(rest);
      return;
    case "profile":
      if (rest[0] === "help" || rest[0] === "--help" || rest[0] === "-h") {
        console.log(HELP);
        return;
      }
      await executeProfile(rest);
      return;
    case "watch":
      if (rest[0] === "help" || rest[0] === "--help" || rest[0] === "-h") {
        console.log(HELP);
        return;
      }
      await executeWatch(rest);
      return;
    case "compare":
      if (rest[0] === "help" || rest[0] === "--help" || rest[0] === "-h") {
        console.log(HELP);
        return;
      }
      await executeCompare(rest);
      return;
    case "init":
      if (rest[0] === "help" || rest[0] === "--help" || rest[0] === "-h") {
        console.log(HELP);
        return;
      }
      await executeInit(rest);
      return;
    case "doctor":
      if (rest[0] === "help" || rest[0] === "--help" || rest[0] === "-h") {
        console.log(HELP);
        return;
      }
      await executeDoctor(rest);
      return;
    case "clean":
      if (rest[0] === "help" || rest[0] === "--help" || rest[0] === "-h") {
        console.log(HELP);
        return;
      }
      await executeClean(rest);
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
