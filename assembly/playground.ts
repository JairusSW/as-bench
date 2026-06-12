// Scratchpad for small as-bench demos. Not shipped, not a spec — edit freely.
//   npm run playground   (or: npm run pg)
// builds this file (transform included) and runs it on the as-bench host with
// the CLI's full renderer.

import { JSON } from "json-as";
import { bench, suite, blackbox, settings } from "./index";

// Keep the playground loop snappy; bump these to criterion defaults for real
// numbers (3000 / 5000 / 100000).
settings.warmupTime = 100;
settings.warmupMinTime = 25;
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

// --- host nondeterminism: Date.now goes through wasi clock_time_get ------------
// Under --deterministic the recorded timestamp (and the shim's tempbuf memory
// write) is served from the tape on every iteration after the second.

bench("Date.now", () => {
  blackbox<i64>(Date.now());
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

// --- allocation pressure --------------------------------------------------------
// Contrasting allocation patterns: many small objects vs one big buffer vs
// string growing by repeated concat. Timed runs show the GC (itcms) cost of
// each shape; `asb profile --heaviest=alloc assembly/playground.ts` shows the
// exact bytes/allocs per function. The functions are called through function
// refs (call_indirect) so --optimize can't inline them into the bench
// callbacks — inlined functions vanish from profile attribution.

function arrayChurn(n: i32): i32 {
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const a = new Array<i32>(16); // 2 allocs each: array object + backing buffer
    a[0] = i;
    acc += a[0] + a.length;
  }
  return acc;
}

function oneBigBuffer(bytes: i32): i32 {
  const b = new Uint8Array(bytes);
  b[0] = 1;
  b[bytes - 1] = 2;
  return b[0] + b[bytes - 1];
}

function stringBuild(n: i32): i32 {
  let s = ""; // each += allocates a fresh, longer string — O(n²) bytes total
  for (let i = 0; i < n; i++) s += "ab";
  return s.length;
}

const arrayChurnRef: (n: i32) => i32 = arrayChurn;
const oneBigBufferRef: (bytes: i32) => i32 = oneBigBuffer;
const stringBuildRef: (n: i32) => i32 = stringBuild;

suite("alloc", () => {
  bench("churn 64 x Array(16)", () => {
    blackbox<i32>(arrayChurnRef(blackbox<i32>(64)));
  });
  bench("one 16 KiB buffer", () => {
    blackbox<i32>(oneBigBufferRef(blackbox<i32>(16384)));
  });
  bench("string += x64", () => {
    blackbox<i32>(stringBuildRef(blackbox<i32>(64)));
  });
});

// --- json-as: real-world serialization ------------------------------------------
// json-as compiles @json classes into specialized (de)serializers — a real
// allocation-heavy workload. Needs its transform (wired into build:playground
// and the repo config's buildOptions.args). The same profile commands apply:
// `asb profile --heaviest=alloc assembly/playground.ts` shows bytes per call,
// `--heaviest=time` where the cycles go.

@json
class Vec3 {
  x: f64 = 0;
  y: f64 = 0;
  z: f64 = 0;
}


@json
class Player {
  firstName!: string;
  lastName!: string;
  age!: i32;
  pos!: Vec3;
  isVerified!: boolean;
}

const player: Player = {
  firstName: "Emmet",
  lastName: "West",
  age: 27,
  pos: { x: 3.4, y: 1.2, z: 8.3 },
  isVerified: true,
};
const playerJson = JSON.stringify<Player>(player);

function stringifyPlayer(p: Player): string {
  return JSON.stringify<Player>(p);
}

function parsePlayer(s: string): Player {
  return JSON.parse<Player>(s);
}

function parsePlayerNoAlloc(s: string): Player {
  return JSON.parse<Player>(s, player);
}

const stringifyRef: (p: Player) => string = stringifyPlayer;
const parseRef: (s: string) => Player = parsePlayer;
const parseRefNoAlloc: (s: string) => Player = parsePlayerNoAlloc;

suite("json-as", () => {
  bench("stringify Player", () => {
    blackbox<string>(stringifyRef(blackbox<Player>(player)));
  });
  bench("parse Player", () => {
    blackbox<Player>(parseRef(blackbox<string>(playerJson)));
  });
  bench("parse Player (no alloc)", () => {
    blackbox<Player>(parseRefNoAlloc(blackbox<string>(playerJson)));
  });
});
