import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { glob } from "glob";
import { runBenchFile, TUNE_KEYS, type BenchReporter, type TuneOverrides, type BaselineSample, EstimateKind } from "../lib/build/as-bs.js";
import { FrameParser } from "../lib/build/wipc.js";
import { loadConfig, tunesFromSettings, toRuntimeEntries, type ResolvedConfig, type RenderConfig, type RuntimeEntry } from "./config.js";

const require = createRequire(import.meta.url);
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface RunFlags {
  tunes: TuneOverrides;
  verbose: boolean;
  buildOnly: boolean;
  saveBaseline?: string;
  baseline?: string;
  /** Explicit --runtime values (repeatable); empty falls back to the config. */
  runtimes: string[];
  configPath?: string;
  mode?: string;
}

// How to invoke known external runtimes: argv builder given env pairs + file.
const RUNTIME_TEMPLATES: Record<string, (env: string[], file: string) => { cmd: string; args: string[] }> = {
  wasmtime: (env, file) => ({ cmd: "wasmtime", args: ["run", ...env.map((e) => `--env=${e}`), file] }),
  wasmer: (env, file) => ({ cmd: "wasmer", args: ["run", ...env.map((e) => `--env=${e}`), file] }),
  wazero: (env, file) => ({ cmd: "wazero", args: ["run", ...env.flatMap((e) => ["-env", e]), file] }),
};

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
  const runtimes: string[] = [];
  let configPath: string | undefined;
  let mode: string | undefined;
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
    else if (a === "--runtime") {
      const runtime = args[++i] ?? "";
      if (!runtime || runtime.startsWith("-")) throw new Error('--runtime expects node|wasmtime|wasmer|wazero or a command like "wazero run <file>" (repeat the flag to compare runtimes)');
      runtimes.push(runtime);
    } else if (a === "--config") {
      configPath = args[++i];
      if (!configPath || configPath.startsWith("-")) throw new Error("--config expects a path");
    } else if (a === "--mode") {
      mode = args[++i];
      if (!mode || mode.startsWith("-")) throw new Error("--mode expects a mode name");
    } else if (a === "--verbose" || a === "-V") verbose = true;
    else if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
    else selectors.push(a);
  }
  return { flags: { tunes, verbose, buildOnly: false, saveBaseline, baseline, runtimes, configPath, mode }, selectors };
}

