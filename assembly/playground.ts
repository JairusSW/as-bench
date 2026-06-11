// Scratchpad for small as-bench demos. Not shipped, not a spec — edit freely.
//   npm run playground   (or: npm run pg)
// builds this file (transform included) and runs it on the scaffold host.

import { bench, suite, blackbox, benches, suites } from "./index";

function fib(n: i32): i32 {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

// --- registration demo (engine lands in step 2; run() is still a no-op) -----

bench("fib(20)", () => {
  blackbox<i32>(fib(20));
});

suite("arith", () => {
  bench("add", () => {
    blackbox<i32>(blackbox<i32>(40) + blackbox<i32>(2));
  });
  bench("mul", () => {
    blackbox<i32>(blackbox<i32>(6) * blackbox<i32>(7));
  });
});

console.log(`registered: ${benches.length} top-level bench(es), ${suites.length} suite(s)`);

// --- hand-rolled timing loop, stand-in until the as-tral engine is ported ---

const ITERS = 1000;
const start = Date.now();
for (let i = 0; i < ITERS; i++) {
  blackbox<i32>(fib(20));
}
const elapsed = Date.now() - start;
console.log(`fib(20) x ${ITERS}: ${elapsed}ms (~${(<f64>elapsed * 1e6) / <f64>ITERS} ns/iter)`);
