// Scratchpad for small as-bench demos. Not shipped, not a spec — edit freely.
//   npm run playground   (or: npm run pg)
// builds this file (transform included) and runs it on the as-bench host with
// the CLI's full renderer.

import { bench, suite, blackbox, settings } from "./index";

// Keep the playground loop snappy; bump these to criterion defaults for real
// numbers (3000 / 5000 / 100000).
settings.warmupTime = 100;
settings.measurementTime = 250;
settings.numResamples = 10000;

// --- standalone bench ---------------------------------------------------------

function fib(n: i32): i32 {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

bench("fib(20)", () => {
  blackbox<i32>(fib(blackbox<i32>(20)));
});

// --- suite with a real difference: sorting ------------------------------------
// First bench is the suite baseline; the others report their delta against it.
// Each routine re-copies the unsorted input so every iteration sorts the same
// data (otherwise iteration 2+ would sort an already-sorted array).

const SIZE = 200;
const source = new StaticArray<i32>(SIZE);
const work = new StaticArray<i32>(SIZE);

// deterministic pseudo-random fill (LCG) so every run sorts identical data
let lcg: u32 = 0x12345678;
for (let i = 0; i < SIZE; i++) {
  lcg = lcg * 1664525 + 1013904223;
  source[i] = <i32>(lcg >> 8);
}

function refill(): void {
  for (let i = 0; i < SIZE; i++) work[i] = source[i];
}

function bubbleSort(): void {
  for (let i = 0; i < SIZE - 1; i++) {
    for (let j = 0; j < SIZE - 1 - i; j++) {
      if (work[j] > work[j + 1]) {
        const t = work[j];
        work[j] = work[j + 1];
        work[j + 1] = t;
      }
    }
  }
}

function insertionSort(): void {
  for (let i = 1; i < SIZE; i++) {
    const key = work[i];
    let j = i - 1;
    while (j >= 0 && work[j] > key) {
      work[j + 1] = work[j];
      j--;
    }
    work[j + 1] = key;
  }
}

function quickSort(lo: i32, hi: i32): void {
  if (lo >= hi) return;
  const pivot = work[(lo + hi) >> 1];
  let i = lo;
  let j = hi;
  while (i <= j) {
    while (work[i] < pivot) i++;
    while (work[j] > pivot) j--;
    if (i <= j) {
      const t = work[i];
      work[i] = work[j];
      work[j] = t;
      i++;
      j--;
    }
  }
  quickSort(lo, j);
  quickSort(i, hi);
}

suite("sort 200 i32s", () => {
  bench("bubble", () => {
    refill();
    bubbleSort();
    blackbox<i32>(work[0]);
  });
  bench("insertion", () => {
    refill();
    insertionSort();
    blackbox<i32>(work[0]);
  });
  bench("quick", () => {
    refill();
    quickSort(0, SIZE - 1);
    blackbox<i32>(work[0]);
  });
});

// --- suite at the noise floor: identical-cost ops ------------------------------
// add vs mul should report "no change" — a good check that the renderer's
// noise-threshold handling keeps statistical significance honest.

suite("arith", () => {
  bench("add", () => {
    blackbox<i32>(blackbox<i32>(40) + blackbox<i32>(2));
  });
  bench("mul", () => {
    blackbox<i32>(blackbox<i32>(6) * blackbox<i32>(7));
  });
});
