// Thin, runtime-agnostic JS host for as-bench. A runner imports `runBenchFile`
// (or the lower-level pieces) from `as-bench/lib`, and the same wasm runs
// unchanged under node bindings, WASI, etc. The statistics engine lives inside
// the wasm; this layer only supplies timing (`now`), settings overrides
// (`tune`), and the reporting channel — plus, later, the record/replay glue.

import fs from "node:fs";

export type RuntimeTarget = "bindings" | "wasi";

/** High-resolution monotonic-ish clock the wasm engine times against. */
export function now(): number {
  return performance.now();
}

/** Estimate kinds emitted by the engine's `estimate` callback. */
export enum EstimateKind {
  Mean = 0,
  Median = 1,
  StdDev = 2,
  MAD = 3,
  Slope = 4,
}

/**
 * Host-side settings overrides, applied via the engine's `tune` import. Keys
 * left undefined fall through to the values set in the benchmark file.
 * Index order matches the engine's tune kinds.
 */
export interface TuneOverrides {
  warmupTime?: number; // cap; adaptive warmup may exit earlier
  measurementTime?: number;
  sampleSize?: number;
  numResamples?: number;
  samplingMode?: number; // 0 auto, 1 linear, 2 flat
  confidenceLevel?: number;
  warmupTolerance?: number; // relative met drift considered stable; 0 = fixed-time warmup
  warmupMinTime?: number; // never judge stability before this many ms
}

const TUNE_KEYS: (keyof TuneOverrides)[] = ["warmupTime", "measurementTime", "sampleSize", "numResamples", "samplingMode", "confidenceLevel", "warmupTolerance", "warmupMinTime"];

/** A saved benchmark sample: parallel per-sample iteration counts and times (ms). */
export interface BaselineSample {
  iters: ArrayLike<number>;
  times: ArrayLike<number>;
}

/** Engine progress/result events. All optional; times are in milliseconds. */
export interface BenchReporter {
  benchStart?(name: string): void;
  warmupStarted?(durationMs: number): void;
  /** converged=true when met stabilized before the warmupTime cap. */
  warmupEnded?(elapsedMs: number, met: number, converged: boolean): void;
  measureStarted?(estimatedMs: number, totalIters: number, sampleCount: number): void;
  analyzing?(): void;
  faultyConfig?(linear: boolean, actualMs: number, recommendedSamples: number): void;
  faultyBenchmark?(): void;
  estimate?(kind: EstimateKind, lb: number, point: number, hb: number): void;
  /** Headline time: slope under linear sampling, mean under flat. */
  result?(lb: number, point: number, hb: number): void;
  outliers?(los: number, lom: number, him: number, his: number): void;
  benchEnd?(): void;
  suiteStart?(name: string): void;
  /** Delta vs the suite's first bench: ratios (-0.38 = 38% faster). */
  suiteChange?(lb: number, point: number, hb: number, pValue: number): void;
  suiteEnd?(): void;
  /** Raw sample for the bench `key` ("suite/name" or "name"); copies. */
  sampleDone?(key: string, iters: Float64Array, times: Float64Array): void;
  /** Supply a saved baseline for `key`, or undefined. Arrays must hold exactly `sampleCount` entries. */
  getBaseline?(key: string, sampleCount: number): BaselineSample | undefined;
  /** Delta vs the loaded baseline: ratios (-0.05 = 5% faster). */
  change?(lb: number, point: number, hb: number, pValue: number): void;
}

// node:wasi prints an ExperimentalWarning on first import; not actionable for
// bench users, so filter that one warning while letting others through.
let wasiWarningFiltered = false;
function filterWasiWarning(): void {
  if (wasiWarningFiltered) return;
  wasiWarningFiltered = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    if (String(warning instanceof Error ? warning.message : warning).includes("WASI")) return;
    (original as (w: string | Error, ...rest: unknown[]) => void)(warning, ...args);
  }) as typeof process.emitWarning;
}

const utf16 = new TextDecoder("utf-16le");

function readString(memory: WebAssembly.Memory, ptr: number, len: number): string {
  return utf16.decode(new Uint8Array(memory.buffer, ptr, len * 2));
}

/**
 * Build the `__asbench` import namespace the engine links against. `getMem` is
 * a thunk resolved at call time (the instance doesn't exist yet when imports
 * are constructed, and `memory.buffer` detaches on grow).
 */
