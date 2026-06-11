// Core descriptors and settings for the as-bench engine. The statistics engine
// itself (warmup, sampling, bootstrap, outliers, comparison — ported from
// as-tral) lands in engine.ts in step 2; these are the shapes it operates over.

/** Sampling strategy for the measurement loop. */
export const enum SamplingMode {
  Auto = 0,
  Linear = 1,
  Flat = 2,
}

/**
 * Tunables for a benchmark run. Defaults mirror as-tral / Criterion.rs.
 * `set()` in index.ts overrides these before `run()`.
 */
export class Settings {
  warmupTime: f64 = 3000; // ms
  measurementTime: f64 = 5000; // ms
  sampleSize: i32 = 100; // samples collected
  numResamples: i32 = 100000; // bootstrap resamples
  samplingMode: SamplingMode = SamplingMode.Auto;
  confidenceLevel: f64 = 0.95;
  significanceLevel: f64 = 0.05;
  noiseThreshold: f64 = 0.01;
}

/** A single registered benchmark: a named routine to be timed. */
export class BenchDescriptor {
  description: string;
  routine: () => void;
  constructor(description: string, routine: () => void) {
    this.description = description;
    this.routine = routine;
  }
}

/** A named group of benchmarks, optionally compared against each other. */
export class SuiteDescriptor {
  description: string;
  benches: BenchDescriptor[] = [];
  constructor(description: string) {
    this.description = description;
  }
}
