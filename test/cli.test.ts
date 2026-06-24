/**
 * Integration tests for the as-bench CLI. These run real compilations and
 * bench runs against the example bench file with reduced settings for speed.
 * Run with: bun test
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { spawnSync } from "bun";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const ROOT = path.resolve(import.meta.dir, "..");
const CLI = path.join(ROOT, "bin", "index.js");
const EXAMPLE = "assembly/__benches__/example.ts";
// Fast settings: 100ms warmup, 200ms measure, 10 samples, 1000 resamples
const FAST = ["--warmup", "100", "--measure", "200", "--samples", "10", "--resamples", "1000"];

function run(...args: string[]) {
  const result = spawnSync(["node", CLI, ...args], { cwd: ROOT });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function runIn(cwd: string, ...args: string[]) {
  const result = spawnSync(["node", CLI, ...args], { cwd });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

beforeAll(() => {
  // Ensure the example bench compiles (warms up the asc cache for other tests).
  const r = run("build", EXAMPLE);
  if (r.exitCode !== 0) {
    throw new Error(`pre-build failed:\n${r.stderr}`);
  }
});

describe("version / help", () => {
  test("version prints a semver string", () => {
    const { exitCode, stdout } = run("version");
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("--version alias works", () => {
    const { exitCode, stdout } = run("--version");
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("help prints usage", () => {
    const { exitCode, stdout } = run("help");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage");
    expect(stdout).toContain("run");
    expect(stdout).toContain("profile");
    expect(stdout).toContain("watch");
    expect(stdout).toContain("compare");
  });

  test("subcommand --help prints usage", () => {
    for (const cmd of ["run", "build", "profile", "watch", "compare", "init", "doctor", "clean"]) {
      const { exitCode, stdout } = run(cmd, "--help");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Usage");
    }
  });

  test("unknown command exits non-zero", () => {
    const { exitCode } = run("doesnotexist");
    expect(exitCode).not.toBe(0);
  });
});

describe("build", () => {
  test("builds example bench", () => {
    const { exitCode } = run("build", EXAMPLE);
    expect(exitCode).toBe(0);
    expect(fs.existsSync(path.join(ROOT, ".as-bench/build/assembly____benches____example.wasm"))).toBeTrue();
  });

  test("exits non-zero on missing file", () => {
    const { exitCode } = run("build", "nonexistent.ts");
    expect(exitCode).not.toBe(0);
  });

  test("rejects run-only flags", () => {
    const { exitCode, stderr } = run("build", EXAMPLE, "--json");
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("build does not support --json");
  });
});

describe("run", () => {
  test("runs example bench and prints results", () => {
    const { exitCode, stdout } = run("run", EXAMPLE, ...FAST);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("fib(20)");
    expect(stdout).toMatch(/\d+\.\d+\s*(ns|µs|ms)/);
  });

  test("suite shows delta line", () => {
    const { exitCode, stdout } = run("run", EXAMPLE, ...FAST);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/faster|slower|×/);
  });

  test("--verbose prints estimates", () => {
    const { exitCode, stdout } = run("run", EXAMPLE, ...FAST, "--verbose");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("mean");
  });

  test("--filter runs only matching benches", () => {
    const { exitCode, stdout } = run("run", EXAMPLE, ...FAST, "--filter", "fib(20)");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("fib(20)");
    // fib(15) should not appear as a result line
    const resultLines = stdout.split("\n").filter((l) => /\[\d+\.\d+\s*(ns|µs|ms)/.test(l));
    for (const l of resultLines) {
      expect(l).not.toContain("fib(15)");
    }
  });

  test("--json emits valid JSON with expected shape", () => {
    const { exitCode, stdout } = run("run", EXAMPLE, ...FAST, "--json");
    expect(exitCode).toBe(0);
    let parsed: { version: number; benches: { name: string; result: { point: number } | null }[] };
    expect(() => {
      parsed = JSON.parse(stdout);
    }).not.toThrow();
    expect(parsed!.version).toBe(1);
    expect(Array.isArray(parsed!.benches)).toBeTrue();
    expect(parsed!.benches.length).toBeGreaterThan(0);
    const fib20 = parsed!.benches.find((b) => b.name === "fib(20)");
    expect(fib20).toBeDefined();
    expect(fib20!.result).not.toBeNull();
    expect(typeof fib20!.result!.point).toBe("number");
  });

  test("--json + --filter only includes matching benches", () => {
    const { exitCode, stdout } = run("run", EXAMPLE, ...FAST, "--json", "--filter", "fib(15)");
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as { benches: { name: string; result: unknown }[] };
    expect(parsed.benches.length).toBeGreaterThan(0);
    expect(parsed.benches.every((b) => b.name.includes("fib(15)"))).toBeTrue();
    expect(parsed.benches.every((b) => b.result !== null)).toBeTrue();
  });

  test("--save-baseline and --baseline comparison", () => {
    const baselineId = `test_baseline_${process.pid}`;
    try {
      const saveResult = run("run", EXAMPLE, ...FAST, "--save-baseline", baselineId);
      expect(saveResult.exitCode).toBe(0);

      const cmpResult = run("run", EXAMPLE, ...FAST, "--baseline", baselineId);
      expect(cmpResult.exitCode).toBe(0);
      expect(cmpResult.stdout).toMatch(/faster|slower|no change/);
    } finally {
      // Cleanup
      const baselineFile = path.join(ROOT, ".as-bench/baselines", `${baselineId}.json`);
      if (fs.existsSync(baselineFile)) fs.unlinkSync(baselineFile);
    }
  });
});

describe("init", () => {
  test("rejects unknown flags", () => {
    const { exitCode, stderr } = run("init", "--bogus");
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("unknown flag: --bogus");
  });

  test("--dir scaffolds into a target directory", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "as-bench-init-"));
    const target = path.join(tmp, "bench-project");
    const { exitCode, stdout } = run("init", "--yes", "--dir", target);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("created");
    expect(fs.existsSync(path.join(target, "as-bench.config.json"))).toBeTrue();
    expect(fs.existsSync(path.join(target, "assembly/__benches__/example.ts"))).toBeTrue();
    const pkg = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8")) as { scripts: Record<string, string>; devDependencies: Record<string, string> };
    expect(pkg.scripts.bench).toBe("asb run");
    expect(pkg.devDependencies["as-bench"]).toBeDefined();
    expect(pkg.devDependencies.assemblyscript).toBeDefined();
    expect(pkg.devDependencies["@assemblyscript/wasi-shim"]).toBeDefined();
  });
});

describe("doctor / clean", () => {
  test("doctor validates this repo", () => {
    const { exitCode, stdout } = run("doctor");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("as-bench doctor");
    expect(stdout).toContain("Summary:");
    expect(stdout).toContain("0 error");
  });

  test("clean removes generated outputs but preserves baselines by default", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "as-bench-clean-"));
    fs.mkdirSync(path.join(tmp, ".as-bench/build"), { recursive: true });
    fs.mkdirSync(path.join(tmp, ".as-bench/charts"), { recursive: true });
    fs.mkdirSync(path.join(tmp, ".as-bench/baselines"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".as-bench/build/example.wasm"), "");
    fs.writeFileSync(path.join(tmp, ".as-bench/charts/example.svg"), "");
    fs.writeFileSync(path.join(tmp, ".as-bench/baselines/main.json"), "{}");

    const { exitCode } = runIn(tmp, "clean");
    expect(exitCode).toBe(0);
    expect(fs.existsSync(path.join(tmp, ".as-bench/build"))).toBeFalse();
    expect(fs.existsSync(path.join(tmp, ".as-bench/charts"))).toBeFalse();
    expect(fs.existsSync(path.join(tmp, ".as-bench/baselines/main.json"))).toBeTrue();
  });
});

describe("package exports", () => {
  test("documented assembly subpath is exported", () => {
    const result = spawnSync(["node", "-e", "console.log(import.meta.resolve('as-bench/assembly/index'))"], { cwd: ROOT });
    expect(result.exitCode ?? -1).toBe(0);
    expect(result.stdout.toString()).toContain("assembly/index.ts");
  });

  test("root export resolves to host library", () => {
    const result = spawnSync(["node", "-e", "import('as-bench').then((m)=>console.log(typeof m.runBenchFile))"], { cwd: ROOT });
    expect(result.exitCode ?? -1).toBe(0);
    expect(result.stdout.toString()).toContain("function");
  });
});

describe("profile", () => {
  test("--heaviest=instr prints profile table", () => {
    const { exitCode, stdout } = run("profile", EXAMPLE, "--heaviest=instr");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("profile:");
    expect(stdout).toContain("instrs");
  });

  test("--heaviest=alloc runs without error", () => {
    const { exitCode } = run("profile", EXAMPLE, "--heaviest=alloc");
    expect(exitCode).toBe(0);
  });

  test("--heaviest=time runs without error", () => {
    const { exitCode } = run("profile", EXAMPLE, "--heaviest=time", "--iters", "3");
    expect(exitCode).toBe(0);
  });
});

describe("compare", () => {
  const idA = `compare_test_a_${process.pid}`;
  const idB = `compare_test_b_${process.pid}`;

  beforeAll(() => {
    // Save two baselines to compare
    run("run", EXAMPLE, ...FAST, "--save-baseline", idA);
    run("run", EXAMPLE, ...FAST, "--save-baseline", idB);
  });

  test("compare two baselines", () => {
    const { exitCode, stdout } = run("compare", idA, idB);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("comparing");
    expect(stdout).toContain("fib(20)");
    expect(stdout).toContain("delta:");
  });

  test("compare fails with missing baseline", () => {
    const { exitCode } = run("compare", "does_not_exist_1", "does_not_exist_2");
    expect(exitCode).not.toBe(0);
  });

  test("compare requires exactly two ids", () => {
    const { exitCode } = run("compare", idA);
    expect(exitCode).not.toBe(0);
  });

  // Cleanup in afterAll is not available in bun:test v0; use a test instead
  test("cleanup baselines", () => {
    for (const id of [idA, idB]) {
      const f = path.join(ROOT, ".as-bench/baselines", `${id}.json`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    expect(true).toBeTrue();
  });
});
