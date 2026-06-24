import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { loadConfig } from "./config.js";
import { formatTime } from "./run.js";
export function parseCompareFlags(args) {
  const ids = [];
  const flags = {};
  const numArg = (raw, name) => {
    const n = Number(raw);
    if (raw === undefined || !Number.isFinite(n) || n <= 0 || n >= 1) throw new Error(`${name} expects a number in (0, 1)`);
    return n;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--config") {
      flags.configPath = args[++i];
      if (!flags.configPath || flags.configPath.startsWith("-")) throw new Error("--config expects a path");
    } else if (a === "--mode") {
      flags.mode = args[++i];
      if (!flags.mode || flags.mode.startsWith("-")) throw new Error("--mode expects a mode name");
    } else if (a === "--significance") {
      flags.significanceLevel = numArg(args[++i], "--significance");
    } else if (a === "--noise") {
      flags.noiseThreshold = numArg(args[++i], "--noise");
    } else if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
    else ids.push(a);
  }
  if (ids.length !== 2) throw new Error(`compare expects exactly two baseline ids, got ${ids.length} (usage: asb compare <a> <b>)`);
  return { flags, ids };
}
function loadBaseline(dir, id) {
  const file = path.join(dir, `${id.replace(/[^\w.-]/g, "_")}.json`);
  if (!fs.existsSync(file)) throw new Error(`baseline '${id}' not found (expected ${file}); create it with asb run --save-baseline ${id}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function perIterTimes(entry) {
  return entry.times.map((t, i) => t / entry.iters[i]);
}
function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function variance(xs, m) {
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
}
// standard normal CDF approximation (Abramowitz & Stegun 26.2.17)
function normalCDF(x) {
  const [a1, a2, a3, a4, a5, p] = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429, 0.3275911];
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * (Math.abs(x) / Math.SQRT2));
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-((Math.abs(x) / Math.SQRT2) ** 2));
  return 0.5 * (1 + sign * y);
}
function welchTest(a, b) {
  const ma = mean(a),
    mb = mean(b);
  const va = variance(a, ma),
    vb = variance(b, mb);
  const na = a.length,
    nb = b.length;
  const se = Math.sqrt(va / na + vb / nb);
  const t = se === 0 ? 0 : (mb - ma) / se;
  const pValue = 2 * (1 - normalCDF(Math.abs(t)));
  // CI on delta (B/A - 1) via delta method
  if (ma === 0) return { pValue, delta: 0, lb: 0, hb: 0 };
  const ratio = mb / ma;
  const seRatio = ratio * Math.sqrt((Math.sqrt(va / na) / ma) ** 2 + (Math.sqrt(vb / nb) / mb) ** 2);
  const z = 1.96;
  return { pValue, delta: ratio - 1, lb: ratio - 1 - z * seRatio, hb: ratio - 1 + z * seRatio };
}
export async function executeCompare(args) {
  const { flags, ids } = parseCompareFlags(args);
  const cfg = loadConfig(flags.configPath, flags.mode);
  const [idA, idB] = ids;
  const blA = loadBaseline(cfg.baselineDir, idA);
  const blB = loadBaseline(cfg.baselineDir, idB);
  const keysA = new Set(Object.keys(blA.benches));
  const common = Object.keys(blB.benches).filter((k) => keysA.has(k));
  if (common.length === 0) {
    console.log(chalk.yellow(`no benches in common between '${idA}' and '${idB}'`));
    return;
  }
  const sigLevel = flags.significanceLevel ?? cfg.render.significanceLevel;
  const noise = flags.noiseThreshold ?? cfg.render.noiseThreshold;
  console.log(chalk.bold(`\ncomparing '${idA}' → '${idB}'`) + chalk.dim(` (${common.length} bench${common.length === 1 ? "" : "es"})`));
  console.log(chalk.dim(`  A created: ${blA.createdAt}  B created: ${blB.createdAt}\n`));
  const pct = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
  for (const key of common) {
    const entA = blA.benches[key];
    const entB = blB.benches[key];
    const timesA = perIterTimes(entA);
    const timesB = perIterTimes(entB);
    const mA = mean(timesA);
    const mB = mean(timesB);
    const { pValue, delta, lb, hb } = welchTest(timesA, timesB);
    const significant = pValue < sigLevel;
    const cmp = significant ? "<" : ">";
    let verdict;
    if (!significant || (lb > -noise && hb < noise)) {
      verdict = chalk.dim("no change");
    } else if (delta < 0) {
      verdict = chalk.green("faster");
    } else {
      verdict = chalk.red("slower");
    }
    const name = key.padEnd(28);
    console.log(`${chalk.bold(name)} A: ${formatTime(mA).padStart(10)}  B: ${formatTime(mB).padStart(10)}  delta: [${pct(lb)} ${chalk.bold(pct(delta))} ${pct(hb)}]  (p = ${pValue.toFixed(2)} ${cmp} ${sigLevel}) ${verdict}`);
  }
  const onlyA = [...keysA].filter((k) => !blB.benches[k]).length;
  const onlyB = Object.keys(blB.benches).filter((k) => !keysA.has(k)).length;
  if (onlyA > 0 || onlyB > 0) {
    console.log(chalk.dim(`\n  ${onlyA} bench${onlyA === 1 ? "" : "es"} only in '${idA}', ${onlyB} only in '${idB}' — skipped`));
  }
}
