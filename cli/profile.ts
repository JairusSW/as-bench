import fs from "node:fs";
import chalk from "chalk";
import { benchImports } from "../lib/build/as-bs.js";
import { buildBenchFile, findBenchFiles } from "./run.js";
import { instrumentWasm, instrumentTimeWasm, type ProfiledFunction } from "./instrument.js";
import { loadConfig } from "./config.js";

interface ProfileFlags {
  top?: number;
  all?: boolean;
  heaviest: "instr" | "time";
  iters?: number;
  minInstrs?: number;
  configPath?: string;
  mode?: string;
}

interface FnRow {
  name: string;
  calls: bigint;
  instrs: bigint;
  cost: bigint; // statically weighted instructions
}

interface BenchProfile {
  key: string;
  total: bigint;
  totalCost: bigint;
  rows: FnRow[];
}

export function parseProfileFlags(args: string[]): { flags: ProfileFlags; selectors: string[] } {
  const flags: ProfileFlags = { heaviest: "instr" };
  const selectors: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--top") {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--top expects a positive integer`);
      flags.top = n;
    } else if (a === "--all") flags.all = true;
    else if (a === "--iters") {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--iters expects a positive integer`);
      flags.iters = n;
    } else if (a === "--min-instrs") {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 0) throw new Error(`--min-instrs expects a non-negative integer`);
      flags.minInstrs = n;
    } else if (a === "--config") {
      flags.configPath = args[++i];
      if (!flags.configPath || flags.configPath.startsWith("-")) throw new Error("--config expects a path");
    } else if (a === "--mode") {
      flags.mode = args[++i];
      if (!flags.mode || flags.mode.startsWith("-")) throw new Error("--mode expects a mode name");
    } else if (a.startsWith("--heaviest=")) {
      const mode = a.slice("--heaviest=".length);
      if (mode !== "instr" && mode !== "time") throw new Error(`--heaviest expects instr|time, got "${mode}"`);
      flags.heaviest = mode;
    } else if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
    else selectors.push(a);
  }
  return { flags, selectors };
}

async function runProfiled(wasmPath: string, functions: ProfiledFunction[]): Promise<BenchProfile[]> {
  const bytes = fs.readFileSync(wasmPath);
  const { WASI } = await import("node:wasi");
  const wasi = new WASI({ version: "preview1", args: [wasmPath], env: {}, preopens: {} });

  // assigned after instantiation; closures below resolve it at call time
  // eslint-disable-next-line prefer-const
  let instance: WebAssembly.Instance;
  const getMem = () => instance!.exports.memory as WebAssembly.Memory;

  const snapshot = (): { c: bigint[]; n: bigint[]; w: bigint[] } => {
    const exp = instance!.exports as Record<string, WebAssembly.Global>;
    return {
      c: functions.map((f) => exp[`__prof_c_${f.k}`].value as bigint),
      n: functions.map((f) => exp[`__prof_n_${f.k}`].value as bigint),
      w: functions.map((f) => exp[`__prof_w_${f.k}`].value as bigint),
    };
  };

  const profiles: BenchProfile[] = [];
  let suiteName: string | null = null;
  let benchName = "";
  let started: { c: bigint[]; n: bigint[]; w: bigint[] } | null = null;

  const reporter = {
    suiteStart: (name: string) => (suiteName = name),
    suiteEnd: () => (suiteName = null),
    benchStart: (name: string) => {
      benchName = name;
      started = snapshot();
    },
    benchEnd: () => {
      if (!started) return;
      const end = snapshot();
      const rows: FnRow[] = [];
      let total = 0n;
      let totalCost = 0n;
      for (let i = 0; i < functions.length; i++) {
        const calls = end.c[i] - started.c[i];
        const instrs = end.n[i] - started.n[i];
        if (calls === 0n && instrs === 0n) continue;
        const cost = end.w[i] - started.w[i];
        total += instrs;
        totalCost += cost;
        rows.push({ name: functions[i].name, calls, instrs, cost });
      }
      rows.sort((a, b) => (b.cost > a.cost ? 1 : b.cost < a.cost ? -1 : 0));
      profiles.push({ key: suiteName !== null ? `${suiteName}/${benchName}` : benchName, total, totalCost, rows });
      started = null;
    },
  };

  const imports: WebAssembly.Imports = {
    wasi_snapshot_preview1: wasi.wasiImport,
    __asbench: benchImports(getMem, reporter, { profileMode: 1 }),
  };
  const module = await WebAssembly.compile(bytes as BufferSource);
  instance = await WebAssembly.instantiate(module, imports);
  wasi.start(instance);
  return profiles;
}

interface TimeRow {
  name: string;
  calls: bigint;
  self: bigint; // ns, uncorrected
  incl: bigint; // ns, outermost frames only
  cc: bigint; // direct wrapped-child calls made from this function's frames
  isc: bigint; // wrapped calls in the subtree of outermost frames (corrects incl)
}

interface BenchTimeProfile {
  key: string;
  rows: TimeRow[];
  /** ns charged to a wrapped function itself per call (inside the tnow window). */
  overheadIn: number;
  /** ns charged to the caller per wrapped child call (outside the window). */
  overheadOut: number;
}

async function runTimeProfiled(wasmPath: string, functions: ProfiledFunction[], calibK: number, iters: number): Promise<BenchTimeProfile[]> {
  const bytes = fs.readFileSync(wasmPath);
  const { WASI } = await import("node:wasi");
  const wasi = new WASI({ version: "preview1", args: [wasmPath], env: {}, preopens: {} });

  // eslint-disable-next-line prefer-const
  let instance: WebAssembly.Instance;
  const getMem = () => instance!.exports.memory as WebAssembly.Memory;

  const snapshot = (): { c: bigint[]; s: bigint[]; i: bigint[]; cc: bigint[]; isc: bigint[] } => {
    const exp = instance!.exports as Record<string, WebAssembly.Global>;
    return {
      c: functions.map((f) => exp[`__tprof_c_${f.k}`].value as bigint),
      s: functions.map((f) => exp[`__tprof_s_${f.k}`].value as bigint),
      i: functions.map((f) => exp[`__tprof_i_${f.k}`].value as bigint),
      cc: functions.map((f) => exp[`__tprof_cc_${f.k}`].value as bigint),
      isc: functions.map((f) => exp[`__tprof_isc_${f.k}`].value as bigint),
    };
  };

  // Per-bench calibration: re-entrantly call the in-wasm driver right before
  // each bench's snapshot, so the overhead estimate reflects the V8 tier
  // state of that moment (a single post-run estimate is fully warm and
  // over-corrects earlier benches). The calib churn lands before the
  // snapshot; its effect on shared accumulators only touches open engine
  // frames (internal rows).
  const calibrate = (): { overheadIn: number; overheadOut: number } => {
    const exp = instance!.exports as Record<string, unknown>;
    const calibRun = exp.__tprof_calib_run as (n: number) => bigint;
    const selfGlobal = exp[`__tprof_s_${calibK}`] as WebAssembly.Global;
    calibRun(10_000); // warm the wrapper before measuring
    const N = 50_000;
    const selfBefore = selfGlobal.value as bigint;
    const total = calibRun(N);
    const overheadIn = Number((selfGlobal.value as bigint) - selfBefore) / N;
    const overheadOut = Math.max(0, Number(total) / N - overheadIn);
    return { overheadIn, overheadOut };
  };

  const profiles: BenchTimeProfile[] = [];
  let suiteName: string | null = null;
  let benchName = "";
  let started: ReturnType<typeof snapshot> | null = null;
  let overhead = { overheadIn: 0, overheadOut: 0 };

  const reporter = {
    suiteStart: (name: string) => (suiteName = name),
    suiteEnd: () => (suiteName = null),
    benchStart: (name: string) => {
      benchName = name;
      overhead = calibrate();
      started = snapshot();
    },
    benchEnd: () => {
      if (!started) return;
      const end = snapshot();
      // average the start/end estimates — the wrappers tier up during the
      // bench, so either endpoint alone is biased
      const after = calibrate();
      overhead = { overheadIn: (overhead.overheadIn + after.overheadIn) / 2, overheadOut: (overhead.overheadOut + after.overheadOut) / 2 };
      const rows: TimeRow[] = [];
      for (let i = 0; i < functions.length; i++) {
        const calls = end.c[i] - started.c[i];
        if (calls === 0n) continue;
        rows.push({
          name: functions[i].name,
          calls,
          self: end.s[i] - started.s[i],
          incl: end.i[i] - started.i[i],
          cc: end.cc[i] - started.cc[i],
          isc: end.isc[i] - started.isc[i],
        });
      }
      profiles.push({ key: suiteName !== null ? `${suiteName}/${benchName}` : benchName, rows, ...overhead });
      started = null;
    },
  };

  const imports: WebAssembly.Imports = {
    wasi_snapshot_preview1: wasi.wasiImport,
    __asbench: {
      ...benchImports(getMem, reporter, { profileMode: iters }),
      tnow: () => process.hrtime.bigint(),
    },
  };
  const module = await WebAssembly.compile(bytes as BufferSource);
  instance = await WebAssembly.instantiate(module, imports);
  wasi.start(instance);
  return profiles;
}

function formatCount(n: bigint): string {
  return n.toLocaleString("en-US");
}

function formatNs(ns: number): string {
  if (!Number.isFinite(ns)) return "-";
  if (ns < 1e3) return `${ns.toFixed(0)} ns`;
  if (ns < 1e6) return `${(ns / 1e3).toFixed(2)} µs`;
  if (ns < 1e9) return `${(ns / 1e6).toFixed(2)} ms`;
  return `${(ns / 1e9).toFixed(2)} s`;
}

// Engine/runtime bookkeeping that lands inside the snapshot window; hidden
// unless --all so user code dominates the listing. Covers both in-repo names
// (assembly/engine/...) and consumer-project names (~lib/as-bench/assembly/...).
function isInternal(name: string): boolean {
  return /(^|~lib\/as-bench\/)assembly\/(engine|util\/host|index)\b/.test(name) || name.startsWith("~lib/rt/");
}

function renderTime(file: string, profiles: BenchTimeProfile[], top: number, all: boolean, iters: number, skipped: number, minInstrs: number): void {
  console.log(chalk.bold(`\nprofile: ${file}`) + chalk.dim(` (wall-clock self time, overhead-corrected; ${iters} iterations per bench)`));
  if (skipped > 0) console.log(chalk.dim(`  ${skipped} function${skipped === 1 ? "" : "s"} under --min-instrs ${minInstrs} left unwrapped — their time folds into callers`));
  for (const p of profiles) {
    const oTotal = p.overheadIn + p.overheadOut;
    // self − own calls × inside-window cost − direct child calls × outside-window cost;
    // incl − subtree calls × full per-call cost
    const rows = p.rows
      .map((r) => ({
        ...r,
        self: Math.max(0, Number(r.self) - Number(r.calls) * p.overheadIn - Number(r.cc) * p.overheadOut),
        incl: Math.max(0, Number(r.incl) - Number(r.isc) * oTotal),
      }))
      .sort((a, b) => b.self - a.self);
    let total = 0;
    for (const r of rows) total += r.self;
    const shown = rows.filter((r) => all || !isInternal(r.name));
    console.log(`\n${chalk.bold(p.key.padEnd(24))} ${formatNs(total)} self total` + chalk.dim(` (~${oTotal.toFixed(0)} ns/call instrumentation subtracted)`));
    for (const row of shown.slice(0, top)) {
      const pct = total > 0 ? (row.self / total) * 100 : 0;
      const perCall = row.calls > 0n ? formatNs(row.self / Number(row.calls)) : "-";
      console.log(`  ${pct.toFixed(1).padStart(5)}%  ${formatNs(row.self).padStart(10)} self  ${formatNs(row.incl).padStart(10)} incl  ${formatCount(row.calls).padStart(11)} calls  ${perCall.padStart(10)}/call  ${row.name}`);
    }
    const hidden = rows.length - shown.length;
    if (hidden > 0 && !all) console.log(chalk.dim(`  (+${hidden} internal rows — --all to show)`));
  }
  console.log(chalk.dim(`\n  self excludes wrapped callees; incl counts outermost frames only (recursion-safe).`));
  console.log(chalk.dim(`  trust self times ≥ ~1µs — below that, clock granularity dominates; --heaviest=instr is exact.`));
}

function render(file: string, profiles: BenchProfile[], top: number, all: boolean): void {
  console.log(chalk.bold(`\nprofile: ${file}`) + chalk.dim(" (wasm instructions; counts exact, weights from a static cost table; 1 run per bench)"));
  for (const p of profiles) {
    console.log(`\n${chalk.bold(p.key.padEnd(24))} ${formatCount(p.totalCost)} weighted · ${formatCount(p.total)} instructions`);
    const rows = all ? p.rows : p.rows.filter((r) => !isInternal(r.name));
    for (const row of rows.slice(0, top)) {
      const pct = p.totalCost > 0n ? Number((row.cost * 10000n) / p.totalCost) / 100 : 0;
      const perCall = row.calls > 0n ? formatCount(row.cost / row.calls) : "-";
      console.log(`  ${pct.toFixed(1).padStart(5)}%  ${formatCount(row.cost).padStart(14)} wt  ${formatCount(row.instrs).padStart(14)} instrs  ${formatCount(row.calls).padStart(11)} calls  ${perCall.padStart(9)} wt/call  ${row.name}`);
    }
    const hidden = p.rows.length - rows.length;
    if (hidden > 0 && !all) console.log(chalk.dim(`  (+${hidden} internal rows — --all to show)`));
  }
}

export async function executeProfile(args: string[]): Promise<void> {
  const { flags, selectors } = parseProfileFlags(args);
  const cfg = loadConfig(flags.configPath, flags.mode);
  const top = flags.top ?? cfg.profile.top;
  const all = flags.all ?? cfg.profile.all;
  const iters = flags.iters ?? cfg.profile.iters;
  const minInstrs = flags.minInstrs ?? cfg.profile.minInstrs;

  const files = await findBenchFiles(selectors, cfg.input);
  if (files.length === 0) {
    console.error(chalk.red(`no benchmark files found`));
    process.exitCode = 1;
    return;
  }

  for (const file of files) {
    console.log(chalk.dim(`compiling ${file}`));
    // --debug keeps the name section (--optimize strips it) so the profile
    // can attribute counts to function names; codegen is still optimized
    const wasmPath = await buildBenchFile(file, cfg, ["--debug"]);
    if (flags.heaviest === "time") {
      const { wasm, functions, calibK, skipped } = await instrumentTimeWasm(fs.readFileSync(wasmPath), minInstrs);
      const instrPath = wasmPath.replace(/\.wasm$/, ".tprof.wasm");
      fs.writeFileSync(instrPath, wasm);
      console.log(chalk.dim(`wrapped ${functions.length} functions (${skipped} under --min-instrs ${minInstrs}) -> ${instrPath}`));
      const profiles = await runTimeProfiled(instrPath, functions, calibK, iters);
      renderTime(file, profiles, top, all, iters, skipped, minInstrs);
    } else {
      const { wasm, functions } = await instrumentWasm(fs.readFileSync(wasmPath));
      const instrPath = wasmPath.replace(/\.wasm$/, ".instr.wasm");
      fs.writeFileSync(instrPath, wasm);
      console.log(chalk.dim(`instrumented ${functions.length} functions -> ${instrPath}`));
      const profiles = await runProfiled(instrPath, functions);
      render(file, profiles, top, all);
    }
  }
}
