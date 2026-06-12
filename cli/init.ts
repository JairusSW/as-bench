import fs from "node:fs";
import path from "node:path";
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
  const force = args.includes("--force");

  if (fs.existsSync(DEFAULT_CONFIG_PATH) && !force) {
    console.log(chalk.yellow(`${DEFAULT_CONFIG_PATH} already exists (use --force to overwrite)`));
  } else {
    fs.writeFileSync(DEFAULT_CONFIG_PATH, STARTER_CONFIG);
    console.log(`created ${chalk.bold(DEFAULT_CONFIG_PATH)}`);
  }

  const benchDir = path.join("assembly", "__benches__");
  const benchFile = path.join(benchDir, "example.ts");
  if (fs.existsSync(benchFile) && !force) {
    console.log(chalk.yellow(`${benchFile} already exists (use --force to overwrite)`));
  } else {
    fs.mkdirSync(benchDir, { recursive: true });
    fs.writeFileSync(benchFile, STARTER_BENCH);
    console.log(`created ${chalk.bold(benchFile)}`);
  }

  console.log(`\nrun ${chalk.bold("asb run")} to benchmark (or ${chalk.bold("asb run --mode quick")} while iterating)`);
}
