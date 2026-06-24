import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { loadConfig } from "./config.js";

interface CleanFlags {
  configPath?: string;
  mode?: string;
  baselines: boolean;
}

function parseCleanFlags(args: string[]): CleanFlags {
  const flags: CleanFlags = { baselines: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--config") {
      flags.configPath = args[++i];
      if (!flags.configPath || flags.configPath.startsWith("-")) throw new Error("--config expects a path");
    } else if (a === "--mode") {
      flags.mode = args[++i];
      if (!flags.mode || flags.mode.startsWith("-")) throw new Error("--mode expects a mode name");
    } else if (a === "--baselines" || a === "--all") {
      flags.baselines = true;
    } else if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
    else throw new Error(`unknown argument: ${a}`);
  }
  return flags;
}

function removeDir(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

export async function executeClean(args: string[]): Promise<void> {
  const flags = parseCleanFlags(args);
  const cfg = loadConfig(flags.configPath, flags.mode);
  const targets = [cfg.outDir, path.join(".as-bench", "charts")];
  if (flags.baselines) targets.push(cfg.baselineDir);

  let removed = 0;
  for (const target of [...new Set(targets)]) {
    if (removeDir(target)) {
      removed++;
      console.log(`removed ${chalk.bold(target)}`);
    }
  }

  if (removed === 0) console.log(chalk.dim("nothing to clean"));
  if (!flags.baselines) console.log(chalk.dim(`baselines preserved (${cfg.baselineDir}); use --baselines to remove them`));
}
