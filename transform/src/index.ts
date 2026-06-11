import { Transform } from "assemblyscript/dist/transform.js";
import { Parser } from "assemblyscript/dist/assemblyscript.js";

/**
 * as-bench compiler plugin. Hooks `asc` after parse.
 *
 * Scaffold stage: a no-op that proves the transform target builds and loads.
 * Upcoming passes (see PLAN.md):
 *   - rewrite `bench()` / `suite()` string names to stable numeric ids
 *   - lower `set({...})` settings into engine globals
 *   - (instrument.ts) Binaryen pass: per-function + global instruction counters
 * There is no run() to inject — bench files execute at module start
 * (as-tral style); the entry's top-level code is the run.
 */
export default class BenchTransform extends Transform {
  afterParse(_parser: Parser): void {
    // intentionally empty for the scaffold
  }
}
