import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { globSync } from "glob";
import { DEFAULT_CONFIG_PATH, loadConfig } from "./config.js";
function parseDoctorFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--config") {
      flags.configPath = args[++i];
      if (!flags.configPath || flags.configPath.startsWith("-")) throw new Error("--config expects a path");
    } else if (a === "--mode") {
      flags.mode = args[++i];
      if (!flags.mode || flags.mode.startsWith("-")) throw new Error("--mode expects a mode name");
    } else if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
    else throw new Error(`unknown argument: ${a}`);
  }
  return flags;
}
function status(kind, title, detail, fix) {
  const label = kind === "ok" ? chalk.green("OK") : kind === "warn" ? chalk.yellow("WARN") : chalk.red("ERROR");
  console.log(` ${label}  ${title}`);
  console.log(chalk.dim(`      ${detail}`));
  if (fix) console.log(chalk.dim(`      fix: ${fix}`));
}
function commandExists(cmd) {
  const r = spawnSync("sh", ["-c", `command -v "$1"`, "sh", cmd], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}
function requireFromProject(id) {
  try {
    return createRequire(path.join(process.cwd(), "package.json")).resolve(`${id}/package.json`);
  } catch {
    return null;
  }
}
export async function executeDoctor(args) {
  const flags = parseDoctorFlags(args);
  let ok = 0;
  let warn = 0;
  let error = 0;
  const mark = (kind, title, detail, fix) => {
    if (kind === "ok") ok++;
    else if (kind === "warn") warn++;
    else error++;
    status(kind, title, detail, fix);
  };
  console.log(chalk.bold("as-bench doctor"));
  console.log(chalk.dim(`config: ${path.resolve(flags.configPath ?? DEFAULT_CONFIG_PATH)}`));
  console.log(chalk.dim(`mode: ${flags.mode ?? "default"}\n`));
  if (flags.configPath === undefined && !fs.existsSync(DEFAULT_CONFIG_PATH)) {
    mark("warn", "Config file", `No ${DEFAULT_CONFIG_PATH}; defaults will be used.`, `Create one with "asb init".`);
  }
  let cfg;
  try {
    cfg = loadConfig(flags.configPath, flags.mode);
    mark("ok", "Config loaded", flags.configPath ?? (fs.existsSync(DEFAULT_CONFIG_PATH) ? DEFAULT_CONFIG_PATH : "built-in defaults"));
  } catch (err) {
    mark("error", "Config loaded", err instanceof Error ? err.message : String(err));
  }
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (Number.isFinite(nodeMajor) && nodeMajor >= 18) mark("ok", "Node.js version", process.version);
  else mark("error", "Node.js version", process.version, "Use Node.js 18 or newer.");
  for (const dep of ["assemblyscript", "@assemblyscript/wasi-shim"]) {
    const found = requireFromProject(dep);
    if (found) mark("ok", `Dependency present: ${dep}`, found);
    else mark("error", `Dependency missing: ${dep}`, `${dep} is not resolvable from this project.`, `Install with: npm i -D ${dep}`);
  }
  if (cfg) {
    const files = [...new Set(cfg.input.flatMap((p) => globSync(p, { nodir: true })))].filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));
    if (files.length > 0) mark("ok", "Benchmark file discovery", `${files.length} file(s) matched input patterns.`);
    else mark("warn", "Benchmark file discovery", `No benchmark files matched: ${cfg.input.join(", ")}`, `Update "input" or add files under assembly/__benches__.`);
    for (const rt of cfg.runtimes) {
      if (rt.spec === "node") {
        mark("ok", `Runtime ${rt.label}`, process.execPath);
        continue;
      }
      const cmd = rt.spec.trim().split(/\s+/)[0];
      const found = commandExists(cmd);
      if (found) mark("ok", `Runtime ${rt.label}`, found);
      else mark("warn", `Runtime ${rt.label}`, `Command not found: ${cmd}`, `Install ${cmd} or choose another --runtime/--mode.`);
    }
  }
  console.log(chalk.bold(`\nSummary: ${ok} ok, ${warn} warn, ${error} error`));
  if (error > 0) process.exitCode = 1;
}
