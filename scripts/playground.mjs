// Runs the compiled playground wasm on the as-bench host (lib/as-bs.ts) using
// the CLI's full criterion-style renderer — same output as `asb run`, including
// suite deltas with verdicts and noise-threshold handling.
// Pass --verbose to also print every estimate (mean/median/std dev/MAD/slope).
import { runBenchFile } from "../lib/build/as-bs.js";
import { Renderer } from "../bin/run.js";

const wasmPath = process.argv[process.argv.length - 1];
const verbose = process.argv.includes("--verbose");

await runBenchFile(wasmPath, new Renderer(verbose));
