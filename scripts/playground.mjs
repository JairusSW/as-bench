// Runs the compiled playground wasm on the as-bench host (lib/host.ts) using
// the CLI's full criterion-style renderer — same output as `asb run`, including
// suite deltas with verdicts and noise-threshold handling.
// Pass --verbose to also print every estimate (mean/median/std dev/MAD/slope).
import { performance } from "node:perf_hooks";
import { runBenchFile } from "../lib/build/host.js";
import { Renderer } from "../bin/run.js";

const wasmPath = process.argv[process.argv.length - 1];
const verbose = process.argv.includes("--verbose");

const t0 = performance.now();
await runBenchFile(wasmPath, new Renderer(verbose));
const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
process.stdout.write(`\x1b[2m\nfinished in ${elapsed}s\x1b[0m\n`);
