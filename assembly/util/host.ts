// Host interface for the as-bench engine. Two transports, selected at
// compile time:
//
//  - default: the `__asbench` import namespace, supplied by the thin JS
//    wrapper (lib/as-bs.ts). Strings cross as (ptr, UTF-16 code units).
//  - AS_BENCH_WIPC builds (pure-WASI runtimes — wasmtime, wasmer, ...): all
//    events stream out as WIPC-lite frames on stdout (util/wipc.ts), tune
//    overrides arrive via AS_BENCH_TUNE_<kind> environment variables, and the
//    module imports nothing beyond wasi_snapshot_preview1. Request/reply
//    features degrade: loadBaseline always misses, iter() is a no-op
//    (deterministic replay needs the node host).
//
// Everything else — the whole statistics pipeline — runs inside the wasm.

import * as wipc from "./wipc";

namespace imports {
  // @ts-ignore: decorator
  @external("__asbench", "now")
  export declare function now(): f64;
  // @ts-ignore: decorator
  @external("__asbench", "tune")
  export declare function tune(kind: i32, value: f64): f64;
  // @ts-ignore: decorator
  @external("__asbench", "benchStart")
  export declare function benchStart(ptr: usize, len: i32): void;
  // @ts-ignore: decorator
  @external("__asbench", "warmupStarted")
  export declare function warmupStarted(durationMs: f64): void;
  // @ts-ignore: decorator
  @external("__asbench", "warmupEnded")
  export declare function warmupEnded(elapsedMs: f64, met: f64, converged: i32): void;
  // @ts-ignore: decorator
  @external("__asbench", "measureStarted")
  export declare function measureStarted(estimatedMs: f64, totalIters: f64, sampleCount: i32): void;
  // @ts-ignore: decorator
  @external("__asbench", "analyzing")
  export declare function analyzing(): void;
  // @ts-ignore: decorator
  @external("__asbench", "faultyConfig")
  export declare function faultyConfig(linear: i32, actualMs: f64, recommendedSamples: f64): void;
  // @ts-ignore: decorator
  @external("__asbench", "faultyBenchmark")
  export declare function faultyBenchmark(): void;
  // @ts-ignore: decorator
  @external("__asbench", "sampleDone")
  export declare function sampleDone(itersPtr: usize, timesPtr: usize, n: i32): void;
  // @ts-ignore: decorator
  @external("__asbench", "loadBaseline")
  export declare function loadBaseline(timesPtr: usize, itersPtr: usize, n: i32): i32;
  // @ts-ignore: decorator
  @external("__asbench", "change")
  export declare function change(lb: f64, point: f64, hb: f64, pValue: f64): void;
  // @ts-ignore: decorator
  @external("__asbench", "iter")
  export declare function iter(): void;
  // @ts-ignore: decorator
  @external("__asbench", "estimate")
  export declare function estimate(kind: i32, lb: f64, point: f64, hb: f64): void;
  // @ts-ignore: decorator
  @external("__asbench", "result")
  export declare function result(lb: f64, point: f64, hb: f64): void;
  // @ts-ignore: decorator
  @external("__asbench", "outliers")
  export declare function outliers(los: i32, lom: i32, him: i32, his: i32): void;
  // @ts-ignore: decorator
  @external("__asbench", "benchEnd")
  export declare function benchEnd(): void;
  // @ts-ignore: decorator
  @external("__asbench", "suiteStart")
  export declare function suiteStart(ptr: usize, len: i32): void;
  // @ts-ignore: decorator
  @external("__asbench", "suiteChange")
  export declare function suiteChange(lb: f64, point: f64, hb: f64, pValue: f64): void;
  // @ts-ignore: decorator
  @external("__asbench", "suiteEnd")
  export declare function suiteEnd(): void;
}

/** High-resolution clock in milliseconds (engine fallback when not on WASI). */
export function now(): f64 {
  if (isDefined(AS_BENCH_WIPC)) {
    return performance.now(); // WIPC builds are WASI builds
  }
  return imports.now();
}

/**
 * Settings override hook. Kinds: 0 warmupTime, 1 measurementTime,
 * 2 sampleSize, 3 numResamples, 4 samplingMode, 5 confidenceLevel,
 * 6 warmupTolerance, 7 warmupMinTime, 8 profileMode (host-only),
 * 9 deterministic (host-only).
 */
