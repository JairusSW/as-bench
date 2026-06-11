// Scratchpad for small as-bench demos. Not shipped, not a spec — edit freely.
//   npm run playground   (or: npm run pg)
// builds this file (transform included) and runs it on the as-bench host.

import { bench, suite, blackbox, settings } from "./index";

// Keep the playground loop snappy; bump these to criterion defaults for real
// numbers (3000 / 5000 / 100000).
settings.warmupTime = 100;
settings.measurementTime = 250;
settings.numResamples = 10000;

function fib(n: i32): i32 {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

bench("fib(20)", () => {
  blackbox<i32>(fib(blackbox<i32>(20)));
});

suite("arith", () => {
  bench("add", () => {
    blackbox<i32>(blackbox<i32>(40) + blackbox<i32>(2));
  });
  bench("mul", () => {
    blackbox<i32>(blackbox<i32>(6) * blackbox<i32>(7));
  });
});