export async function findBenchFiles(selectors: string[], inputGlobs: string[]): Promise<string[]> {
  const patterns = selectors.length > 0 ? selectors : inputGlobs;
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

export async function buildBenchFile(file: string, cfg: ResolvedConfig, extraArgs: string[] = [], outSuffix = ""): Promise<string> {
  fs.mkdirSync(cfg.outDir, { recursive: true });
  const outWasm = path.join(cfg.outDir, path.basename(file).replace(/\.ts$/, `${outSuffix}.wasm`));

  const asc = await import("assemblyscript/dist/asc.js");
  const argv = [file, "--transform", path.join(PKG_ROOT, "transform/lib/index.js"), "--config", resolveWasiShimConfig(), "--outFile", outWasm];
  if (cfg.buildOptions.optimize) argv.push("--optimize");
  if (cfg.buildOptions.debug) argv.push("--debug");
  argv.push(...cfg.buildOptions.args, ...extraArgs);
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
  /** Point-estimate sink (wired by the CLI for the multi-runtime comparison table). */
  resultSink: ((key: string, point: number) => void) | null = null;

  private readonly significanceLevel: number;
  private readonly noiseThreshold: number;

  constructor(
    private verbose: boolean,
    render: RenderConfig = {},
  ) {
    this.significanceLevel = render.significanceLevel ?? 0.05;
    this.noiseThreshold = render.noiseThreshold ?? 0.01;
  }

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
    this.resultSink?.(this.label(), point);
  }

  private renderDelta(lb: number, point: number, hb: number, pValue: number, vs: string): void {
    const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
    const significant = pValue < this.significanceLevel;
    const cmp = significant ? "<" : ">";
    let verdict: string;
    // criterion's rule: no change when insignificant OR the entire CI lies
    // inside the noise band
    if (!significant || (lb > -this.noiseThreshold && hb < this.noiseThreshold)) {
      verdict = chalk.dim("no change vs");
    } else if (point < 0) {
      verdict = chalk.green("faster than");
    } else {
      verdict = chalk.red("slower than");
    }
    console.log(`${"".padEnd(24)} delta: [${pct(lb)} ${chalk.bold(pct(point))} ${pct(hb)}] (p = ${pValue.toFixed(2)} ${cmp} ${this.significanceLevel}) ${verdict} ${vs}`);
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

/** Split a command string into argv, honoring single/double quotes. */
function tokenizeCommand(cmd: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
}

/** Run a WIPC build under an external WASI runtime, streaming frames to the reporter. */
async function runExternal(runtime: string, wasmPath: string, reporter: BenchReporter, tunes: TuneOverrides): Promise<void> {
  // settings overrides travel as AS_BENCH_TUNE_<kind> env vars
  const envPairs: string[] = [];
  for (let kind = 0; kind < TUNE_KEYS.length; kind++) {
    const v = tunes[TUNE_KEYS[kind]];
    if (v !== undefined) envPairs.push(`AS_BENCH_TUNE_${kind}=${v}`);
  }

  const template = RUNTIME_TEMPLATES[runtime];
  let cmd: string;
  let args: string[];
  if (template) {
    ({ cmd, args } = template(envPairs, wasmPath));
  } else {
    const tokens = tokenizeCommand(runtime);
    // a bare single word is far more likely a typo'd runtime name than a
    // zero-argument runner — require an argument or <file> to disambiguate
    if (tokens.length < 2 && !runtime.includes("<file>")) {
      throw new Error(`unknown runtime "${runtime}" — use node|${Object.keys(RUNTIME_TEMPLATES).join("|")}, or a command like "wazero run <file>" (<file> is appended when omitted)`);
    }
    // <env:PREFIX> expands the AS_BENCH_TUNE_* pairs for runtimes that don't
    // forward host env to the guest: trailing "=" fuses prefix and pair into
    // one token (--env=K=V), otherwise they become two (-env K=V)
    let hasFile = false;
    args = [];
    for (const t of tokens) {
      const env = /^<env(?::(.+))?>$/.exec(t);
      if (env) {
        const prefix = env[1];
        for (const pair of envPairs) {
          if (prefix === undefined) args.push(pair);
          else if (prefix.endsWith("=")) args.push(prefix + pair);
          else args.push(prefix, pair);
        }
        continue;
      }
      if (t.includes("<file>")) hasFile = true;
      args.push(t.split("<file>").join(wasmPath));
    }
    if (!hasFile) args.push(wasmPath);
    cmd = args.shift()!;
  }

  const parser = new FrameParser(reporter, (bytes) => process.stdout.write(bytes));
  const childEnv = { ...process.env, ...Object.fromEntries(envPairs.map((e) => e.split("=") as [string, string])) };
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "inherit"], env: childEnv });
    child.stdout.on("data", (chunk: Buffer) => parser.push(new Uint8Array(chunk)));
    child.on("error", (err) => reject(new Error(`failed to spawn ${cmd}: ${err.message}`)));
    child.on("close", (code) => {
      parser.end();
      if (code !== 0) reject(new Error(`${cmd} exited with code ${code}`));
      else resolve();
    });
  });
}

function baselinePath(dir: string, id: string): string {
  return path.join(dir, `${id.replace(/[^\w.-]/g, "_")}.json`);
}

