// Public as-bench API. A benchmark file imports these and declares benchmarks;
// there is no deferred run() entry point — the file's top-level code IS the
// run (as-tral style: it executes at module start), and `bench()` drives the
// statistics engine immediately when called.

import * as engine from "./engine";

export { Settings, SamplingMode } from "./types";

/**
 * Live run settings. Mutate fields before the first `bench()`:
 *
 *   settings.warmupTime = 500;       // ms
 *   settings.measurementTime = 1000; // ms
 *
 * The host CLI can override any of these per run (e.g. --samples 50).
 */
export const settings = engine.settings;

/**
 * Benchmark a routine: warmup → sampling plan → timed samples → bootstrap
 * analysis, reported to the host as it happens. Executes immediately.
 */
export function bench(description: string, routine: () => void): void {
  engine.runBench(description, routine);
}

/**
 * Group related benchmarks. The first `bench()` in the suite is the baseline;
 * each subsequent one additionally reports its delta against that baseline
 * (bootstrap CI on the mean ratio + permutation-test p-value).
 */
export function suite(description: string, body: () => void): void {
  engine.beginSuite(description);
  body();
  engine.endSuite();
}

// Scratch cell that forces a value through linear memory so the optimizer can't
// fold the benchmarked computation away. Mirrors as-tral's `blackbox`.
const blackboxArea = memory.data(128);

/** Opaque identity barrier — prevents dead-code elimination of timed work. */
// @ts-ignore: decorator
@inline
export function blackbox<T>(value: T): T {
  store<T>(blackboxArea, value);
  return load<T>(blackboxArea);
}
