// Config loading for as-bench. JSON file (default ./as-bench.config.json,
// override with --config), validated lightly here — the shipped JSON schema
// (as-bench.config.schema.json) drives editor autocomplete/validation.
//
// Precedence: built-in defaults < config file < --mode overlay < CLI flags.

import fs from "node:fs";
import type { TuneOverrides } from "../lib/build/as-bs.js";

export interface SettingsConfig {
  /** Warmup time cap in ms (adaptive warmup may exit earlier). */
  warmupTime?: number;
  /** Earliest the warmup may converge, in ms. */
  warmupMinTime?: number;
  /** Relative met drift considered stable; 0 = always warm the full warmupTime. */
  warmupTolerance?: number;
  /** Target measurement time in ms. */
  measurementTime?: number;
  /** Samples collected per bench. */
  sampleSize?: number;
  /** Bootstrap resamples. */
  numResamples?: number;
  /** Sampling strategy. */
  samplingMode?: "auto" | "linear" | "flat";
  /** Confidence level for interval bounds. */
  confidenceLevel?: number;
}

export interface RenderConfig {
  /** p-value threshold below which a delta counts as significant. */
  significanceLevel?: number;
  /** Deltas whose whole CI lies within ±this ratio render as "no change". */
  noiseThreshold?: number;
}

export interface BuildConfig {
  /** Pass --optimize to asc (default true). */
  optimize?: boolean;
  /** Pass --debug to asc (name section + debug info; default false). */
  debug?: boolean;
  /** Extra asc arguments appended to every bench build. */
  args?: string[];
}

export interface ProfileConfig {
  /** Rows per bench in profile tables. */
  top?: number;
  /** Include engine/runtime-internal rows. */
  all?: boolean;
}

export interface AsBenchConfig {
  $schema?: string;
  /** Bench file globs. */
  input?: string[];
  /** Compiled artifact directory. */
  outDir?: string;
  /** Saved baseline directory. */
  baselineDir?: string;
  /** node (in-process) | wasmtime | wasmer | wazero | command template with <file>. */
  runtime?: string;
  /** Print all estimates per bench. */
  verbose?: boolean;
  /** Record host imports once, replay every later iteration. */
  deterministic?: boolean;
  settings?: SettingsConfig;
  render?: RenderConfig;
  buildOptions?: BuildConfig;
  profile?: ProfileConfig;
  /** Named partial-config overlays, applied with --mode <name>. */
  modes?: Record<string, Omit<AsBenchConfig, "modes" | "$schema">>;
}

export interface ResolvedConfig {
  input: string[];
  outDir: string;
  baselineDir: string;
  runtime: string;
  verbose: boolean;
  deterministic: boolean;
  settings: SettingsConfig;
  render: Required<RenderConfig>;
  buildOptions: Required<BuildConfig>;
  profile: Required<ProfileConfig>;
}

const DEFAULTS: ResolvedConfig = {
  input: ["assembly/__benches__/**/*.ts"],
  outDir: ".as-bench/build",
  baselineDir: ".as-bench/baselines",
  runtime: "node",
  verbose: false,
  deterministic: false,
  settings: {},
  render: { significanceLevel: 0.05, noiseThreshold: 0.01 },
  buildOptions: { optimize: true, debug: false, args: [] },
  profile: { top: 10, all: false },
};

export const DEFAULT_CONFIG_PATH = "as-bench.config.json";

const SAMPLING_MODES = ["auto", "linear", "flat"] as const;

function fail(msg: string): never {
  throw new Error(`as-bench config: ${msg}`);
}

function checkNumber(value: unknown, name: string, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) fail(`${name} must be a number >= ${min}, got ${JSON.stringify(value)}`);
  return value;
}