export function tune(kind: i32, value: f64): f64 {
  if (isDefined(AS_BENCH_WIPC)) {
    const key = `AS_BENCH_TUNE_${kind}`;
    if (process.env.has(key)) {
      return F64.parseFloat(process.env.get(key));
    }
    return value;
  }
  return imports.tune(kind, value);
}

export function benchStart(name: string): void {
  if (isDefined(AS_BENCH_WIPC)) {
    wipc.benchStart(name);
    return;
  }
  imports.benchStart(changetype<usize>(name), name.length);
}

export function suiteStart(name: string): void {
  if (isDefined(AS_BENCH_WIPC)) {
    wipc.suiteStart(name);
    return;
  }
  imports.suiteStart(changetype<usize>(name), name.length);
}

export function warmupStarted(durationMs: f64): void {
  if (isDefined(AS_BENCH_WIPC)) {
    wipc.warmupStarted(durationMs);
    return;
  }
  imports.warmupStarted(durationMs);
}

export function warmupEnded(elapsedMs: f64, met: f64, converged: i32): void {
  if (isDefined(AS_BENCH_WIPC)) {
    wipc.warmupEnded(elapsedMs, met, converged);
    return;
  }
  imports.warmupEnded(elapsedMs, met, converged);
}

export function measureStarted(estimatedMs: f64, totalIters: f64, sampleCount: i32): void {
  if (isDefined(AS_BENCH_WIPC)) {
    wipc.measureStarted(estimatedMs, totalIters, sampleCount);
    return;
  }
  imports.measureStarted(estimatedMs, totalIters, sampleCount);
}

export function analyzing(): void {
  if (isDefined(AS_BENCH_WIPC)) {
    wipc.analyzing();
    return;
  }
  imports.analyzing();
}

export function faultyConfig(linear: i32, actualMs: f64, recommendedSamples: f64): void {
  if (isDefined(AS_BENCH_WIPC)) {
    wipc.faultyConfig(linear, actualMs, recommendedSamples);
    return;
  }
  imports.faultyConfig(linear, actualMs, recommendedSamples);
}

export function faultyBenchmark(): void {
  if (isDefined(AS_BENCH_WIPC)) {
    wipc.faultyBenchmark();
    return;
  }
  imports.faultyBenchmark();
}

export function sampleDone(itersPtr: usize, timesPtr: usize, n: i32): void {
  if (isDefined(AS_BENCH_WIPC)) {
    wipc.sampleDone(itersPtr, timesPtr, n);
    return;
  }
  imports.sampleDone(itersPtr, timesPtr, n);
}

export function loadBaseline(timesPtr: usize, itersPtr: usize, n: i32): i32 {
  if (isDefined(AS_BENCH_WIPC)) {
    return 0; // request/reply needs the node host
  }
  return imports.loadBaseline(timesPtr, itersPtr, n);
}

export function change(lb: f64, point: f64, hb: f64, pValue: f64): void {
  if (isDefined(AS_BENCH_WIPC)) {
    return; // unreachable: loadBaseline never hits under WIPC
  }
  imports.change(lb, point, hb, pValue);
}

export function iter(): void {
  if (isDefined(AS_BENCH_WIPC)) {
    return; // deterministic replay needs the node host
  }
  imports.iter();
}

export function estimate(kind: i32, lb: f64, point: f64, hb: f64): void {
  if (isDefined(AS_BENCH_WIPC)) {
    wipc.estimate(kind, lb, point, hb);
    return;
  }
  imports.estimate(kind, lb, point, hb);
}

export function result(lb: f64, point: f64, hb: f64): void {
  if (isDefined(AS_BENCH_WIPC)) {
    wipc.result(lb, point, hb);
    return;
  }
  imports.result(lb, point, hb);
}

export function outliers(los: i32, lom: i32, him: i32, his: i32): void {
  if (isDefined(AS_BENCH_WIPC)) {
    wipc.outliers(los, lom, him, his);
    return;
  }
  imports.outliers(los, lom, him, his);
}

export function benchEnd(): void {
  if (isDefined(AS_BENCH_WIPC)) {
    wipc.benchEnd();
    return;
  }
  imports.benchEnd();
}

export function suiteChange(lb: f64, point: f64, hb: f64, pValue: f64): void {
  if (isDefined(AS_BENCH_WIPC)) {
    wipc.suiteChange(lb, point, hb, pValue);
    return;
  }
  imports.suiteChange(lb, point, hb, pValue);
}

export function suiteEnd(): void {
  if (isDefined(AS_BENCH_WIPC)) {
    wipc.suiteEnd();
    return;
  }
  imports.suiteEnd();
}
