import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { glob } from "glob";
import { runBenchFile, type BenchReporter, type TuneOverrides, EstimateKind } from "../lib/build/as-bs.js";

const require = createRequire(import.meta.url);
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_GLOB = "assembly/__benches__/**/*.ts";
const OUT_DIR = ".as-bench/build";

// Host-side rendering thresholds (the engine doesn't use these).
const SIGNIFICANCE_LEVEL = 0.05;
const NOISE_THRESHOLD = 0.01;

export interface RunFlags {
  tunes: TuneOverrides;
  verbose: boolean;
  buildOnly: boolean;
}

export function parseRunFlags(args: string[]): { flags: RunFlags; selectors: string[] } {
  const tunes: TuneOverrides = {};
  const selectors: string[] = [];
  let verbose = false;
  const num = (name: string, v: string | undefined): number => {
    const n = Number(v);
    if (v === undefined || !Number.isFinite(n)) throw new Error(`${name} expects a number, got "${v}"`);
    return n;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--warmup") tunes.warmupTime = num(a, args[++i]);
    else if (a === "--measure") tunes.measurementTime = num(a, args[++i]);
    else if (a === "--samples") tunes.sampleSize = num(a, args[++i]);
    else if (a === "--resamples") tunes.numResamples = num(a, args[++i]);
    else if (a === "--confidence") tunes.confidenceLevel = num(a, args[++i]);
    else if (a === "--sampling") {
      const mode = args[++i];
      const idx = ["auto", "linear", "flat"].indexOf(mode ?? "");
      if (idx < 0) throw new Error(`--sampling expects auto|linear|flat, got "${mode}"`);
      tunes.samplingMode = idx;
    } else if (a === "--verbose" || a === "-V") verbose = true;
    else if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
    else selectors.push(a);
  }
  return { flags: { tunes, verbose, buildOnly: false }, selectors };
}

export async function findBenchFiles(selectors: string[]): Promise<string[]> {
  const patterns = selectors.length > 0 ? selectors : [DEFAULT_GLOB];
  const files: string[] = [];
  for (const pattern of patterns) {
    if (fs.existsSync(pattern) && fs.statSync(pattern).isFile()) {
      files.push(pattern);
      continue;
    }
    files.push(...(await glob(pattern, { nodir: true })));
  }
  return [...new Set(files)].filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts")).sort();
}

function resolveWasiShimConfig(): string {
  let resolved: string;
  try {
    // resolve against the consuming project first, then as-bench's own deps
    resolved = createRequire(path.join(process.cwd(), "package.json")).resolve("@assemblyscript/wasi-shim/asconfig.json");
  } catch {
    resolved = require.resolve("@assemblyscript/wasi-shim/asconfig.json");
  }
  // asc mis-resolves the config's relative "lib" entry when the --config path
  // is absolute; hand it a cwd-relative path instead.
  return path.relative(process.cwd(), resolved);
}

export async function buildBenchFile(file: string): Promise<string> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outWasm = path.join(OUT_DIR, path.basename(file).replace(/\.ts$/, ".wasm"));

  const asc = await import("assemblyscript/dist/asc.js");
  const argv = [file, "--transform", path.join(PKG_ROOT, "transform/lib/index.js"), "--config", resolveWasiShimConfig(), "--outFile", outWasm, "--optimize"];
  const { error, stderr } = await asc.main(argv);
  if (error) {
    process.stderr.write(stderr.toString());
    throw new Error(`asc failed on ${file}: ${error.message}`);
  }
  return outWasm;
}

// --- rendering ----------------------------------------------------------------

/** Format a duration given in milliseconds with criterion-style units. */
export function formatTime(ms: number): string {
  if (!Number.isFinite(ms)) return "?";
  const ns = ms * 1e6;
  if (ns < 1e3) return `${ns.toFixed(2)} ns`;
  if (ns < 1e6) return `${(ns / 1e3).toFixed(2)} µs`;
  if (ns < 1e9) return `${(ns / 1e6).toFixed(2)} ms`;
  return `${(ns / 1e9).toFixed(3)} s`;
}