export function benchImports(getMem: () => WebAssembly.Memory, reporter: BenchReporter = {}, tunes: TuneOverrides = {}): WebAssembly.ModuleImports {
  // Track the current suite/bench so key-addressed callbacks (sampleDone,
  // getBaseline) don't require every reporter to re-derive labels.
  let suiteName: string | null = null;
  let benchName = "";
  const key = () => (suiteName !== null ? `${suiteName}/${benchName}` : benchName);

  return {
    now,
    tune(kind: number, value: number): number {
      const key = TUNE_KEYS[kind];
      const override = key === undefined ? undefined : tunes[key];
      return override === undefined ? value : override;
    },
    benchStart: (ptr: number, len: number) => {
      benchName = readString(getMem(), ptr, len);
      reporter.benchStart?.(benchName);
    },
    warmupStarted: (ms: number) => reporter.warmupStarted?.(ms),
    warmupEnded: (elapsed: number, met: number, converged: number) => reporter.warmupEnded?.(elapsed, met, converged !== 0),
    measureStarted: (est: number, iters: number, samples: number) => reporter.measureStarted?.(est, iters, samples),
    analyzing: () => reporter.analyzing?.(),
    faultyConfig: (linear: number, actualMs: number, rec: number) => reporter.faultyConfig?.(linear !== 0, actualMs, rec),
    faultyBenchmark: () => reporter.faultyBenchmark?.(),
    estimate: (kind: number, lb: number, point: number, hb: number) => reporter.estimate?.(kind, lb, point, hb),
    result: (lb: number, point: number, hb: number) => reporter.result?.(lb, point, hb),
    outliers: (los: number, lom: number, him: number, his: number) => reporter.outliers?.(los, lom, him, his),
    benchEnd: () => reporter.benchEnd?.(),
    suiteStart: (ptr: number, len: number) => {
      suiteName = readString(getMem(), ptr, len);
      reporter.suiteStart?.(suiteName);
    },
    suiteChange: (lb: number, point: number, hb: number, p: number) => reporter.suiteChange?.(lb, point, hb, p),
    suiteEnd: () => {
      suiteName = null;
      reporter.suiteEnd?.();
    },
    sampleDone: (itersPtr: number, timesPtr: number, n: number) => {
      if (!reporter.sampleDone) return;
      const mem = getMem();
      // slice() copies out of linear memory — the buffers are engine scratch
      reporter.sampleDone(key(), new Float64Array(mem.buffer, itersPtr, n).slice(), new Float64Array(mem.buffer, timesPtr, n).slice());
    },
    loadBaseline: (timesPtr: number, itersPtr: number, n: number): number => {
      const baseline = reporter.getBaseline?.(key(), n);
      if (!baseline || baseline.times.length !== n || baseline.iters.length !== n) return 0;
      const mem = getMem();
      new Float64Array(mem.buffer, timesPtr, n).set(baseline.times as ArrayLike<number>);
      new Float64Array(mem.buffer, itersPtr, n).set(baseline.iters as ArrayLike<number>);
      return 1;
    },
    change: (lb: number, point: number, hb: number, p: number) => reporter.change?.(lb, point, hb, p),
  };
}

/**
 * Run a compiled benchmark module (built against the wasi-shim) to completion:
 * instantiate with WASI + `__asbench`, then `_start` executes the bench file's
 * top-level code, which drives the engine and fires the reporter as it goes.
 */
export async function runBenchFile(wasmPath: string, reporter: BenchReporter = {}, tunes: TuneOverrides = {}, extraImports: WebAssembly.Imports = {}): Promise<void> {
  const bytes = fs.readFileSync(wasmPath);
  filterWasiWarning();
  const { WASI } = await import("node:wasi");
  const wasi = new WASI({ version: "preview1", args: [wasmPath], env: {}, preopens: {} });

  let instance: WebAssembly.Instance;
  const getMem = () => instance.exports.memory as WebAssembly.Memory;

  const imports: WebAssembly.Imports = {
    wasi_snapshot_preview1: wasi.wasiImport,
    __asbench: benchImports(getMem, reporter, tunes),
    ...extraImports,
  };

  const module = await WebAssembly.compile(bytes as BufferSource);
  instance = await WebAssembly.instantiate(module, imports);
  wasi.start(instance);
}

// --- generic instantiation (used by the playground runner & custom runners) ---

function resolveRuntimeTarget(): RuntimeTarget {
  const env = process.env.AS_BENCH_RUNTIME_TARGET;
  if (env === "wasi") return "wasi";
  return "bindings";
}

function resolveWasmPath(): string {
  const env = process.env.AS_BENCH_WASM;
  if (env) return env;
  const last = process.argv[process.argv.length - 1];
  if (!last || !last.endsWith(".wasm")) {
    throw new Error("as-bench: no wasm path (set AS_BENCH_WASM or pass the .wasm as the last argument)");
  }
  return last;
}

/**
 * Default import object for plain instantiation. `env.abort` mirrors
 * AssemblyScript's abort ABI. Runners may spread additional imports on top.
 */
export function defaultImports(): WebAssembly.Imports {
  return {
    env: {
      abort(_msg: number, _file: number, line: number, column: number): void {
        throw new Error(`as-bench: wasm abort at ${line}:${column}`);
      },
    },
  };
}

async function instantiateBindings(bytes: Uint8Array, imports: WebAssembly.Imports): Promise<WebAssembly.Instance> {
  // Compile-then-instantiate (the Module overload) to keep the return type an
  // unambiguous Instance rather than a {module, instance} source. The cast
  // sidesteps the Buffer/BufferSource ArrayBufferLike mismatch in TS6 libs.
  const module = await WebAssembly.compile(bytes as BufferSource);
  return WebAssembly.instantiate(module, imports);
}

async function instantiateWasi(bytes: Uint8Array, imports: WebAssembly.Imports): Promise<WebAssembly.Instance> {
  const { WASI } = await import("node:wasi");
  const wasi = new WASI({ version: "preview1", args: process.argv, env: process.env as Record<string, string>, preopens: {} });
  const merged: WebAssembly.Imports = { wasi_snapshot_preview1: wasi.wasiImport, ...imports };
  const module = await WebAssembly.compile(bytes as BufferSource);
  const instance = await WebAssembly.instantiate(module, merged);
  // Reactor vs command: initialize when there's no _start, start otherwise.
  const exports = instance.exports as Record<string, unknown>;
  if (typeof exports._start === "function") {
    wasi.start(instance);
  } else {
    wasi.initialize(instance);
  }
  return instance;
}

/**
 * Instantiate the benchmark wasm on the active runtime target. The wasm path is
 * resolved from `AS_BENCH_WASM` or the final CLI argument; the target from
 * `AS_BENCH_RUNTIME_TARGET` (defaults to node bindings).
 */
export async function instantiate(imports: WebAssembly.Imports = defaultImports()): Promise<WebAssembly.Instance> {
  const bytes = fs.readFileSync(resolveWasmPath());
  const target = resolveRuntimeTarget();
  if (target === "wasi") {
    return instantiateWasi(bytes, imports);
  }
  return instantiateBindings(bytes, imports);
}
