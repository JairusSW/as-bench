// Settings for the as-bench engine (engine.ts). Defaults mirror
// as-tral / Criterion.rs.

/** Sampling strategy for the measurement loop. */
export const enum SamplingMode {
  Auto = 0,
  Linear = 1,
  Flat = 2,
}

/**
 * Tunables for a benchmark run. Mutate via the exported `settings` instance;
 * the host may override any of these per run (CLI flags → the `tune` import).
 */
export class Settings {
  warmupTime: f64 = 3000; // ms
  measurementTime: f64 = 5000; // ms
  sampleSize: i32 = 100; // samples collected
  numResamples: i32 = 100000; // bootstrap resamples
  samplingMode: SamplingMode = SamplingMode.Auto;
  confidenceLevel: f64 = 0.95;
  significanceLevel: f64 = 0.05; // host-side: p-value threshold for "changed"
  noiseThreshold: f64 = 0.01; // host-side: ignore changes within ±1%
}