function formatIters(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

const ESTIMATE_NAMES: Record<number, string> = {
  [EstimateKind.Mean]: "mean",
  [EstimateKind.Median]: "median",
  [EstimateKind.StdDev]: "std dev",
  [EstimateKind.MAD]: "MAD",
  [EstimateKind.Slope]: "slope",
};

class Renderer implements BenchReporter {
  private current = "";
  private sampleCount = 0;
  private suiteName: string | null = null;
  private suiteBaseline: string | null = null;
  private readonly tty = process.stdout.isTTY === true;

  constructor(private verbose: boolean) {}

  private status(text: string): void {
    if (!this.tty) return;
    process.stdout.write(`\r\x1b[2K${chalk.dim(text)}`);
  }

  private clearStatus(): void {
    if (this.tty) process.stdout.write("\r\x1b[2K");
  }

  private label(): string {
    return this.suiteName !== null ? `${this.suiteName}/${this.current}` : this.current;
  }

  suiteStart(name: string): void {
    this.suiteName = name;
    this.suiteBaseline = null;
    console.log(chalk.bold(`\n${name}`));
  }

  suiteEnd(): void {
    this.suiteName = null;
    this.suiteBaseline = null;
  }

  benchStart(name: string): void {
    this.current = name;
    if (this.suiteName !== null && this.suiteBaseline === null) this.suiteBaseline = name;
  }

  warmupStarted(ms: number): void {
    this.status(`Benchmarking ${this.label()}: warming up for ${formatTime(ms)}`);
  }

  measureStarted(estimatedMs: number, totalIters: number, samples: number): void {
    this.sampleCount = samples;
    this.status(`Benchmarking ${this.label()}: collecting ${samples} samples in estimated ${formatTime(estimatedMs)} (${formatIters(totalIters)} iterations)`);
  }

  analyzing(): void {
    this.status(`Benchmarking ${this.label()}: analyzing`);
  }

  faultyConfig(linear: boolean, actualMs: number, recommendedSamples: number): void {
    this.clearStatus();
    console.log(chalk.yellow(`warning: unable to complete ${this.sampleCount || "the configured"} samples in the measurement time for ${this.label()} ` + `(${linear ? "linear" : "flat"} sampling needs ~${formatTime(actualMs)}); ` + `consider --measure ${Math.ceil(actualMs)} or --samples ${recommendedSamples}`));
  }

  faultyBenchmark(): void {
    this.clearStatus();
    console.log(chalk.yellow(`warning: ${this.label()} measured a 0ms sample — timer resolution too low, or the routine was optimized away (wrap work in blackbox())`));
  }

  estimate(kind: number, lb: number, point: number, hb: number): void {
    if (!this.verbose) return;
    this.clearStatus();
    const name = (ESTIMATE_NAMES[kind] ?? `estimate ${kind}`).padEnd(8);
    console.log(chalk.dim(`  ${name} [${formatTime(lb)} ${formatTime(point)} ${formatTime(hb)}]`));
  }

  result(lb: number, point: number, hb: number): void {
    this.clearStatus();
    const name = this.label().padEnd(24);
    console.log(`${chalk.bold(name)} time: [${formatTime(lb)} ${chalk.bold(formatTime(point))} ${formatTime(hb)}]`);
  }

  suiteChange(lb: number, point: number, hb: number, pValue: number): void {
    const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
    const significant = pValue < SIGNIFICANCE_LEVEL;
    const cmp = significant ? "<" : ">";
    let verdict: string;
    if (!significant || (Math.abs(point) < NOISE_THRESHOLD && lb < 0 && hb > 0)) {
      verdict = chalk.dim("no change vs");
    } else if (point < 0) {
      verdict = chalk.green("faster than");
    } else {
      verdict = chalk.red("slower than");
    }
    console.log(`${"".padEnd(24)} delta: [${pct(lb)} ${chalk.bold(pct(point))} ${pct(hb)}] (p = ${pValue.toFixed(2)} ${cmp} ${SIGNIFICANCE_LEVEL}) ${verdict} ${this.suiteBaseline}`);
  }

  outliers(los: number, lom: number, him: number, his: number): void {
    const total = los + lom + him + his;
    if (total === 0 || this.sampleCount === 0) return;
    const pct = (n: number) => `${Math.round((n / this.sampleCount) * 100)}%`;
    console.log(`Found ${total} outliers among ${this.sampleCount} measurements (${pct(total)})`);
    if (los > 0) console.log(`  ${los} (${pct(los)}) low severe`);
    if (lom > 0) console.log(`  ${lom} (${pct(lom)}) low mild`);
    if (him > 0) console.log(`  ${him} (${pct(him)}) high mild`);
    if (his > 0) console.log(`  ${his} (${pct(his)}) high severe`);
  }

  benchEnd(): void {
    this.clearStatus();
  }
}

// --- commands -------------------------------------------------------------------

export async function executeRun(args: string[]): Promise<void> {
  const { flags, selectors } = parseRunFlags(args);
  const files = await findBenchFiles(selectors);
  if (files.length === 0) {
    console.error(chalk.red(`no benchmark files found (looked for ${selectors.length ? selectors.join(", ") : DEFAULT_GLOB})`));
    process.exitCode = 1;
    return;
  }

  for (const file of files) {
    console.log(chalk.dim(`compiling ${file}`));
    const wasmPath = await buildBenchFile(file);
    if (flags.buildOnly) {
      console.log(chalk.dim(`built ${wasmPath}`));
      continue;
    }
    await runBenchFile(wasmPath, new Renderer(flags.verbose), flags.tunes);
  }
}

export async function executeBuild(args: string[]): Promise<void> {
  const { flags, selectors } = parseRunFlags(args);
  flags.buildOnly = true;
  const files = await findBenchFiles(selectors);
  if (files.length === 0) {
    console.error(chalk.red(`no benchmark files found`));
    process.exitCode = 1;
    return;
  }
  for (const file of files) {
    console.log(chalk.dim(`compiling ${file}`));
    const wasmPath = await buildBenchFile(file);
    console.log(chalk.dim(`built ${wasmPath}`));
  }
}