function loadBaselineFile(dir: string, id: string): BaselineFile {
  const file = baselinePath(dir, id);
  if (!fs.existsSync(file)) {
    throw new Error(`baseline '${id}' not found (expected ${file}); create it with --save-baseline ${id}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as BaselineFile;
}

export async function executeRun(args: string[]): Promise<void> {
  const { flags, selectors } = parseRunFlags(args);
  const cfg = loadConfig(flags.configPath, flags.mode);
  // precedence: defaults < config < mode < CLI flags
  const tunes: TuneOverrides = { ...tunesFromSettings(cfg.settings), ...flags.tunes };
  if (cfg.deterministic && tunes.deterministic === undefined) tunes.deterministic = 1;
  const runtimes: RuntimeEntry[] = flags.runtimes.length > 0 ? toRuntimeEntries(flags.runtimes.map((spec) => ({ spec }))) : cfg.runtimes;
  const verbose = flags.verbose || cfg.verbose;

  const files = await findBenchFiles(selectors, cfg.input);
  if (files.length === 0) {
    console.error(chalk.red(`no benchmark files found (looked for ${selectors.length ? selectors.join(", ") : cfg.input.join(", ")})`));
    process.exitCode = 1;
    return;
  }

  const multi = runtimes.length > 1;
  const anyExternal = runtimes.some((rt) => rt.spec !== "node");
  const anyNode = runtimes.some((rt) => rt.spec === "node");
  if (anyExternal && tunes.deterministic === 1) {
    throw new Error("--deterministic requires the node host (record/replay wraps imports in-process)");
  }
  if (anyExternal && flags.baseline) {
    console.log(chalk.yellow(`warning: --baseline comparison needs the node host (request/reply); only node runs compare, external runs can still --save-baseline`));
  }

  const loaded = anyNode && flags.baseline ? loadBaselineFile(cfg.baselineDir, flags.baseline) : null;
  const collected: BaselineFile["benches"] = {};
  const sizeMismatchWarned = new Set<string>();
  // bench label -> runtime label -> point estimate, for the comparison table
  const comparison = new Map<string, Map<string, number>>();

  const deterministic = tunes.deterministic === 1;
  for (const file of files) {
    console.log(chalk.dim(`compiling ${file}${deterministic ? " (deterministic)" : ""}${anyExternal ? ` (wipc${multi ? "" : `, runtime: ${runtimes[0].label}`})` : ""}`));
    // deterministic builds route engine timing through the passthrough host
    // import so the WASI clock stays recordable for user code; external
    // runtimes get the WIPC build whose only imports are wasi_snapshot_preview1.
    // Runtimes of the same kind share one build per file.
    let wipcPath: string | undefined;
    let nodePath: string | undefined;
    for (const rt of runtimes) {
      const external = rt.spec !== "node";
      let wasmPath: string;
      if (external) wasmPath = wipcPath ??= await buildBenchFile(file, cfg, ["--use", "AS_BENCH_WIPC=1"], ".wipc");
      else if (deterministic) wasmPath = nodePath ??= await buildBenchFile(file, cfg, ["--use", "AS_BENCH_DETERMINISTIC=1"], ".det");
      else wasmPath = nodePath ??= await buildBenchFile(file, cfg);
      if (flags.buildOnly) {
        console.log(chalk.dim(`built ${wasmPath}`));
        continue;
      }
      if (multi) console.log(chalk.cyan(`\n[${rt.label}]`));

      // with multiple runtimes, baseline keys carry the runtime label so runs
      // under different runtimes don't collide
      const fileKey = (key: string) => `${path.basename(file)}::${multi ? `${rt.label}::` : ""}${key}`;
      const renderer = new Renderer(verbose, cfg.render);
      renderer.baselineId = flags.baseline ?? null;
      if (loaded && !external) {
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
      if (multi) {
        renderer.resultSink = (key, point) => {
          const benchKey = `${path.basename(file)}::${key}`;
          let byRuntime = comparison.get(benchKey);
          if (!byRuntime) comparison.set(benchKey, (byRuntime = new Map()));
          byRuntime.set(rt.label, point);
        };
      }

      if (external) {
        await runExternal(rt.spec, wasmPath, renderer, tunes);
      } else {
        await runBenchFile(wasmPath, renderer, tunes);
      }
    }
  }

  if (multi && !flags.buildOnly && comparison.size > 0) {
    console.log(chalk.bold("\nruntime comparison") + chalk.dim(" (point estimates, fastest = 1.00×)"));
    const labelWidth = Math.max(...runtimes.map((rt) => rt.label.length));
    for (const [bench, byRuntime] of comparison) {
      console.log(`\n${chalk.bold(bench)}`);
      const fastest = Math.min(...byRuntime.values());
      for (const rt of runtimes) {
        const point = byRuntime.get(rt.label);
        if (point === undefined) continue;
        const ratio = `${(point / fastest).toFixed(2)}×`;
        console.log(`  ${rt.label.padEnd(labelWidth)}  ${formatTime(point).padStart(10)}  ${point === fastest ? chalk.green(ratio) : ratio}`);
      }
    }
  }

  if (flags.saveBaseline && !flags.buildOnly) {
    fs.mkdirSync(cfg.baselineDir, { recursive: true });
    const out: BaselineFile = { createdAt: new Date().toISOString(), benches: collected };
    fs.writeFileSync(baselinePath(cfg.baselineDir, flags.saveBaseline), JSON.stringify(out));
    console.log(chalk.dim(`\nsaved baseline '${flags.saveBaseline}' (${Object.keys(collected).length} benches) to ${baselinePath(cfg.baselineDir, flags.saveBaseline)}`));
  }
}

export async function executeBuild(args: string[]): Promise<void> {
  const { flags, selectors } = parseRunFlags(args);
  flags.buildOnly = true;
  const cfg = loadConfig(flags.configPath, flags.mode);
  const files = await findBenchFiles(selectors, cfg.input);
  if (files.length === 0) {
    console.error(chalk.red(`no benchmark files found`));
    process.exitCode = 1;
    return;
  }
  const runtimes = flags.runtimes.length > 0 ? toRuntimeEntries(flags.runtimes.map((spec) => ({ spec }))) : cfg.runtimes;
  const anyExternal = runtimes.some((rt) => rt.spec !== "node");
  const anyNode = runtimes.some((rt) => rt.spec === "node");
  for (const file of files) {
    console.log(chalk.dim(`compiling ${file}${anyExternal ? " (wipc)" : ""}`));
    if (anyNode) console.log(chalk.dim(`built ${await buildBenchFile(file, cfg)}`));
    if (anyExternal) console.log(chalk.dim(`built ${await buildBenchFile(file, cfg, ["--use", "AS_BENCH_WIPC=1"], ".wipc")}`));
  }
}
