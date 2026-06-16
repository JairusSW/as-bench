import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { glob } from "glob";
import { loadConfig } from "./config.js";
import { parseRunFlags, executeRun } from "./run.js";
export async function executeWatch(args) {
  const { flags, selectors } = parseRunFlags(args);
  const cfg = loadConfig(flags.configPath, flags.mode);
  const patterns = selectors.length > 0 ? selectors : cfg.input;
  // Collect watchable directories from the input globs
  const watchDirs = new Set();
  for (const p of patterns) {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      watchDirs.add(path.dirname(p));
    } else {
      // take everything up to the first glob character
      const base = p.replace(/[*?{[].*/u, "");
      watchDirs.add(base || ".");
    }
  }
  process.stderr.write(chalk.dim(`watching ${[...watchDirs].join(", ")} — Ctrl-C to stop\n\n`));
  // Do an initial run of all matching files
  await executeRun(args);
  // Debounce map: absolute path → pending timer
  const debounce = new Map();
  // Whether a run is in progress (avoid overlapping runs)
  let running = false;
  const pending = new Set();
  const onChange = async (changed) => {
    if (running) {
      for (const f of changed) pending.add(f);
      return;
    }
    running = true;
    const changedList = [...changed].map((f) => path.relative(process.cwd(), f)).join(", ");
    process.stderr.write(chalk.dim(`\n--- ${new Date().toLocaleTimeString()} — ${changedList} changed ---\n\n`));
    // Re-run with just the changed files as selectors (preserving all flags)
    const changedArgs = [...changed].map((f) => path.relative(process.cwd(), f)).concat(args.filter((a) => !isSelector(a, patterns)));
    try {
      await executeRun(changedArgs);
    } catch (err) {
      process.stderr.write(chalk.red(err instanceof Error ? err.message : String(err)) + "\n");
    }
    running = false;
    if (pending.size > 0) {
      const next = new Set(pending);
      pending.clear();
      await onChange(next);
    }
  };
  for (const dir of watchDirs) {
    if (!fs.existsSync(dir)) continue;
    fs.watch(dir, { recursive: true }, (_, filename) => {
      if (!filename || !filename.endsWith(".ts") || filename.endsWith(".d.ts")) return;
      const abs = path.resolve(dir, filename);
      glob(patterns, { nodir: true }).then((matches) => {
        if (!matches.map((m) => path.resolve(m)).includes(abs)) return;
        const prev = debounce.get(abs);
        if (prev) clearTimeout(prev);
        debounce.set(
          abs,
          setTimeout(() => {
            debounce.delete(abs);
            void onChange(new Set([abs]));
          }, 150),
        );
      });
    });
  }
  // Keep the process alive
  await new Promise(() => {});
}
/** Detect whether an arg is a positional file selector (not a flag) that overlaps with the input patterns. */
function isSelector(arg, patterns) {
  if (arg.startsWith("-")) return false;
  // If it looks like a file or glob that's part of the watch set, treat it as a selector
  return patterns.includes(arg) || fs.existsSync(arg);
}
