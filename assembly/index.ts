// Public as-bench API. A benchmark file imports these and declares benchmarks;
// there is no deferred run() entry point — the file's top-level code IS the
// run (as-tral style: it executes at module start), and `bench()` drives the
// statistics engine (engine.ts, step 2) immediately when called.

import { BenchDescriptor, SuiteDescriptor, Settings } from "./types";

export { Settings, SamplingMode } from "./types";

/** Active run settings; mutated by `set()`. */
export const settings = new Settings();

/** Top-level benchmarks (declared outside any `suite`). */
export const benches: BenchDescriptor[] = [];

/** Registered suites. */
export const suites: SuiteDescriptor[] = [];

// The suite currently being populated during a `suite(...)` callback, or null
// when registering at the top level.
let currentSuite: SuiteDescriptor | null = null;

/** Override run tunables. Call before any benchmark executes. */
export function set(options: Settings): void {
  settings.warmupTime = options.warmupTime;
  settings.measurementTime = options.measurementTime;
  settings.sampleSize = options.sampleSize;
  settings.numResamples = options.numResamples;
  settings.samplingMode = options.samplingMode;
  settings.confidenceLevel = options.confidenceLevel;
  settings.significanceLevel = options.significanceLevel;
  settings.noiseThreshold = options.noiseThreshold;
}

/** Benchmark a routine. Executes immediately; inside a `suite()` it is grouped. */
export function bench(description: string, routine: () => void): void {
  const descriptor = new BenchDescriptor(description, routine);
  const suite = currentSuite;
  if (suite !== null) {
    suite.benches.push(descriptor);
  } else {
    benches.push(descriptor);
  }
  // TODO(step 2): drive the as-tral statistics engine over `routine` right
  // here (warmup → sampling → bootstrap → outliers) and stream results to the
  // host via WIPC. Suite membership only affects baseline comparison.
}

/** Register a group of related benchmarks. */
export function suite(description: string, body: () => void): void {
  const descriptor = new SuiteDescriptor(description);
  suites.push(descriptor);
  const previous = currentSuite;
  currentSuite = descriptor;
  body();
  currentSuite = previous;
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
