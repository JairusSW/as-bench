// Runs the compiled playground wasm on the as-bench host (lib/as-bs.ts) with a
// minimal plain-text reporter. The CLI (bin/index.js run) has the full renderer;
// this stays dependency-free on purpose.
import { runBenchFile } from "../lib/build/as-bs.js";

const wasmPath = process.argv[process.argv.length - 1];

const fmt = (ms) => {
  const ns = ms * 1e6;
  if (ns < 1e3) return `${ns.toFixed(2)} ns`;
  if (ns < 1e6) return `${(ns / 1e3).toFixed(2)} µs`;
  if (ns < 1e9) return `${(ns / 1e6).toFixed(2)} ms`;
  return `${(ns / 1e9).toFixed(3)} s`;
};

let current = "";
let suite = null;
let samples = 0;

await runBenchFile(wasmPath, {
  suiteStart: (name) => {
    suite = name;
    console.log(`\n${name}`);
  },
  suiteEnd: () => {
    suite = null;
  },
  benchStart: (name) => {
    current = suite ? `${suite}/${name}` : name;
  },
  measureStarted: (_est, _iters, n) => {
    samples = n;
  },
  result: (lb, pt, hb) => console.log(`${current.padEnd(24)} time: [${fmt(lb)} ${fmt(pt)} ${fmt(hb)}]`),
  suiteChange: (lb, pt, hb, p) => {
    const pct = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
    console.log(`${"".padEnd(24)} delta: [${pct(lb)} ${pct(pt)} ${pct(hb)}] (p = ${p.toFixed(2)})`);
  },
  outliers: (los, lom, him, his) => {
    const total = los + lom + him + his;
    if (total > 0) console.log(`Found ${total} outliers among ${samples} measurements`);
  },
});
