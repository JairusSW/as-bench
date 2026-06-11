// Host imports for the as-bench engine, all under the `__asbench` namespace.
// The thin JS wrapper (lib/as-bs.ts) supplies these; everything else — the
// whole statistics pipeline — runs inside the wasm. Strings cross the boundary
// as (ptr, length-in-code-units) pairs decoded host-side as UTF-16LE.

/** High-resolution clock in milliseconds. The only import on the hot path. */
// @ts-ignore: decorator
@external("__asbench", "now")
export declare function now(): f64;

/**
 * Settings override hook. Called once per setting at each bench start with the
 * in-wasm value; the host returns either an override (CLI flag) or the value
 * unchanged. Kinds: 0 warmupTime, 1 measurementTime, 2 sampleSize,
 * 3 numResamples, 4 samplingMode, 5 confidenceLevel, 6 warmupTolerance,
 * 7 warmupMinTime.
 */
// @ts-ignore: decorator
@external("__asbench", "tune")
export declare function tune(kind: i32, value: f64): f64;

// @ts-ignore: decorator
@external("__asbench", "benchStart")
export declare function benchStart(ptr: usize, len: i32): void;

// @ts-ignore: decorator
@external("__asbench", "warmupStarted")
export declare function warmupStarted(durationMs: f64): void;

/** Warmup finished; converged=1 when met stabilized before the time cap. */
// @ts-ignore: decorator
@external("__asbench", "warmupEnded")
export declare function warmupEnded(elapsedMs: f64, met: f64, converged: i32): void;

// @ts-ignore: decorator
@external("__asbench", "measureStarted")
export declare function measureStarted(estimatedMs: f64, totalIters: f64, sampleCount: i32): void;

// @ts-ignore: decorator
@external("__asbench", "analyzing")
export declare function analyzing(): void;

/** The configured measurement time cannot fit the sampling plan. */
// @ts-ignore: decorator
@external("__asbench", "faultyConfig")
export declare function faultyConfig(linear: i32, actualMs: f64, recommendedSamples: f64): void;

/** A sample measured 0ms — timer resolution too low or routine optimized away. */
// @ts-ignore: decorator
@external("__asbench", "faultyBenchmark")
export declare function faultyBenchmark(): void;

/** Estimate kinds: 0 mean, 1 median, 2 stdDev, 3 MAD, 4 slope. */
// @ts-ignore: decorator
@external("__asbench", "estimate")
export declare function estimate(kind: i32, lb: f64, point: f64, hb: f64): void;

/** Headline time: slope when linear sampling, mean when flat. */
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

/** Delta vs the suite's first bench: bounds are ratios (e.g. -0.38 = -38%). */
// @ts-ignore: decorator
@external("__asbench", "suiteChange")
export declare function suiteChange(lb: f64, point: f64, hb: f64, pValue: f64): void;

// @ts-ignore: decorator
@external("__asbench", "suiteEnd")
export declare function suiteEnd(): void;
