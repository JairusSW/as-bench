// Public as-bench API. A benchmark file imports these and declares benchmarks;
// there is no deferred run() entry point — the file's top-level code IS the
// run (as-tral style: it executes at module start), and `bench()` drives the
// statistics engine immediately when called.

import * as engine from "./engine";
import * as host from "./util/host";

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
 *
 * Pass `elementsPerCall` to also report throughput (elements or bytes per
 * second). For example, if your routine processes 1024 bytes, pass 1024.
 * The host receives a `throughput(lb, point, hb)` call in elem/s after `result`.
 */
export function bench(description: string, routine: () => void, elementsPerCall: f64 = 0): void {
  engine.runBench(description, routine, elementsPerCall);
}

/** Options for .chart() on a suite handle. */
export class ChartOptions {
  /** Chart orientation: "bar" (horizontal) or "histogram" (vertical columns). */
  type: string = "bar";
  /** Y/X axis scaling: "linear" (proportional) or "log2" (logarithmic base-2). */
  scale: string = "linear";
  /** Print the ASCII chart to the terminal. Default false — SVG is always saved. */
  show: boolean = false;
}

/** Returned by suite(); supports optional chart output via .chart(). */
export class SuiteHandle {
  private suiteName: string;
  constructor(name: string) {
    this.suiteName = name;
  }
  /**
   * Render a bar chart of the suite's bench results — ASCII in the terminal
   * plus an SVG saved to `.as-bench/charts/<suite>.svg`.
   *
   *   suite("Sorting", () => { ... }).chart({ type: "bar" });
   */
  chart(opts: ChartOptions = new ChartOptions()): SuiteHandle {
    // encode as "type:scale:show" — host splits on ":" to recover all fields
    host.suiteChart(this.suiteName, opts.type + ":" + opts.scale + ":" + (opts.show ? "1" : "0"));
    return this;
  }
}

/**
 * Group related benchmarks. The first `bench()` in the suite is the baseline;
 * each subsequent one additionally reports its delta against that baseline
 * (bootstrap CI on the mean ratio + permutation-test p-value).
 *
 * Returns a `SuiteHandle` you can chain `.chart()` on for visual output.
 */
export function suite(description: string, body: () => void): SuiteHandle {
  engine.beginSuite(description);
  body();
  engine.endSuite();
  return new SuiteHandle(description);
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
