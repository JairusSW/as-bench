// Dogfood benchmark for as-bench itself: `node ./bin/index.js run`.
// Short times keep the in-repo loop fast; real projects should keep the
// criterion-style defaults (3s warmup / 5s measurement).

import { bench, suite, blackbox, settings } from "../index";

settings.warmupTime = 250;
settings.measurementTime = 500;
settings.numResamples = 20000;

function fib(n: i32): i32 {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

bench("fib(20)", () => {
  blackbox<i32>(fib(blackbox<i32>(20)));
});

suite("fib", () => {
  bench("fib(15)", () => {
    blackbox<i32>(fib(blackbox<i32>(15)));
  });
  bench("fib(20)", () => {
    blackbox<i32>(fib(blackbox<i32>(20)));
  });
});