function validate(cfg: AsBenchConfig, where: string): void {
  if (cfg.input !== undefined && (!Array.isArray(cfg.input) || cfg.input.some((p) => typeof p !== "string"))) fail(`${where}input must be an array of glob strings`);
  for (const key of ["outDir", "baselineDir", "runtime"] as const) {
    if (cfg[key] !== undefined && typeof cfg[key] !== "string") fail(`${where}${key} must be a string`);
  }
  for (const key of ["verbose", "deterministic"] as const) {
    if (cfg[key] !== undefined && typeof cfg[key] !== "boolean") fail(`${where}${key} must be a boolean`);
  }
  const s = cfg.settings;
  if (s !== undefined) {
    if (s.warmupTime !== undefined) checkNumber(s.warmupTime, `${where}settings.warmupTime`, 0);
    if (s.warmupMinTime !== undefined) checkNumber(s.warmupMinTime, `${where}settings.warmupMinTime`, 0);
    if (s.warmupTolerance !== undefined) checkNumber(s.warmupTolerance, `${where}settings.warmupTolerance`, 0);
    if (s.measurementTime !== undefined) checkNumber(s.measurementTime, `${where}settings.measurementTime`, 1);
    if (s.sampleSize !== undefined) checkNumber(s.sampleSize, `${where}settings.sampleSize`, 10);
    if (s.numResamples !== undefined) checkNumber(s.numResamples, `${where}settings.numResamples`, 1);
    if (s.confidenceLevel !== undefined) {
      const c = checkNumber(s.confidenceLevel, `${where}settings.confidenceLevel`, 0);
      if (c <= 0 || c >= 1) fail(`${where}settings.confidenceLevel must be in (0, 1)`);
    }
    if (s.samplingMode !== undefined && !SAMPLING_MODES.includes(s.samplingMode)) fail(`${where}settings.samplingMode must be one of ${SAMPLING_MODES.join("|")}`);
  }
  if (cfg.render?.significanceLevel !== undefined) checkNumber(cfg.render.significanceLevel, `${where}render.significanceLevel`, 0);
  if (cfg.render?.noiseThreshold !== undefined) checkNumber(cfg.render.noiseThreshold, `${where}render.noiseThreshold`, 0);
  if (cfg.buildOptions?.args !== undefined && (!Array.isArray(cfg.buildOptions.args) || cfg.buildOptions.args.some((a) => typeof a !== "string"))) fail(`${where}buildOptions.args must be an array of strings`);
  if (cfg.profile?.top !== undefined) checkNumber(cfg.profile.top, `${where}profile.top`, 1);
}

/** Overlay partial config b onto a: objects merge one level deep, scalars/arrays replace. */
function overlay(base: ResolvedConfig, cfg: AsBenchConfig): ResolvedConfig {
  return {
    input: cfg.input ?? base.input,
    outDir: cfg.outDir ?? base.outDir,
    baselineDir: cfg.baselineDir ?? base.baselineDir,
    runtime: cfg.runtime ?? base.runtime,
    verbose: cfg.verbose ?? base.verbose,
    deterministic: cfg.deterministic ?? base.deterministic,
    settings: { ...base.settings, ...cfg.settings },
    render: { ...base.render, ...cfg.render },
    buildOptions: { ...base.buildOptions, ...cfg.buildOptions },
    profile: { ...base.profile, ...cfg.profile },
  };
}

/**
 * Load and resolve the config. `configPath` undefined → use the default file
 * when present, silently fall back to defaults when not. An explicitly given
 * path must exist.
 */
export function loadConfig(configPath?: string, mode?: string): ResolvedConfig {
  let raw: AsBenchConfig = {};
  const explicit = configPath !== undefined;
  const file = configPath ?? DEFAULT_CONFIG_PATH;
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8")) as AsBenchConfig;
    } catch (err) {
      fail(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (explicit) {
    fail(`config file not found: ${file}`);
  }

  validate(raw, "");
  let resolved = overlay(DEFAULTS, raw);

  if (mode !== undefined) {
    const modes = raw.modes ?? {};
    const overlayCfg = modes[mode];
    if (overlayCfg === undefined) {
      const available = Object.keys(modes);
      fail(`unknown mode "${mode}"${available.length ? ` — available: ${available.join(", ")}` : " (no modes defined in config)"}`);
    }
    validate(overlayCfg, `modes.${mode}.`);
    resolved = overlay(resolved, overlayCfg);
  } else if (raw.modes !== undefined) {
    for (const name of Object.keys(raw.modes)) validate(raw.modes[name], `modes.${name}.`);
  }

  return resolved;
}

/** Map config settings onto engine tune overrides (kinds 0–7). */
export function tunesFromSettings(s: SettingsConfig): TuneOverrides {
  const tunes: TuneOverrides = {};
  if (s.warmupTime !== undefined) tunes.warmupTime = s.warmupTime;
  if (s.measurementTime !== undefined) tunes.measurementTime = s.measurementTime;
  if (s.sampleSize !== undefined) tunes.sampleSize = s.sampleSize;
  if (s.numResamples !== undefined) tunes.numResamples = s.numResamples;
  if (s.samplingMode !== undefined) tunes.samplingMode = SAMPLING_MODES.indexOf(s.samplingMode);
  if (s.confidenceLevel !== undefined) tunes.confidenceLevel = s.confidenceLevel;
  if (s.warmupTolerance !== undefined) tunes.warmupTolerance = s.warmupTolerance;
  if (s.warmupMinTime !== undefined) tunes.warmupMinTime = s.warmupMinTime;
  return tunes;
}
