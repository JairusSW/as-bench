import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { glob } from "glob";
import { runBenchFile, type BenchReporter, type TuneOverrides, type BaselineSample, EstimateKind } from "../lib/build/as-bs.js";

const require = createRequire(import.meta.url);
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_GLOB = "assembly/__benches__/**/*.ts";
const OUT_DIR = ".as-bench/build";
const BASELINE_DIR = ".as-bench/baselines";

// Host-side rendering thresholds (the engine doesn't use these).
const SIGNIFICANCE_LEVEL = 0.05;
const NOISE_THRESHOLD = 0.01;

export interface RunFlags {
  tunes: TuneOverrides;
  verbose: boolean;
  buildOnly: boolean;
  saveBaseline?: string;
  baseline?: string;
}

// On-disk baseline format: .as-bench/baselines/<id>.json
interface BaselineFile {
  createdAt: string;
  benches: Record<string, { sampleSize: number; iters: number[]; times: number[] }>;
}

export function parseRunFlags(args: string[]): { flags: RunFlags; selectors: string[] } {
  const tunes: TuneOverrides = {};
  const selectors: string[] = [];
  let verbose = false;
  let saveBaseline: string | undefined;
  let baseline: string | undefined;
  const num = (name: string, v: string | undefined): number => {
    const n = Number(v);
    if (v === undefined || !Number.isFinite(n)) throw new Error(`${name} expects a number, got "${v}"`);
    return n;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--warmup") tunes.warmupTime = num(a, args[++i]);
    else if (a === "--warmup-tolerance") tunes.warmupTolerance = num(a, args[++i]);
    else if (a === "--warmup-min") tunes.warmupMinTime = num(a, args[++i]);
    else if (a === "--measure") tunes.measurementTime = num(a, args[++i]);
    else if (a === "--samples") tunes.sampleSize = num(a, args[++i]);
    else if (a === "--resamples") tunes.numResamples = num(a, args[++i]);
    else if (a === "--confidence") tunes.confidenceLevel = num(a, args[++i]);
    else if (a === "--sampling") {
      const mode = args[++i];
      const idx = ["auto", "linear", "flat"].indexOf(mode ?? "");
      if (idx < 0) throw new Error(`--sampling expects auto|linear|flat, got "${mode}"`);
      tunes.samplingMode = idx;
    } else if (a === "--save-baseline") {
      saveBaseline = args[++i];
      if (!saveBaseline || saveBaseline.startsWith("-")) throw new Error("--save-baseline expects an id");
    } else if (a === "--baseline") {
      baseline = args[++i];
      if (!baseline || baseline.startsWith("-")) throw new Error("--baseline expects an id");
    } else if (a === "--deterministic") tunes.deterministic = 1;
    else if (a === "--verbose" || a === "-V") verbose = true;
    else if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
    else selectors.push(a);
  }
  return { flags: { tunes, verbose, buildOnly: false, saveBaseline, baseline }, selectors };
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

export async function buildBenchFile(file: string, extraArgs: string[] = [], outSuffix = ""): Promise<string> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outWasm = path.join(OUT_DIR, path.basename(file).replace(/\.ts$/, `${outSuffix}.wasm`));

  const asc = await import("assemblyscript/dist/asc.js");
  const argv = [file, "--transform", path.join(PKG_ROOT, "transform/lib/index.js"), "--config", resolveWasiShimConfig(), "--outFile", outWasm, "--optimize", ...extraArgs];
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

export class Renderer implements BenchReporter {
  private current = "";
  private sampleCount = 0;
  private suiteName: string | null = null;
  private suiteBaseline: string | null = null;
  private readonly tty = process.stdout.isTTY === true;

  /** When set, `change` deltas are labeled against this baseline id. */
  baselineId: string | null = null;
  /** Saved-baseline lookup (wired by the CLI when --baseline is given). */
  baselineSource: ((key: string, sampleCount: number) => BaselineSample | undefined) | null = null;
  /** Raw-sample sink (wired by the CLI when --save-baseline is given). */
  sampleSink: ((key: string, iters: Float64Array, times: Float64Array) => void) | null = null;

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
    this.status(`Benchmarking ${this.label()}: warming up (cap ${formatTime(ms)})`);
  }

  warmupEnded(elapsedMs: number, met: number, converged: boolean): void {
    if (!this.verbose) return;
    this.clearStatus();
    const how = converged ? "converged" : "hit cap";
    console.log(chalk.dim(`  warmup   ${formatTime(elapsedMs)} (${how}, met ${formatTime(met)})`));
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

  private renderDelta(lb: number, point: number, hb: number, pValue: number, vs: string): void {
    const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
    const significant = pValue < SIGNIFICANCE_LEVEL;
    const cmp = significant ? "<" : ">";
    let verdict: string;
    // criterion's rule: no change when insignificant OR the entire CI lies
    // inside the noise band
    if (!significant || (lb > -NOISE_THRESHOLD && hb < NOISE_THRESHOLD)) {
      verdict = chalk.dim("no change vs");
    } else if (point < 0) {
      verdict = chalk.green("faster than");
    } else {
      verdict = chalk.red("slower than");
    }
    console.log(`${"".padEnd(24)} delta: [${pct(lb)} ${chalk.bold(pct(point))} ${pct(hb)}] (p = ${pValue.toFixed(2)} ${cmp} ${SIGNIFICANCE_LEVEL}) ${verdict} ${vs}`);
  }

  suiteChange(lb: number, point: number, hb: number, pValue: number): void {
    this.renderDelta(lb, point, hb, pValue, `${this.suiteBaseline}`);
  }

  change(lb: number, point: number, hb: number, pValue: number): void {
    this.renderDelta(lb, point, hb, pValue, `baseline '${this.baselineId}'`);
  }

  sampleDone(key: string, iters: Float64Array, times: Float64Array): void {
    this.sampleSink?.(key, iters, times);
  }

  getBaseline(key: string, sampleCount: number): BaselineSample | undefined {
    return this.baselineSource?.(key, sampleCount);
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

function baselinePath(id: string): string {
  return path.join(BASELINE_DIR, `${id.replace(/[^\w.-]/g, "_")}.json`);
}

function loadBaselineFile(id: string): BaselineFile {
  const file = baselinePath(id);
  if (!fs.existsSync(file)) {
    throw new Error(`baseline '${id}' not found (expected ${file}); create it with --save-baseline ${id}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as BaselineFile;
}

export async function executeRun(args: string[]): Promise<void> {
  const { flags, selectors } = parseRunFlags(args);
  const files = await findBenchFiles(selectors);
  if (files.length === 0) {
    console.error(chalk.red(`no benchmark files found (looked for ${selectors.length ? selectors.join(", ") : DEFAULT_GLOB})`));
    process.exitCode = 1;
    return;
  }

  const loaded = flags.baseline ? loadBaselineFile(flags.baseline) : null;
  const collected: BaselineFile["benches"] = {};
  const sizeMismatchWarned = new Set<string>();

  const deterministic = flags.tunes.deterministic === 1;
  for (const file of files) {
    console.log(chalk.dim(`compiling ${file}${deterministic ? " (deterministic)" : ""}`));
    // deterministic builds route engine timing through the passthrough host
    // import so the WASI clock stays recordable for user code
    const wasmPath = deterministic ? await buildBenchFile(file, ["--use", "AS_BENCH_DETERMINISTIC=1"], ".det") : await buildBenchFile(file);
    if (flags.buildOnly) {
      console.log(chalk.dim(`built ${wasmPath}`));
      continue;
    }

    const fileKey = (key: string) => `${path.basename(file)}::${key}`;
    const renderer = new Renderer(flags.verbose);
    renderer.baselineId = flags.baseline ?? null;
    if (loaded) {
      renderer.baselineSource = (key, sampleCount) => {
        const entry = loaded.benches[fileKey(key)];
        if (!entry) return undefined;
        if (entry.sampleSize !== sampleCount) {
          if (!sizeMismatchWarned.has(key)) {
            sizeMismatchWarned.add(key);
            console.log(chalk.yellow(`warning: baseline '${flags.baseline}' for ${key} has ${entry.sampleSize} samples but this run uses ${sampleCount} — skipping comparison (match --samples to compare)`));
          }
          return undefined;
        }
        return entry;
      };
    }
    if (flags.saveBaseline) {
      renderer.sampleSink = (key, iters, times) => {
        collected[fileKey(key)] = { sampleSize: iters.length, iters: Array.from(iters), times: Array.from(times) };
      };
    }

    await runBenchFile(wasmPath, renderer, flags.tunes);
  }

  if (flags.saveBaseline && !flags.buildOnly) {
    fs.mkdirSync(BASELINE_DIR, { recursive: true });
    const out: BaselineFile = { createdAt: new Date().toISOString(), benches: collected };
    fs.writeFileSync(baselinePath(flags.saveBaseline), JSON.stringify(out));
    console.log(chalk.dim(`\nsaved baseline '${flags.saveBaseline}' (${Object.keys(collected).length} benches) to ${baselinePath(flags.saveBaseline)}`));
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
