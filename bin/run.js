import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { glob } from "glob";
import { runBenchFile, TUNE_KEYS, EstimateKind } from "../lib/build/host.js";
import { FrameParser } from "../lib/build/wipc.js";
import { loadConfig, tunesFromSettings, toRuntimeEntries } from "./config.js";
const require = createRequire(import.meta.url);
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Match a bench name against a single glob-like pattern (case-insensitive). */
function matchGlob(pattern, name) {
  if (!pattern.includes("*")) return name.toLowerCase().includes(pattern.toLowerCase());
  const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
  return re.test(name);
}
/** Build a filter function from a list of patterns (OR semantics). */
export function makeFilter(patterns) {
  return (name) => patterns.some((p) => matchGlob(p, name));
}
// How to invoke known external runtimes: argv builder given env pairs + file.
const RUNTIME_TEMPLATES = {
  wasmtime: (env, file) => ({ cmd: "wasmtime", args: ["run", ...env.map((e) => `--env=${e}`), file] }),
  wasmer: (env, file) => ({ cmd: "wasmer", args: ["run", ...env.map((e) => `--env=${e}`), file] }),
  wazero: (env, file) => ({ cmd: "wazero", args: ["run", ...env.flatMap((e) => ["-env", e]), file] }),
};
export function parseRunFlags(args) {
  const tunes = {};
  const selectors = [];
  let verbose = false;
  let saveBaseline;
  let baseline;
  const runtimes = [];
  let configPath;
  let mode;
  const filters = [];
  let json = false;
  const num = (name, v) => {
    const n = Number(v);
    if (v === undefined || !Number.isFinite(n)) throw new Error(`${name} expects a number, got "${v}"`);
    return n;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--warmup") tunes.warmupTime = num(a, args[++i]);
    else if (a === "--warmup-tolerance") tunes.warmupTolerance = num(a, args[++i]);
    else if (a === "--warmup-min") tunes.warmupMinTime = num(a, args[++i]);
    else if (a === "--measure") tunes.measurementTime = num(a, args[++i]);
    else if (a === "--samples") tunes.sampleSize = num(a, args[++i]);
    else if (a === "--resamples") tunes.numResamples = num(a, args[++i]);
    else if (a === "--confidence") tunes.confidenceLevel = num(a, args[++i]);
    else if (a === "--sampling") {
      const mode = args[++i];
      const idx = ["auto", "linear", "flat"].indexOf(mode ?? "");
      if (idx < 0) throw new Error(`--sampling expects auto|linear|flat, got "${mode}"`);
      tunes.samplingMode = idx;
    } else if (a === "--save-baseline") {
      saveBaseline = args[++i];
      if (!saveBaseline || saveBaseline.startsWith("-")) throw new Error("--save-baseline expects an id");
    } else if (a === "--baseline") {
      baseline = args[++i];
      if (!baseline || baseline.startsWith("-")) throw new Error("--baseline expects an id");
    } else if (a === "--deterministic") tunes.deterministic = 1;
    else if (a === "--runtime") {
      const runtime = args[++i] ?? "";
      if (!runtime || runtime.startsWith("-")) throw new Error('--runtime expects node|wasmtime|wasmer|wazero or a command like "wazero run <file>" (repeat the flag to compare runtimes)');
      runtimes.push(runtime);
    } else if (a === "--config") {
      configPath = args[++i];
      if (!configPath || configPath.startsWith("-")) throw new Error("--config expects a path");
    } else if (a === "--mode") {
      mode = args[++i];
      if (!mode || mode.startsWith("-")) throw new Error("--mode expects a mode name");
    } else if (a === "--verbose" || a === "-V") verbose = true;
    else if (a === "--filter") {
      const pattern = args[++i];
      if (!pattern || pattern.startsWith("-")) throw new Error('--filter expects a pattern, e.g. --filter "fib*"');
      filters.push(pattern);
    } else if (a === "--json") json = true;
    else if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
    else selectors.push(a);
  }
  return { flags: { tunes, verbose, buildOnly: false, saveBaseline, baseline, runtimes, configPath, mode, filters, json }, selectors };
}
export async function findBenchFiles(selectors, inputGlobs) {
  const patterns = selectors.length > 0 ? selectors : inputGlobs;
  const files = [];
  for (const pattern of patterns) {
    if (fs.existsSync(pattern) && fs.statSync(pattern).isFile()) {
      files.push(pattern);
      continue;
    }
    files.push(...(await glob(pattern, { nodir: true })));
  }
  return [...new Set(files)].filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts")).sort();
}
function resolveWasiShimConfig() {
  let resolved;
  try {
    // resolve against the consuming project first, then as-bench's own deps
    resolved = createRequire(path.join(process.cwd(), "package.json")).resolve("@assemblyscript/wasi-shim/asconfig.json");
  } catch {
    resolved = require.resolve("@assemblyscript/wasi-shim/asconfig.json");
  }
  // asc mis-resolves the config's relative "lib" entry when the --config path
  // is absolute; hand it a cwd-relative path instead.
  return path.relative(process.cwd(), resolved);
}
export async function buildBenchFile(file, cfg, extraArgs = [], outSuffix = "") {
  fs.mkdirSync(cfg.outDir, { recursive: true });
  const outWasm = path.join(cfg.outDir, path.basename(file).replace(/\.ts$/, `${outSuffix}.wasm`));
  const asc = await import("assemblyscript/dist/asc.js");
  const argv = [file, "--transform", path.join(PKG_ROOT, "transform/lib/index.js"), "--config", resolveWasiShimConfig(), "--outFile", outWasm];
  if (cfg.buildOptions.optimize) argv.push("--optimize");
  if (cfg.buildOptions.debug) argv.push("--debug");
  argv.push(...cfg.buildOptions.args, ...extraArgs);
  const { error, stderr } = await asc.main(argv);
  if (error) {
    process.stderr.write(stderr.toString());
    throw new Error(`asc failed on ${file}: ${error.message}`);
  }
  return outWasm;
}
// --- rendering ----------------------------------------------------------------
/** Format a throughput value in elements/s with SI prefixes. */
function formatThroughput(elemPerSec) {
  if (!Number.isFinite(elemPerSec)) return "?";
  if (elemPerSec >= 1e9) return `${(elemPerSec / 1e9).toFixed(2)} Gelem/s`;
  if (elemPerSec >= 1e6) return `${(elemPerSec / 1e6).toFixed(2)} Melem/s`;
  if (elemPerSec >= 1e3) return `${(elemPerSec / 1e3).toFixed(2)} Kelem/s`;
  return `${elemPerSec.toFixed(2)} elem/s`;
}
function formatOpsPerSec(ms) {
  const ops = 1000 / ms;
  if (ops >= 1e9) return `${(ops / 1e9).toFixed(2)} G`;
  if (ops >= 1e6) return `${(ops / 1e6).toFixed(2)} M`;
  return Math.round(ops).toLocaleString();
}
function fmtTimeUnit(ms) {
  const ns = ms * 1e6;
  if (ns < 1e3) return { value: ns.toFixed(2), unit: "ns" };
  if (ns < 1e6) return { value: (ns / 1e3).toFixed(2), unit: "µs" };
  if (ns < 1e9) return { value: (ns / 1e6).toFixed(2), unit: "ms" };
  return { value: (ns / 1e9).toFixed(3), unit: "s" };
}
function formatTimeCells(lb, point, hb) {
  const { value: pv, unit } = fmtTimeUnit(point);
  const { value: lv } = fmtTimeUnit(lb);
  const { value: hv } = fmtTimeUnit(hb);
  return { point: `${pv} ${unit}`, ci: `[${lv}, ${hv}]` };
}
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
/** Format a duration given in milliseconds with criterion-style units. */
export function formatTime(ms) {
  if (!Number.isFinite(ms)) return "?";
  const ns = ms * 1e6;
  if (ns < 1e3) return `${ns.toFixed(2)} ns`;
  if (ns < 1e6) return `${(ns / 1e3).toFixed(2)} µs`;
  if (ns < 1e9) return `${(ns / 1e6).toFixed(2)} ms`;
  return `${(ns / 1e9).toFixed(3)} s`;
}
function formatIters(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${Math.round(n)}`;
}
const ESTIMATE_NAMES = {
  [EstimateKind.Mean]: "mean",
  [EstimateKind.Median]: "median",
  [EstimateKind.StdDev]: "std dev",
  [EstimateKind.MAD]: "MAD",
  [EstimateKind.Slope]: "slope",
};
function escSvg(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
/**
 * Returns a normalizer [0,1] for bar/column heights given the chosen scale.
 * log2: maps [fastest, slowest] to [0, 1] on a log2 axis. Fastest gets a
 * non-zero floor (1/ROWS or 1px) so it's always visible; caller clamps.
 */
function makeScaler(scale, results) {
  const fastest = Math.min(...results.map((r) => r.point));
  const slowest = Math.max(...results.map((r) => r.point));
  if (scale === "log2" && fastest > 0 && slowest > fastest) {
    const logMin = Math.log2(fastest);
    const logMax = Math.log2(slowest);
    return (point) => (Math.log2(point) - logMin) / (logMax - logMin);
  }
  return (point) => point / slowest;
}
/** Inverse of makeScaler: fraction [0,1] → time (ms). */
function makeInvScaler(scale, results) {
  const fastest = Math.min(...results.map((r) => r.point));
  const slowest = Math.max(...results.map((r) => r.point));
  if (scale === "log2" && fastest > 0 && slowest > fastest) {
    const logMin = Math.log2(fastest);
    const logMax = Math.log2(slowest);
    return (frac) => Math.pow(2, logMin + frac * (logMax - logMin));
  }
  return (frac) => frac * slowest;
}
/** Y-axis tick values for log2 scale: powers of two within [fastest, slowest]. */
function log2Ticks(fastest, slowest) {
  const ticks = [fastest];
  // walk powers of 2 from ceil(log2(fastest)) up to floor(log2(slowest))
  const start = Math.ceil(Math.log2(fastest));
  const stop = Math.floor(Math.log2(slowest));
  for (let e = start; e <= stop; e++) {
    const v = Math.pow(2, e);
    if (v > fastest && v < slowest) ticks.push(v);
  }
  ticks.push(slowest);
  return ticks;
}
function generateHistogramSvg(suiteName, results, scale = "linear") {
  const n = results.length;
  const COL_SLOT = 110;
  const W = Math.max(420, n * COL_SLOT + 80);
  const H = 320;
  const PAD_L = 54;
  const PAD_R = 20;
  const PAD_T = 58;
  const PAD_B = 72;
  const CHART_W = W - PAD_L - PAD_R;
  const CHART_H = H - PAD_T - PAD_B;
  const slowest = Math.max(...results.map((r) => r.point));
  const fastest = Math.min(...results.map((r) => r.point));
  const colW = CHART_W / n;
  const barW = Math.max(20, colW - 20);
  const scaler = makeScaler(scale, results);
  const barColor = (point) => {
    const t = slowest === fastest ? 0 : (point - fastest) / (slowest - fastest);
    const r = Math.round(0x4a + t * (0xf8 - 0x4a));
    const g = Math.round(0xde - t * (0xde - 0x71));
    const b = Math.round(0x80 + t * (0x71 - 0x80));
    const hex = (v) => v.toString(16).padStart(2, "0");
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  };
  // Y axis: log2 ticks at power-of-2 boundaries, linear at uniform intervals
  const tickVals = scale === "log2" ? log2Ticks(fastest, slowest) : Array.from({ length: 5 }, (_, i) => (i / 4) * slowest);
  const yAxisLines = tickVals
    .map((val) => {
      const frac = scaler(Math.max(val, fastest));
      const y = PAD_T + CHART_H * (1 - frac);
      return [`<line x1="${PAD_L}" y1="${y.toFixed(1)}" x2="${W - PAD_R}" y2="${y.toFixed(1)}" stroke="#f0f0f0" stroke-width="1"/>`, `<text x="${(PAD_L - 6).toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="end" class="axis">${escSvg(formatTime(val))}</text>`].join("\n");
    })
    .join("\n");
  const bars = results
    .map((r, i) => {
      const barH = Math.max(2, scaler(r.point) * CHART_H);
      const midX = PAD_L + (i + 0.5) * colW;
      const x = midX - barW / 2;
      const y = PAD_T + CHART_H - barH;
      const yLb = PAD_T + CHART_H - Math.max(0, scaler(r.lb)) * CHART_H;
      const yHb = PAD_T + CHART_H - Math.max(0, scaler(r.hb)) * CHART_H;
      const color = barColor(r.point);
      const isFastest = r.point === fastest;
      const label = escSvg(r.name.length > 13 ? r.name.slice(0, 11) + "…" : r.name);
      return [`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="3" fill="${color}" opacity="0.85"/>`, `<line x1="${midX.toFixed(1)}" y1="${yHb.toFixed(1)}" x2="${midX.toFixed(1)}" y2="${yLb.toFixed(1)}" stroke="${color}" stroke-width="2" opacity="0.5"/>`, `<line x1="${(midX - 4).toFixed(1)}" y1="${yLb.toFixed(1)}" x2="${(midX + 4).toFixed(1)}" y2="${yLb.toFixed(1)}" stroke="${color}" stroke-width="1.5" opacity="0.5"/>`, `<line x1="${(midX - 4).toFixed(1)}" y1="${yHb.toFixed(1)}" x2="${(midX + 4).toFixed(1)}" y2="${yHb.toFixed(1)}" stroke="${color}" stroke-width="1.5" opacity="0.5"/>`, `<text x="${midX.toFixed(1)}" y="${(PAD_T + CHART_H + 18).toFixed(1)}" text-anchor="middle" class="label">${label}</text>`, `<text x="${midX.toFixed(1)}" y="${(PAD_T + CHART_H + 36).toFixed(1)}" text-anchor="middle" class="val${isFastest ? " star" : ""}">${escSvg(formatTime(r.point))}${isFastest ? " ✦" : ""}</text>`].join("\n");
    })
    .join("\n");
  return [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`, `<style>`, `  .title { font: bold 14px system-ui,sans-serif; fill: #111827; }`, `  .sub   { font: 11px system-ui,sans-serif; fill: #9ca3af; }`, `  .axis  { font: 10px system-ui,sans-serif; fill: #9ca3af; }`, `  .label { font: 12px system-ui,sans-serif; fill: #374151; }`, `  .val   { font: 11px system-ui,sans-serif; fill: #374151; }`, `  .star  { fill: #16a34a; font-weight: 700; }`, `</style>`, `<rect width="${W}" height="${H}" rx="8" fill="#ffffff" stroke="#e5e7eb" stroke-width="1"/>`, `<text x="${W / 2}" y="26" text-anchor="middle" class="title">${escSvg(suiteName)}</text>`, `<text x="${W / 2}" y="44" text-anchor="middle" class="sub">time per iteration — lower is better — ${scale === "log2" ? "log₂" : "linear"} scale — whiskers show 95% CI</text>`, `<line x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${PAD_T + CHART_H}" stroke="#d1d5db" stroke-width="1"/>`, `<line x1="${PAD_L}" y1="${PAD_T + CHART_H}" x2="${W - PAD_R}" y2="${PAD_T + CHART_H}" stroke="#d1d5db" stroke-width="1"/>`, yAxisLines, bars, `</svg>`].join("\n");
}
function generateChartSvg(suiteName, results, scale = "linear") {
  const W = 640;
  const PAD_L = 20;
  const PAD_R = 16;
  const LABEL_W = 180;
  const BAR_X = PAD_L + LABEL_W + 8;
  const BAR_AREA = W - BAR_X - PAD_R;
  const BAR_H = 28;
  const BAR_GAP = 16;
  const ROW_H = BAR_H + BAR_GAP;
  const TITLE_H = 58;
  const FOOTER_H = 20;
  const H = TITLE_H + results.length * ROW_H + FOOTER_H;
  const slowest = Math.max(...results.map((r) => r.point));
  const fastest = Math.min(...results.map((r) => r.point));
  const scaler = makeScaler(scale, results);
  const barColor = (point) => {
    const t = slowest === fastest ? 0 : (point - fastest) / (slowest - fastest);
    const r = Math.round(0x4a + t * (0xf8 - 0x4a));
    const g = Math.round(0xde - t * (0xde - 0x71));
    const b = Math.round(0x80 + t * (0x71 - 0x80));
    const hex = (n) => n.toString(16).padStart(2, "0");
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  };
  const rows = results
    .map((r, i) => {
      const y = TITLE_H + i * ROW_H;
      const toX = (ms) => BAR_X + scaler(ms) * BAR_AREA;
      const barW = Math.max(2, toX(r.point) - BAR_X);
      const lbX = toX(Math.max(r.lb, fastest));
      const hbX = toX(r.hb);
      const color = barColor(r.point);
      const label = escSvg(r.name.length > 24 ? r.name.slice(0, 22) + "…" : r.name);
      const isFastest = r.point === fastest;
      const valText = formatTime(r.point) + (isFastest ? " ✦" : "");
      const mid = BAR_H / 2;
      return [
        `  <g transform="translate(0,${y})">`,
        `    <text x="${PAD_L + LABEL_W}" y="${mid + 5}" text-anchor="end" class="label">${label}</text>`,
        `    <rect x="${BAR_X}" y="4" width="${barW.toFixed(1)}" height="${BAR_H - 8}" rx="3" fill="${color}" opacity="0.82"/>`,
        // CI whisker: horizontal line lb→hb with vertical end-caps
        `    <line x1="${lbX.toFixed(1)}" y1="${mid}" x2="${hbX.toFixed(1)}" y2="${mid}" stroke="${color}" stroke-width="1.5" opacity="0.55"/>`,
        `    <line x1="${lbX.toFixed(1)}" y1="${mid - 5}" x2="${lbX.toFixed(1)}" y2="${mid + 5}" stroke="${color}" stroke-width="1.5" opacity="0.55"/>`,
        `    <line x1="${hbX.toFixed(1)}" y1="${mid - 5}" x2="${hbX.toFixed(1)}" y2="${mid + 5}" stroke="${color}" stroke-width="1.5" opacity="0.55"/>`,
        `    <text x="${(BAR_X + barW + 8).toFixed(1)}" y="${mid + 5}" class="val${isFastest ? " star" : ""}">${escSvg(valText)}</text>`,
        `    <line x1="${BAR_X}" y1="${BAR_H + 4}" x2="${(BAR_X + BAR_AREA).toFixed(1)}" y2="${BAR_H + 4}" stroke="#f0f0f0" stroke-width="1"/>`,
        `  </g>`,
      ].join("\n");
    })
    .join("\n");
  return [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`, `<style>`, `  .title { font: bold 14px system-ui,sans-serif; fill: #111827; }`, `  .sub   { font: 11px system-ui,sans-serif; fill: #9ca3af; }`, `  .label { font: 12px system-ui,sans-serif; fill: #374151; }`, `  .val   { font: 11px system-ui,sans-serif; fill: #374151; dominant-baseline: middle; }`, `  .star  { fill: #16a34a; font-weight: 700; }`, `</style>`, `<rect width="${W}" height="${H}" rx="8" fill="#ffffff" stroke="#e5e7eb" stroke-width="1"/>`, `<text x="${W / 2}" y="28" text-anchor="middle" class="title">${escSvg(suiteName)}</text>`, `<text x="${W / 2}" y="46" text-anchor="middle" class="sub">time per iteration — lower is better — ${scale === "log2" ? "log₂" : "linear"} scale — whiskers show 95% CI</text>`, `<line x1="${BAR_X}" y1="${TITLE_H - 6}" x2="${BAR_X}" y2="${H - FOOTER_H + 4}" stroke="#e5e7eb" stroke-width="1"/>`, rows, `</svg>`].join("\n");
}
export class Renderer {
  constructor(verbose, render = {}) {
    this.verbose = verbose;
    this.current = "";
    this.sampleCount = 0;
    this.suiteName = null;
    this.suiteBaseline = null;
    this.tty = process.stdout.isTTY === true;
    this.filter = null;
    this.skipping = false;
    this.currentSuiteResults = [];
    this.suiteBenches = [];
    this.pendingBench = null;
    this.suiteColW = { name: 9, time: 4, ops: 5, vs: 11 };
    this.suiteTableLines = 0;
    this.baselineId = null;
    this.baselineSource = null;
    this.sampleSink = null;
    this.resultSink = null;
    this.significanceLevel = render.significanceLevel ?? 0.05;
    this.noiseThreshold = render.noiseThreshold ?? 0.01;
  }
  status(text) {
    if (!this.tty) return;
    process.stdout.write(`\r\x1b[2K${chalk.dim(text)}`);
  }
  clearStatus() {
    if (this.tty) process.stdout.write("\r\x1b[2K");
  }
  label() {
    return this.suiteName !== null ? `${this.suiteName}/${this.current}` : this.current;
  }
  suiteStart(name) {
    this.suiteName = name;
    this.suiteBaseline = null;
    this.currentSuiteResults = [];
    this.suiteBenches = [];
    this.suiteColW = { name: 9, time: 4, ops: 5, vs: 11 };
    this.suiteTableLines = 0;
    console.log(`\n\n${chalk.bold(name)}`);
    console.log(chalk.dim("─".repeat(name.length)));
  }
  suiteEnd() {
    this.printSuiteOutliers();
    this.suiteBenches = [];
    this.suiteTableLines = 0;
    this.suiteName = null;
    this.suiteBaseline = null;
  }
  benchStart(name) {
    this.current = name;
    if (this.suiteName !== null && this.suiteBaseline === null) this.suiteBaseline = name;
    this.skipping = this.filter !== null && !this.filter(name);
  }
  warmupStarted(ms) {
    if (this.skipping) return;
    this.status(`Benchmarking ${this.label()}: warming up (cap ${formatTime(ms)})`);
  }
  warmupEnded(elapsedMs, met, converged) {
    if (this.skipping || !this.verbose) return;
    this.clearStatus();
    const how = converged ? "converged" : "hit cap";
    console.log(chalk.dim(`  warmup   ${formatTime(elapsedMs)} (${how}, met ${formatTime(met)})`));
  }
  measureStarted(estimatedMs, totalIters, samples) {
    if (this.skipping) return;
    this.sampleCount = samples;
    this.status(`Benchmarking ${this.label()}: collecting ${samples} samples in estimated ${formatTime(estimatedMs)} (${formatIters(totalIters)} iterations)`);
  }
  analyzing() {
    if (this.skipping) return;
    this.status(`Benchmarking ${this.label()}: analyzing`);
  }
  faultyConfig(linear, actualMs, recommendedSamples) {
    if (this.skipping) return;
    this.clearStatus();
    console.log(chalk.yellow(`warning: unable to complete ${this.sampleCount || "the configured"} samples in the measurement time for ${this.label()} ` + `(${linear ? "linear" : "flat"} sampling needs ~${formatTime(actualMs)}); ` + `consider --measure ${Math.ceil(actualMs)} or --samples ${recommendedSamples}`));
  }
  faultyBenchmark() {
    if (this.skipping) return;
    this.clearStatus();
    console.log(chalk.yellow(`warning: ${this.label()} measured a 0ms sample — timer resolution too low, or the routine was optimized away (wrap work in blackbox())`));
  }
  estimate(kind, lb, point, hb) {
    if (this.skipping || !this.verbose) return;
    this.clearStatus();
    const name = (ESTIMATE_NAMES[kind] ?? `estimate ${kind}`).padEnd(8);
    console.log(chalk.dim(`  ${name} [${formatTime(lb)} ${formatTime(point)} ${formatTime(hb)}]`));
  }
  result(lb, point, hb) {
    if (this.skipping) return;
    this.clearStatus();
    this.pendingBench = { name: this.current, lb, point, hb, hasDelta: false, deltaLb: 0, deltaPoint: 0, deltaHb: 0, pValue: 1, los: 0, lom: 0, him: 0, his: 0, sampleCount: this.sampleCount, thrpt: null };
    if (this.suiteName !== null) {
      this.currentSuiteResults.push({ name: this.current, lb, point, hb, thrpt: null });
    }
    this.resultSink?.(this.label(), point);
  }
  throughput(lb, point, hb) {
    if (this.skipping) return;
    if (this.pendingBench !== null) {
      this.pendingBench.thrpt = { lb, point, hb };
      if (this.suiteName !== null) {
        const last = this.currentSuiteResults[this.currentSuiteResults.length - 1];
        if (last) last.thrpt = { lb, point, hb };
      }
    } else {
      console.log(`    thrpt: [${formatThroughput(lb)} ${chalk.bold(formatThroughput(point))} ${formatThroughput(hb)}]`);
    }
  }
  renderDelta(lb, point, hb, pValue, vs) {
    const pct = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
    const significant = pValue < this.significanceLevel;
    const cmp = significant ? "<" : ">";
    let verdict;
    if (!significant || (lb > -this.noiseThreshold && hb < this.noiseThreshold)) {
      verdict = chalk.dim("no change vs");
    } else if (point < 0) {
      verdict = chalk.green("faster than");
    } else {
      verdict = chalk.red("slower than");
    }
    console.log(`    delta: [${pct(lb)} ${chalk.bold(pct(point))} ${pct(hb)}] (p = ${pValue.toFixed(2)} ${cmp} ${this.significanceLevel}) ${verdict} ${vs}`);
  }
  suiteChange(lb, point, hb, pValue) {
    if (this.skipping) return;
    if (this.suiteName !== null && this.pendingBench !== null) {
      this.pendingBench.hasDelta = true;
      this.pendingBench.deltaLb = lb;
      this.pendingBench.deltaPoint = point;
      this.pendingBench.deltaHb = hb;
      this.pendingBench.pValue = pValue;
    } else {
      this.renderDelta(lb, point, hb, pValue, `${this.suiteBaseline}`);
    }
  }
  change(lb, point, hb, pValue) {
    if (this.skipping) return;
    if (this.pendingBench !== null) {
      this.pendingBench.hasDelta = true;
      this.pendingBench.deltaLb = lb;
      this.pendingBench.deltaPoint = point;
      this.pendingBench.deltaHb = hb;
      this.pendingBench.pValue = pValue;
    } else {
      this.renderDelta(lb, point, hb, pValue, `baseline '${this.baselineId}'`);
    }
  }
  sampleDone(key, iters, times) {
    if (this.skipping) return;
    this.sampleSink?.(key, iters, times);
  }
  getBaseline(key, sampleCount) {
    if (this.skipping) return undefined;
    return this.baselineSource?.(key, sampleCount);
  }
  outliers(los, lom, him, his) {
    if (this.skipping) return;
    if (this.pendingBench !== null) {
      this.pendingBench.los = los;
      this.pendingBench.lom = lom;
      this.pendingBench.him = him;
      this.pendingBench.his = his;
    }
  }
  benchEnd() {
    if (!this.skipping) this.clearStatus();
    if (!this.skipping && this.pendingBench !== null) {
      if (this.suiteName !== null) {
        this.suiteBenches.push(this.pendingBench);
        this.pendingBench = null;
        this.renderSuiteRow();
      } else {
        this.printStandaloneBench(this.pendingBench);
        this.pendingBench = null;
      }
    }
    this.skipping = false;
  }
  printStandaloneBench(b) {
    const { value: pv, unit } = fmtTimeUnit(b.point);
    const { value: lv } = fmtTimeUnit(b.lb);
    const { value: hv } = fmtTimeUnit(b.hb);
    const timeStr = `${pv} ${unit} [${lv}, ${hv}]`;
    const ops = formatOpsPerSec(b.point);
    const total = b.los + b.lom + b.him + b.his;
    const rows = [
      ["time:", timeStr],
      ["ops/s:", ops],
      ["samples:", `${b.sampleCount}`],
    ];
    if (b.thrpt !== null) {
      const { value: tv, unit: tu } = fmtTimeUnit(b.thrpt.point);
      const { value: tlv } = fmtTimeUnit(b.thrpt.lb);
      const { value: thv } = fmtTimeUnit(b.thrpt.hb);
      rows.push(["thrpt:", `${tv} ${tu} [${tlv}, ${thv}]`]);
    }
    if (total > 0) rows.push(["outliers:", `${total} / ${b.sampleCount}`]);
    if (b.hasDelta) rows.push(["vs baseline:", this.fmtChangeCell(b, 1)]);
    const LW = Math.max(...rows.map(([l]) => l.length)) + 2;
    console.log("");
    console.log(chalk.bold(b.name));
    console.log(chalk.dim("─".repeat(b.name.length)));
    console.log("");
    for (const [label, value] of rows) {
      console.log(`${label.padEnd(LW)}${value}`);
    }
  }
  fmtTimeCell(b) {
    const { value: pv, unit } = fmtTimeUnit(b.point);
    const { value: lv } = fmtTimeUnit(b.lb);
    const { value: hv } = fmtTimeUnit(b.hb);
    return `${pv} ${unit} [${lv}, ${hv}]`;
  }
  fmtChangeCell(b, i) {
    if (i === 0 && !b.hasDelta) return chalk.dim("1.00×");
    if (!b.hasDelta) return "";
    const sig = b.pValue < this.significanceLevel;
    const withinNoise = b.deltaLb > -this.noiseThreshold && b.deltaHb < this.noiseThreshold;
    if (b.deltaPoint < 0) {
      const mult = (1 / (1 + b.deltaPoint)).toFixed(2);
      return sig && !withinNoise ? chalk.green(`${mult}× faster`) : chalk.dim(`${mult}×`);
    }
    const mult = (1 + b.deltaPoint).toFixed(2);
    return sig && !withinNoise ? chalk.red(`${mult}× slower`) : chalk.dim(`${mult}×`);
  }
  renderSuiteRow() {
    const benches = this.suiteBenches;
    if (benches.length === 0) return;
    const SEP = "   ";
    const timeCells = benches.map((b) => this.fmtTimeCell(b));
    const opsCells = benches.map((b) => formatOpsPerSec(b.point));
    const vsCells = benches.map((b, i) => this.fmtChangeCell(b, i));
    const nameW = Math.max(9, ...benches.map((b) => b.name.length));
    const timeW = Math.max(4, ...timeCells.map((t) => t.length));
    const opsW = Math.max(5, ...opsCells.map((o) => o.length));
    const vsW = Math.max(11, ...vsCells.map((c) => stripAnsi(c).length));
    const needsReprint = this.tty && this.suiteTableLines > 0 && (nameW > this.suiteColW.name || timeW > this.suiteColW.time || opsW > this.suiteColW.ops || vsW > this.suiteColW.vs);
    this.suiteColW = { name: nameW, time: timeW, ops: opsW, vs: vsW };
    const baselineLine = `baseline: ${this.suiteBaseline ?? benches[0].name}`;
    const header = `${"benchmark".padEnd(nameW)}${SEP}${"time".padEnd(timeW)}${SEP}${"ops/s".padEnd(opsW)}${SEP}vs baseline`;
    const sep = chalk.dim(`${"─".repeat(nameW)}${SEP}${"─".repeat(timeW)}${SEP}${"─".repeat(opsW)}${SEP}${"─".repeat(vsW)}`);
    const row = (i) => `${benches[i].name.padEnd(nameW)}${SEP}${timeCells[i].padEnd(timeW)}${SEP}${opsCells[i].padStart(opsW)}${SEP}${vsCells[i]}`;
    if (this.suiteTableLines === 0 || needsReprint) {
      if (needsReprint) process.stdout.write(`\x1b[${this.suiteTableLines}A\x1b[0J`);
      console.log("");
      console.log(baselineLine);
      console.log("");
      console.log(header);
      console.log(sep);
      for (let i = 0; i < benches.length; i++) console.log(row(i));
      this.suiteTableLines = 5 + benches.length;
    } else {
      console.log(row(benches.length - 1));
      this.suiteTableLines++;
    }
  }
  printSuiteOutliers() {
    const withOutliers = this.suiteBenches.filter((b) => b.los + b.lom + b.him + b.his > 0);
    if (withOutliers.length === 0) return;
    const nameW = Math.max(...withOutliers.map((b) => b.name.length));
    console.log("");
    console.log("outliers:");
    for (const b of withOutliers) {
      const total = b.los + b.lom + b.him + b.his;
      console.log(`  ${b.name.padEnd(nameW)}   ${total} / ${b.sampleCount}`);
    }
  }
  suiteChart(name, typeStr) {
    if (this.currentSuiteResults.length === 0) return;
    const results = this.currentSuiteResults;
    // typeStr is encoded as "type:scale:show" (scale defaults to "linear", show to "1")
    const parts = typeStr.split(":");
    const type = parts[0];
    const scale = parts[1] ?? "linear";
    const show = (parts[2] ?? "1") !== "0";
    const fastest = Math.min(...results.map((r) => r.point));
    const slowest = Math.max(...results.map((r) => r.point));
    const scaler = makeScaler(scale, results);
    if (show && type === "histogram") {
      // ASCII vertical histogram: columns grow upward, Y-axis labels on left
      const ROWS = 8;
      const colW = Math.max(...results.map((r) => r.name.length), 5);
      const GAP = 2;
      const totalW = results.length * colW + (results.length - 1) * GAP;
      const heights = results.map((r) => Math.max(1, Math.round(scaler(r.point) * ROWS)));
      // Y-axis: label top, middle, and (for log2) bottom rows
      const invScaler = makeInvScaler(scale, results);
      const labelAt = new Map();
      labelAt.set(ROWS, formatTime(invScaler(1)));
      labelAt.set(Math.round(ROWS / 2), formatTime(invScaler(0.5)));
      if (scale === "log2") labelAt.set(1, formatTime(fastest));
      const LABEL_W = Math.max(...[...labelAt.values()].map((s) => s.length));
      console.log("");
      for (let row = ROWS; row >= 1; row--) {
        const yLabel = labelAt.get(row) ?? "";
        const prefix = chalk.dim(yLabel.padStart(LABEL_W) + " │ ");
        let line = "  " + prefix;
        for (let i = 0; i < results.length; i++) {
          const isFastest = results[i].point === fastest;
          const cell = heights[i] >= row ? (isFastest ? chalk.green("█".repeat(colW)) : chalk.blue("█".repeat(colW))) : " ".repeat(colW);
          line += cell + (i < results.length - 1 ? " ".repeat(GAP) : "");
        }
        console.log(line);
      }
      const axisIndent = " ".repeat(LABEL_W + 1);
      console.log("  " + chalk.dim(axisIndent + "└─" + "─".repeat(totalW)));
      const dataIndent = " ".repeat(LABEL_W + 3);
      const nameLine = results.map((r) => chalk.dim(r.name.slice(0, colW).padEnd(colW))).join(" ".repeat(GAP));
      const timeLine = results.map((r) => (r.point === fastest ? chalk.green(chalk.bold(formatTime(r.point).slice(0, colW).padEnd(colW))) : chalk.bold(formatTime(r.point).slice(0, colW).padEnd(colW)))).join(" ".repeat(GAP));
      console.log("  " + dataIndent + nameLine);
      console.log("  " + dataIndent + timeLine);
    } else if (show) {
      // ASCII horizontal bar chart
      const BAR_W = 40;
      const labelW = Math.max(...results.map((r) => r.name.length), 4);
      console.log(chalk.dim("\n  " + "─".repeat(labelW + BAR_W + 22)));
      for (const r of results) {
        const bars = Math.max(1, Math.round(scaler(r.point) * BAR_W));
        const isFastest = r.point === fastest;
        const label = r.name.padEnd(labelW);
        const suffix = isFastest ? chalk.green(" ✦ fastest") : "";
        const barStr = isFastest ? chalk.green("█".repeat(bars)) : chalk.blue("█".repeat(bars));
        console.log(`  ${chalk.dim(label)}  ${barStr}${" ".repeat(BAR_W - bars)}  ${chalk.bold(formatTime(r.point))}${suffix}`);
      }
      console.log(chalk.dim("  " + "─".repeat(labelW + BAR_W + 22)));
    }
    // SVG file
    const chartDir = ".as-bench/charts";
    fs.mkdirSync(chartDir, { recursive: true });
    const safeName = name
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .toLowerCase();
    const fileSuffix = (type === "histogram" ? ".histogram" : "") + (scale === "log2" ? ".log2" : "");
    const outPath = path.join(chartDir, `${safeName || "suite"}${fileSuffix}.svg`);
    const svg = type === "histogram" ? generateHistogramSvg(name, results, scale) : generateChartSvg(name, results, scale);
    fs.writeFileSync(outPath, svg);
    console.log("");
    console.log(`chart: ${outPath}`);
    this.currentSuiteResults = [];
  }
}
function deltaVerdict(lb, hb, pValue, significanceLevel, noiseThreshold) {
  const significant = pValue < significanceLevel;
  if (!significant || (lb > -noiseThreshold && hb < noiseThreshold)) return "no change";
  return hb < 0 ? "faster" : "slower";
}
export class JsonReporter {
  constructor(render = {}) {
    this.benches = [];
    this.file = "";
    this.runtime = "";
    this.suiteName = null;
    this.suiteBaseline = null;
    this.current = null;
    this.baselineId = null;
    this.baselineSource = null;
    this.sampleSink = null;
    this.resultSink = null;
    this.significanceLevel = render.significanceLevel ?? 0.05;
    this.noiseThreshold = render.noiseThreshold ?? 0.01;
  }
  setContext(file, runtime) {
    this.file = file;
    this.runtime = runtime;
  }
  suiteStart(name) {
    this.suiteName = name;
    this.suiteBaseline = null;
  }
  suiteEnd() {
    this.suiteName = null;
    this.suiteBaseline = null;
  }
  benchStart(name) {
    if (this.suiteName !== null && this.suiteBaseline === null) this.suiteBaseline = name;
    const key = this.suiteName !== null ? `${this.suiteName}/${name}` : name;
    this.current = { file: this.file, runtime: this.runtime, suite: this.suiteName, name, key, result: null, throughput: null, delta: null, outliers: { lowSevere: 0, lowMild: 0, highMild: 0, highSevere: 0 }, warnings: [] };
    this.benches.push(this.current);
  }
  result(lb, point, hb) {
    if (this.current) {
      this.current.result = { lb, point, hb };
      this.resultSink?.(this.current.key, point);
    }
  }
  throughput(lb, point, hb) {
    if (this.current) this.current.throughput = { lb, point, hb };
  }
  suiteChange(lb, point, hb, pValue) {
    if (this.current) this.current.delta = { lb, point, hb, pValue, verdict: deltaVerdict(lb, hb, pValue, this.significanceLevel, this.noiseThreshold), vs: `${this.suiteBaseline}` };
  }
  change(lb, point, hb, pValue) {
    if (this.current) this.current.delta = { lb, point, hb, pValue, verdict: deltaVerdict(lb, hb, pValue, this.significanceLevel, this.noiseThreshold), vs: `baseline '${this.baselineId}'` };
  }
  outliers(los, lom, him, his) {
    if (this.current) this.current.outliers = { lowSevere: los, lowMild: lom, highMild: him, highSevere: his };
  }
  faultyConfig(linear, actualMs, recommendedSamples) {
    this.current?.warnings.push(`unable to complete samples in measurement time (${linear ? "linear" : "flat"} sampling needs ~${formatTime(actualMs)}); consider --measure ${Math.ceil(actualMs)} or --samples ${recommendedSamples}`);
  }
  faultyBenchmark() {
    this.current?.warnings.push("0ms sample — timer resolution too low, or routine was optimized away (wrap work in blackbox())");
  }
  sampleDone(key, iters, times) {
    this.sampleSink?.(key, iters, times);
  }
  getBaseline(key, sampleCount) {
    return this.baselineSource?.(key, sampleCount);
  }
  benchEnd() {}
  // Charts are skipped in JSON mode — the full result data is already in the output.
  suiteChart(_name, _type) {}
  output() {
    process.stdout.write(JSON.stringify({ version: 1, benches: this.benches }, null, 2) + "\n");
  }
}
// --- commands -------------------------------------------------------------------
/** Split a command string into argv, honoring single/double quotes. */
function tokenizeCommand(cmd) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
}
/** Run a WIPC build under an external WASI runtime, streaming frames to the reporter. */
async function runExternal(runtime, wasmPath, reporter, tunes) {
  // settings overrides travel as AS_BENCH_TUNE_<kind> env vars
  const envPairs = [];
  for (let kind = 0; kind < TUNE_KEYS.length; kind++) {
    const v = tunes[TUNE_KEYS[kind]];
    if (v !== undefined) envPairs.push(`AS_BENCH_TUNE_${kind}=${v}`);
  }
  const template = RUNTIME_TEMPLATES[runtime];
  let cmd;
  let args;
  if (template) {
    ({ cmd, args } = template(envPairs, wasmPath));
  } else {
    const tokens = tokenizeCommand(runtime);
    // a bare single word is far more likely a typo'd runtime name than a
    // zero-argument runner — require an argument or <file> to disambiguate
    if (tokens.length < 2 && !runtime.includes("<file>")) {
      throw new Error(`unknown runtime "${runtime}" — use node|${Object.keys(RUNTIME_TEMPLATES).join("|")}, or a command like "wazero run <file>" (<file> is appended when omitted)`);
    }
    // <env:PREFIX> expands the AS_BENCH_TUNE_* pairs for runtimes that don't
    // forward host env to the guest: trailing "=" fuses prefix and pair into
    // one token (--env=K=V), otherwise they become two (-env K=V)
    let hasFile = false;
    args = [];
    for (const t of tokens) {
      const env = /^<env(?::(.+))?>$/.exec(t);
      if (env) {
        const prefix = env[1];
        for (const pair of envPairs) {
          if (prefix === undefined) args.push(pair);
          else if (prefix.endsWith("=")) args.push(prefix + pair);
          else args.push(prefix, pair);
        }
        continue;
      }
      if (t.includes("<file>")) hasFile = true;
      args.push(t.split("<file>").join(wasmPath));
    }
    if (!hasFile) args.push(wasmPath);
    cmd = args.shift();
  }
  const parser = new FrameParser(reporter, (bytes) => process.stdout.write(bytes));
  const childEnv = { ...process.env, ...Object.fromEntries(envPairs.map((e) => e.split("="))) };
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "inherit"], env: childEnv });
    child.stdout.on("data", (chunk) => parser.push(new Uint8Array(chunk)));
    child.on("error", (err) => reject(new Error(`failed to spawn ${cmd}: ${err.message}`)));
    child.on("close", (code) => {
      parser.end();
      if (code !== 0) reject(new Error(`${cmd} exited with code ${code}`));
      else resolve();
    });
  });
}
function baselinePath(dir, id) {
  return path.join(dir, `${id.replace(/[^\w.-]/g, "_")}.json`);
}
function loadBaselineFile(dir, id) {
  const file = baselinePath(dir, id);
  if (!fs.existsSync(file)) {
    throw new Error(`baseline '${id}' not found (expected ${file}); create it with --save-baseline ${id}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
export async function executeRun(args) {
  const t0 = performance.now();
  const { flags, selectors } = parseRunFlags(args);
  const cfg = loadConfig(flags.configPath, flags.mode);
  // precedence: defaults < config < mode < CLI flags
  const tunes = { ...tunesFromSettings(cfg.settings), ...flags.tunes };
  if (cfg.deterministic && tunes.deterministic === undefined) tunes.deterministic = 1;
  const runtimes = flags.runtimes.length > 0 ? toRuntimeEntries(flags.runtimes.map((spec) => ({ spec }))) : cfg.runtimes;
  const verbose = flags.verbose || cfg.verbose;
  const files = await findBenchFiles(selectors, cfg.input);
  if (files.length === 0) {
    console.error(chalk.red(`no benchmark files found (looked for ${selectors.length ? selectors.join(", ") : cfg.input.join(", ")})`));
    process.exitCode = 1;
    return;
  }
  const multi = runtimes.length > 1;
  const anyExternal = runtimes.some((rt) => rt.spec !== "node");
  const anyNode = runtimes.some((rt) => rt.spec === "node");
  if (anyExternal && tunes.deterministic === 1) {
    throw new Error("--deterministic requires the node host (record/replay wraps imports in-process)");
  }
  if (anyExternal && flags.baseline) {
    console.log(chalk.yellow(`warning: --baseline comparison needs the node host (request/reply); only node runs compare, external runs can still --save-baseline`));
  }
  const loaded = anyNode && flags.baseline ? loadBaselineFile(cfg.baselineDir, flags.baseline) : null;
  const collected = {};
  const sizeMismatchWarned = new Set();
  // bench label -> runtime label -> point estimate, for the comparison table
  const comparison = new Map();
  const filter = flags.filters.length > 0 ? makeFilter(flags.filters) : null;
  const jsonReporter = flags.json ? new JsonReporter(cfg.render) : null;
  if (anyExternal && filter) {
    process.stderr.write(chalk.yellow("warning: --filter for external runtimes suppresses output but doesn't skip execution (shouldSkip requires the node host)\n"));
  }
  const deterministic = tunes.deterministic === 1;
  for (const file of files) {
    if (!flags.json) console.log(chalk.dim(`compiling ${file}${deterministic ? " (deterministic)" : ""}${anyExternal ? ` (wipc${multi ? "" : `, runtime: ${runtimes[0].label}`})` : ""}`));
    // deterministic builds route engine timing through the passthrough host
    // import so the WASI clock stays recordable for user code; external
    // runtimes get the WIPC build whose only imports are wasi_snapshot_preview1.
    // Runtimes of the same kind share one build per file.
    let wipcPath;
    let nodePath;
    for (const rt of runtimes) {
      const external = rt.spec !== "node";
      let wasmPath;
      if (external) wasmPath = wipcPath ?? (wipcPath = await buildBenchFile(file, cfg, ["--use", "AS_BENCH_WIPC=1"], ".wipc"));
      else if (deterministic) wasmPath = nodePath ?? (nodePath = await buildBenchFile(file, cfg, ["--use", "AS_BENCH_DETERMINISTIC=1"], ".det"));
      else wasmPath = nodePath ?? (nodePath = await buildBenchFile(file, cfg));
      if (flags.buildOnly) {
        if (!flags.json) console.log(chalk.dim(`built ${wasmPath}`));
        continue;
      }
      if (!flags.json && multi) console.log(chalk.cyan(`\n[${rt.label}]`));
      // with multiple runtimes, baseline keys carry the runtime label so runs
      // under different runtimes don't collide
      const fileKey = (key) => `${path.basename(file)}::${multi ? `${rt.label}::` : ""}${key}`;
      // Use a shared JsonReporter when --json, otherwise a fresh Renderer per iteration.
      const reporter = jsonReporter ?? new Renderer(verbose, cfg.render);
      if (jsonReporter) {
        jsonReporter.setContext(file, rt.label);
      } else {
        reporter.filter = filter;
      }
      reporter.baselineId = flags.baseline ?? null;
      if (loaded && !external) {
        reporter.baselineSource = (key, sampleCount) => {
          const entry = loaded.benches[fileKey(key)];
          if (!entry) return undefined;
          if (entry.sampleSize !== sampleCount) {
            if (!sizeMismatchWarned.has(key)) {
              sizeMismatchWarned.add(key);
              if (!flags.json) console.log(chalk.yellow(`warning: baseline '${flags.baseline}' for ${key} has ${entry.sampleSize} samples but this run uses ${sampleCount} — skipping comparison (match --samples to compare)`));
            }
            return undefined;
          }
          return entry;
        };
      }
      if (flags.saveBaseline) {
        reporter.sampleSink = (key, iters, times) => {
          collected[fileKey(key)] = { sampleSize: iters.length, iters: Array.from(iters), times: Array.from(times) };
        };
      }
      if (multi) {
        reporter.resultSink = (key, point) => {
          const benchKey = `${path.basename(file)}::${key}`;
          let byRuntime = comparison.get(benchKey);
          if (!byRuntime) comparison.set(benchKey, (byRuntime = new Map()));
          byRuntime.set(rt.label, point);
        };
      }
      if (external) {
        await runExternal(rt.spec, wasmPath, reporter, tunes);
      } else {
        await runBenchFile(wasmPath, reporter, tunes, {}, filter);
      }
    }
  }
  if (multi && !flags.buildOnly && comparison.size > 0) {
    console.log(chalk.bold("\nruntime comparison") + chalk.dim(" (point estimates, fastest = 1.00×)"));
    const labelWidth = Math.max(...runtimes.map((rt) => rt.label.length));
    for (const [bench, byRuntime] of comparison) {
      console.log(`\n${chalk.bold(bench)}`);
      const fastest = Math.min(...byRuntime.values());
      for (const rt of runtimes) {
        const point = byRuntime.get(rt.label);
        if (point === undefined) continue;
        const ratio = `${(point / fastest).toFixed(2)}×`;
        console.log(`  ${rt.label.padEnd(labelWidth)}  ${formatTime(point).padStart(10)}  ${point === fastest ? chalk.green(ratio) : ratio}`);
      }
    }
  }
  if (jsonReporter && !flags.buildOnly) {
    jsonReporter.output();
  }
  if (flags.saveBaseline && !flags.buildOnly) {
    fs.mkdirSync(cfg.baselineDir, { recursive: true });
    const out = { createdAt: new Date().toISOString(), benches: collected };
    fs.writeFileSync(baselinePath(cfg.baselineDir, flags.saveBaseline), JSON.stringify(out));
    if (!flags.json) console.log(chalk.dim(`\nsaved baseline '${flags.saveBaseline}' (${Object.keys(collected).length} benches) to ${baselinePath(cfg.baselineDir, flags.saveBaseline)}`));
  }
  if (!flags.json && !flags.buildOnly) {
    const elapsed = (performance.now() - t0) / 1000;
    console.log(chalk.dim(`\nfinished in ${elapsed.toFixed(1)}s`));
  }
}
export async function executeBuild(args) {
  const { flags, selectors } = parseRunFlags(args);
  flags.buildOnly = true;
  const cfg = loadConfig(flags.configPath, flags.mode);
  const files = await findBenchFiles(selectors, cfg.input);
  if (files.length === 0) {
    console.error(chalk.red(`no benchmark files found`));
    process.exitCode = 1;
    return;
  }
  const runtimes = flags.runtimes.length > 0 ? toRuntimeEntries(flags.runtimes.map((spec) => ({ spec }))) : cfg.runtimes;
  const anyExternal = runtimes.some((rt) => rt.spec !== "node");
  const anyNode = runtimes.some((rt) => rt.spec === "node");
  for (const file of files) {
    console.log(chalk.dim(`compiling ${file}${anyExternal ? " (wipc)" : ""}`));
    if (anyNode) console.log(chalk.dim(`built ${await buildBenchFile(file, cfg)}`));
    if (anyExternal) console.log(chalk.dim(`built ${await buildBenchFile(file, cfg, ["--use", "AS_BENCH_WIPC=1"], ".wipc")}`));
  }
}
