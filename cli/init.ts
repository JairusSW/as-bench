import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import chalk from "chalk";
import { DEFAULT_CONFIG_PATH } from "./config.js";

const STARTER_CONFIG = `{
  "$schema": "node_modules/as-bench/as-bench.config.schema.json",
  "input": ["assembly/__benches__/**/*.ts"],
  "settings": {},
  "modes": {
    "quick": {
      "settings": {
        "warmupTime": 250,
        "measurementTime": 500,
        "numResamples": 20000
      }
    },
    "wasmtime": {
      "runtime": "wasmtime"
    },
    "custom": {
      "runOptions": {
        "runtime": {
          "cmd": "wazero run <file>"
        }
      }
    }
  }
}
`;

const STARTER_BENCH = `import { bench, suite, blackbox } from "as-bench/assembly/index";

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
`;

export async function executeInit(args: string[]): Promise<void> {
  let force = false;
  let install = false;
  let dir = ".";
  let positionalDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--force") force = true;
    else if (arg === "--install") install = true;
    else if (arg === "--yes" || arg === "-y") {
      // as-bench init is already non-interactive; accept the as-test-style flag.
    } else if (arg === "--dir") {
      dir = args[++i];
      if (!dir || dir.startsWith("-")) throw new Error("--dir expects a path");
    } else if (arg.startsWith("-")) throw new Error(`unknown flag: ${arg}`);
    else if (positionalDir === undefined) positionalDir = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (positionalDir !== undefined) dir = positionalDir;
  fs.mkdirSync(dir, { recursive: true });

  const configPath = path.join(dir, DEFAULT_CONFIG_PATH);

  if (fs.existsSync(configPath) && !force) {
    console.log(chalk.yellow(`${configPath} already exists (use --force to overwrite)`));
  } else {
    fs.writeFileSync(configPath, STARTER_CONFIG);
    console.log(`created ${chalk.bold(configPath)}`);
  }

  const benchDir = path.join(dir, "assembly", "__benches__");
  const benchFile = path.join(benchDir, "example.ts");
  if (fs.existsSync(benchFile) && !force) {
    console.log(chalk.yellow(`${benchFile} already exists (use --force to overwrite)`));
  } else {
    fs.mkdirSync(benchDir, { recursive: true });
    fs.writeFileSync(benchFile, STARTER_BENCH);
    console.log(`created ${chalk.bold(benchFile)}`);
  }

  updatePackageJson(dir);

  if (install) {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const result = spawnSync(npm, ["install"], { cwd: dir, stdio: "inherit" });
    if (result.status !== 0) throw new Error(`npm install failed with exit code ${result.status ?? "unknown"}`);
  }

  const prefix = dir === "." ? "" : `cd ${dir} && `;
  const installHint = install ? "" : `\nrun ${chalk.bold(`${prefix}npm install`)} to install dependencies`;
  console.log(`${installHint}\nrun ${chalk.bold(`${prefix}asb run`)} to benchmark (or ${chalk.bold(`${prefix}asb run --mode quick`)} while iterating)`);
}

function updatePackageJson(dir: string): void {
  const file = path.join(dir, "package.json");
  const existed = fs.existsSync(file);
  const fallbackName = path.basename(path.resolve(dir)).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-") || "as-bench-project";
  let pkg: Record<string, unknown> = {
    name: fallbackName,
    version: "0.1.0",
    type: "module",
  };
  if (existed) {
    pkg = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  }
  const scripts = { ...((pkg.scripts as Record<string, string> | undefined) ?? {}) };
  scripts.bench ??= "asb run";
  scripts["bench:quick"] ??= "asb run --mode quick";
  pkg.scripts = scripts;

  const devDeps = { ...((pkg.devDependencies as Record<string, string> | undefined) ?? {}) };
  devDeps["as-bench"] ??= "^0.1.0";
  devDeps.assemblyscript ??= "^0.28.17";
  devDeps["@assemblyscript/wasi-shim"] ??= "^0.1.0";
  pkg.devDependencies = devDeps;

  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`${existed ? "updated" : "created"} ${chalk.bold(file)}`);
}
