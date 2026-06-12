import fs from "node:fs";
import chalk from "chalk";
import { benchImports } from "../lib/build/as-bs.js";
import { buildBenchFile, findBenchFiles } from "./run.js";
import { instrumentWasm, type ProfiledFunction } from "./instrument.js";

interface ProfileFlags {
  top: number;
  all: boolean;
  heaviest: "instr" | "time";
}

interface FnRow {
  name: string;
  calls: bigint;
  instrs: bigint;
}

interface BenchProfile {
  key: string;
  total: bigint;
  rows: FnRow[];
}

export function parseProfileFlags(args: string[]): { flags: ProfileFlags; selectors: string[] } {
  const flags: ProfileFlags = { top: 10, all: false, heaviest: "instr" };
  const selectors: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--top") {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--top expects a positive integer`);
      flags.top = n;
    } else if (a === "--all") flags.all = true;
    else if (a.startsWith("--heaviest=")) {
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

  const snapshot = (): { c: bigint[]; n: bigint[] } => {
    const exp = instance!.exports as Record<string, WebAssembly.Global>;
    return {
      c: functions.map((f) => exp[`__prof_c_${f.k}`].value as bigint),
      n: functions.map((f) => exp[`__prof_n_${f.k}`].value as bigint),
    };
  };

  const profiles: BenchProfile[] = [];
  let suiteName: string | null = null;
  let benchName = "";
  let started: { c: bigint[]; n: bigint[] } | null = null;

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
      for (let i = 0; i < functions.length; i++) {
        const calls = end.c[i] - started.c[i];
        const instrs = end.n[i] - started.n[i];
        if (calls === 0n && instrs === 0n) continue;
        total += instrs;
        rows.push({ name: functions[i].name, calls, instrs });
      }
      rows.sort((a, b) => (b.instrs > a.instrs ? 1 : b.instrs < a.instrs ? -1 : 0));
      profiles.push({ key: suiteName !== null ? `${suiteName}/${benchName}` : benchName, total, rows });
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

function formatCount(n: bigint): string {
  return n.toLocaleString("en-US");
}

// Engine/runtime bookkeeping that lands inside the snapshot window; hidden
// unless --all so user code dominates the listing. Covers both in-repo names
// (assembly/engine/...) and consumer-project names (~lib/as-bench/assembly/...).
function isInternal(name: string): boolean {
  return /(^|~lib\/as-bench\/)assembly\/(engine|util\/host|index)\b/.test(name) || name.startsWith("~lib/rt/");
}

function render(file: string, profiles: BenchProfile[], flags: ProfileFlags): void {
  console.log(chalk.bold(`\nprofile: ${file}`) + chalk.dim(" (wasm instructions, approximate; 1 run per bench)"));
  for (const p of profiles) {
    console.log(`\n${chalk.bold(p.key.padEnd(24))} ${formatCount(p.total)} instructions`);
    const rows = flags.all ? p.rows : p.rows.filter((r) => !isInternal(r.name));
    for (const row of rows.slice(0, flags.top)) {
      const pct = p.total > 0n ? Number((row.instrs * 10000n) / p.total) / 100 : 0;
      const perCall = row.calls > 0n ? formatCount(row.instrs / row.calls) : "-";
      console.log(`  ${pct.toFixed(1).padStart(5)}%  ${formatCount(row.instrs).padStart(14)}  ${formatCount(row.calls).padStart(11)} calls  ${perCall.padStart(9)}/call  ${row.name}`);
    }
    const hidden = p.rows.length - rows.length;
    if (hidden > 0 && !flags.all) console.log(chalk.dim(`  (+${hidden} internal rows — --all to show)`));
  }
}

export async function executeProfile(args: string[]): Promise<void> {
  const { flags, selectors } = parseProfileFlags(args);
  if (flags.heaviest === "time") {
    console.log(chalk.yellow("profile --heaviest=time: not yet implemented (instrumented per-function timers land later); use --heaviest=instr"));
    process.exitCode = 1;
    return;
  }

  const files = await findBenchFiles(selectors);
  if (files.length === 0) {
    console.error(chalk.red(`no benchmark files found`));
    process.exitCode = 1;
    return;
  }

  for (const file of files) {
    console.log(chalk.dim(`compiling ${file}`));
    // --debug keeps the name section (--optimize strips it) so the profile
    // can attribute counts to function names; codegen is still optimized
    const wasmPath = await buildBenchFile(file, ["--debug"]);
    const { wasm, functions } = await instrumentWasm(fs.readFileSync(wasmPath));
    const instrPath = wasmPath.replace(/\.wasm$/, ".instr.wasm");
    fs.writeFileSync(instrPath, wasm);
    console.log(chalk.dim(`instrumented ${functions.length} functions -> ${instrPath}`));
    const profiles = await runProfiled(instrPath, functions);
    render(file, profiles, flags);
  }
}
