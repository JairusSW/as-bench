// SPDX-License-Identifier: Apache-2.0
//
// Statistics engine, ported from as-tral (https://github.com/romdotdog/as-tral,
// Copyright © romdotdog, Apache License 2.0 — full text in
// licenses/as-tral.LICENSE; see also NOTICE), itself a port of Criterion.rs's
// analysis pipeline (https://github.com/bheisler/criterion.rs). Changes from
// as-tral: settings are runtime values (host-tunable via `tune`) instead of
// transform-injected compile-time globals, buffers are (re)allocated lazily to
// match, bench/suite names cross the host boundary as strings instead of
// enumeration ids, and the resample-median bug in the univariate bootstrap is
// fixed (as-tral computed the median of the median distribution itself).

import * as host from "./util/host";
import { Settings, SamplingMode } from "./types";

// Timing source. Under a WASI build (wasi-shim sets ASC_WASI) the shim's
// performance.now() — clock_time_get(MONOTONIC), ns-sourced, in ms — keeps
// timing inside the wasm/runtime with no JS host import on the hot path, and
// works under pure-CLI runtimes (wasmtime, wasmer) that can't supply
// __asbench.now. Elsewhere, fall back to the host import.
// @ts-ignore: decorator
@inline
function timeNow(): f64 {
  // Deterministic builds route engine timing through the (passthrough) host
  // import so the WASI clock stays recordable for user code (Date.now etc).
  if (isDefined(AS_BENCH_DETERMINISTIC)) {
    return host.now();
  }
  if (isDefined(ASC_WASI)) {
    return performance.now();
  }
  return host.now();
}

/** Live settings; benchmark files mutate fields before their first `bench()`. */
export const settings = new Settings();

// flags bits (as-tral layout): 0b1 host baseline loaded (unused until the
// baseline feature lands), 0b10 slope estimate exists, 0b100 inside a suite,
// 0b1000 suite baseline captured.
const FLAG_SLOPE: u32 = 0b10;
const FLAG_IN_SUITE: u32 = 0b100;
const FLAG_SUITE_BASELINE: u32 = 0b1000;
let flags: u32 = 0;

// Effective per-bench config, resolved from `settings` + host.tune() at each
// bench start. The helpers below read these instead of as-tral's __astral__*.
let cfgSampleSize: i32 = 0;
let cfgNumResamples: i32 = 0;
let cfgWarmupTime: f64 = 0;
let cfgMeasurementTime: f64 = 0;
let cfgSamplingMode: i32 = 0;
let cfgConfidenceLevel: f64 = 0;

namespace Sampling {
  export function chooseSamplingMode(met: f64): bool {
    // https://github.com/bheisler/criterion.rs/blob/970aa04aa5ee0514d1930c83a58c6ca994727567/src/lib.rs#L1416
    const sampleCount = cfgSampleSize as u64;
    const targetTime = cfgMeasurementTime;
    const totalRuns = ((sampleCount * (sampleCount + 1)) / 2) as f64;
    const d = ceil(targetTime / met / totalRuns);
    const expectedMs = totalRuns * d * met;
    return expectedMs > 2 * targetTime;
  }

  export function linearSampling(arrToWrite: StaticArray<u64>, met: f64): void {
    const sampleCount = cfgSampleSize as u64;
    const targetTime = cfgMeasurementTime;
    const totalRuns = ((sampleCount * (sampleCount + 1)) / 2) as f64;
    const df = max(1, ceil(targetTime / met / totalRuns));
    const d = df as u64;

    if (d == 1) {
      const expectedMs = totalRuns * df * met;
      host.faultyConfig(1, expectedMs, recommendLinearSampleSize(met));
    }

    for (let i = 0, a = 1; i < cfgSampleSize; i = a++) {
      arrToWrite[i] = a * d;
    }
  }

  export function flatSampling(arrToWrite: StaticArray<u64>, met: f64): void {
    const sampleCount = cfgSampleSize;
    const msPerSample = cfgMeasurementTime / (sampleCount as f64);
    const iterationsPerSample = max(1, ceil(msPerSample / met) as u64);

    if (iterationsPerSample == 1) {
      const expectedMs = ((iterationsPerSample * sampleCount) as f64) * met;
      host.faultyConfig(0, expectedMs, recommendFlatSampleSize(met));
    }

    for (let i = 0; i < sampleCount; ++i) {
      arrToWrite[i] = iterationsPerSample;
    }
  }

  function recommendLinearSampleSize(met: f64): f64 {
    const c = cfgMeasurementTime / met;
    let sampleSize = (-1.0 + sqrt(4.0 * c) / 2) as u64;
    sampleSize = (sampleSize / 10) * 10;
    return max(10, sampleSize) as f64;
  }

  function recommendFlatSampleSize(met: f64): f64 {
    let sampleSize = (cfgMeasurementTime / met) as u64;
    sampleSize = (sampleSize / 10) * 10;
    return max(10, sampleSize) as f64;
  }
}

namespace Stats {
  // https://github.com/bheisler/criterion.rs/blob/ceade3b1d72c3ecef0896cbe0dee12f43a6ce240/src/stats/univariate/sample.rs#L18
  export function mean(sample: StaticArray<f64>): f64 {
    return sample.reduce<f64>((a, b) => a + b, 0) / sample.length;
  }

  function variance(sample: StaticArray<f64>, mean: f64): f64 {
    let sum: f64 = 0;
    for (let i = 0; i < sample.length; ++i) {
      sum += (sample[i] - mean) ** 2;
    }
    return sum / (sample.length - 1);
  }

  export function stdDev(sample: StaticArray<f64>, mean: f64): f64 {
    return sqrt(variance(sample, mean));
  }

  export function t(sample: StaticArray<f64>, other: StaticArray<f64>): f64 {
    const xBar = mean(sample);
    const yBar = mean(other);
    const s2X = variance(sample, xBar);
    const s2Y = variance(other, yBar);
    const num = xBar - yBar;
    const den = sqrt(s2X / sample.length + s2Y / other.length);
    return num / den;
  }

  export function p_value_2(sample: StaticArray<f64>, t: f64): f64 {
    const n = sample.length;
    let hits = 0;
    for (let i = 0; i < sample.length; ++i) {
      hits += sample[i] < t ? 1 : 0;
    }
    return (min(hits, n - hits) / n) * 2;
  }

  // invariant: sample must be sorted
  export namespace sorted {
    export function median(sample: StaticArray<f64>): f64 {
      const n = sample.length;
      if (n % 2 == 1) {
        return sample[n / 2];
      } else {
        const i = n / 2;
        return (sample[i - 1] + sample[i]) / 2;
      }
    }

    export function MAD(sample: StaticArray<f64>, median: f64): f64 {
      const absDevs = new StaticArray<f64>(sample.length);
      for (let i = 0; i < sample.length; ++i) {
        absDevs[i] = abs(sample[i] - median);
      }

      absDevs.sort();
      return sorted.median(absDevs) * 1.4826;
    }

    // unchecked
    // - p must be in the range [0, 100]
    export function percentile(sample: StaticArray<f64>, p: f64): f64 {
      const len = sample.length - 1;
      if (p == 100) {
        return sample[len];
      }

      const rank: f64 = (p / 100) * len;
      const integer = floor(rank);
      const fraction = rank - integer;
      const n = integer as u32;
      const flooring = unchecked(sample[n]);
      const ceiling = unchecked(sample[n + 1]);

      return flooring + (ceiling - flooring) * fraction;
    }

    export namespace CI {
      export function LB(sample: StaticArray<f64>): f64 {
        return percentile(sample, 50 * (1 - cfgConfidenceLevel));
      }

      export function HB(sample: StaticArray<f64>): f64 {
        return percentile(sample, 50 * (1 + cfgConfidenceLevel));
      }
    }
  }
}

namespace Regression {
  function dot(x: StaticArray<f64>, y: StaticArray<f64>): f64 {
    let sum: f64 = 0;
    for (let i = 0; i < x.length; ++i) {
      sum += x[i] * y[i];
    }
    return sum;
  }

  export function fit(x: StaticArray<f64>, y: StaticArray<f64>): f64 {
    const xy = dot(x, y);
    const x2 = dot(x, x);
    return xy / x2;
  }
}

// --- working buffers, sized to the effective settings ------------------------
// as-tral sized these at compile time from transform-injected constants; here
// settings are runtime values, so buffers are (re)allocated whenever the
// effective (sampleSize, numResamples) pair changes. A mid-suite change drops
// the captured suite baseline (it lived in the old buffers).

let bufSampleSize: i32 = -1;
let bufNumResamples: i32 = -1;

let times = new StaticArray<f64>(0);
let suiteTimes = new StaticArray<f64>(0);
let averageTimes = new StaticArray<f64>(0);

let mIters = new StaticArray<u64>(0);
let suiteIters = new StaticArray<f64>(0);

// bootstrapping arrays
let resampleX = new StaticArray<f64>(0);
let resampleY = new StaticArray<f64>(0);

let sample = new StaticArray<f64>(0);
let baseAvgTimes = new StaticArray<f64>(0);

let tDist = new StaticArray<f64>(0);
let distMeanChange = new StaticArray<f64>(0);
let meanChangePoint: f64 = 0;
let pValue: f64 = 0;

let distMean = new StaticArray<f64>(0);
let distStdDev = new StaticArray<f64>(0);
let distMedian = new StaticArray<f64>(0);
let distMAD = new StaticArray<f64>(0);

// for linear sampling
let mItersF = new StaticArray<f64>(0);
let distFit = new StaticArray<f64>(0);

// host-loaded baseline staging (filled by the loadBaseline import on demand)
let baselineTimesBuf = new StaticArray<f64>(0);
let baselineItersBuf = new StaticArray<f64>(0);

function ensureBuffers(sampleSize: i32, numResamples: i32): void {
  if (sampleSize == bufSampleSize && numResamples == bufNumResamples) return;

  times = new StaticArray<f64>(sampleSize);
  suiteTimes = new StaticArray<f64>(sampleSize);
  averageTimes = new StaticArray<f64>(sampleSize);
  mIters = new StaticArray<u64>(sampleSize);
  suiteIters = new StaticArray<f64>(sampleSize);
  resampleX = new StaticArray<f64>(sampleSize);
  resampleY = new StaticArray<f64>(sampleSize);
  sample = new StaticArray<f64>(sampleSize * 2);
  baseAvgTimes = new StaticArray<f64>(sampleSize);
  mItersF = new StaticArray<f64>(sampleSize);
  baselineTimesBuf = new StaticArray<f64>(sampleSize);
  baselineItersBuf = new StaticArray<f64>(sampleSize);

  tDist = new StaticArray<f64>(numResamples);
  distMeanChange = new StaticArray<f64>(numResamples);
  distMean = new StaticArray<f64>(numResamples);
  distStdDev = new StaticArray<f64>(numResamples);
  distMedian = new StaticArray<f64>(numResamples);
  distMAD = new StaticArray<f64>(numResamples);
  distFit = new StaticArray<f64>(numResamples);

  bufSampleSize = sampleSize;
  bufNumResamples = numResamples;
  flags &= ~FLAG_SUITE_BASELINE; // old baseline arrays are gone
}

// --- public engine entry points ----------------------------------------------

export function beginSuite(name: string): void {
  host.suiteStart(name);
  flags |= FLAG_IN_SUITE;
  flags &= ~FLAG_SUITE_BASELINE;
}

export function endSuite(): void {
  host.suiteEnd();
  flags &= ~(FLAG_IN_SUITE | FLAG_SUITE_BASELINE);
}

export function runBench(name: string, routine: () => void, throughput: f64 = 0): void {
  host.benchStart(name);

  if (host.shouldSkip(name)) {
    host.benchEnd();
    return;
  }

  // resolve effective settings (host gets an override shot at each)
  cfgWarmupTime = host.tune(0, settings.warmupTime);
  cfgMeasurementTime = host.tune(1, settings.measurementTime);
  const sampleSize = <i32>host.tune(2, <f64>settings.sampleSize);
  const numResamples = <i32>host.tune(3, <f64>settings.numResamples);
  cfgSamplingMode = <i32>host.tune(4, <f64>(settings.samplingMode as i32));
  cfgConfidenceLevel = host.tune(5, settings.confidenceLevel);
  const warmupTolerance = host.tune(6, settings.warmupTolerance);
  const warmupMinTime = host.tune(7, settings.warmupMinTime);

  // profile mode (host-only, tune kind 8): value = iteration count. Run the
  // routine exactly that many times and report nothing — counters/timers in
  // an instrumented build do the measuring (=instr passes 1; =time passes
  // more to beat clock granularity). Early return keeps engine allocations
  // out of the counted window (host snapshots at benchStart/benchEnd).
  const profileIters = <i32>host.tune(8, 0);
  if (profileIters != 0) {
    for (let i: i32 = 0; i < profileIters; i++) routine();
    host.benchEnd();
    return;
  }

  // deterministic mode (host-only, tune kind 9): announce every routine
  // invocation so the host's record/replay harness can segment iterations.
  // The iter() import call is inside the timed window — constant overhead
  // per iteration; compare deterministic runs only with deterministic runs.
  const deterministic = <i32>host.tune(9, 0) != 0;

  // sampleSize==0 means auto — resolved after warmup from met
  const sampleSizeOverride = sampleSize;
  cfgNumResamples = numResamples;

  // warmup — adaptive on top of criterion's doubling loop
  // (https://github.com/bheisler/criterion.rs/blob/ceade3b1d72c3ecef0896cbe0dee12f43a6ce240/src/routine.rs#L216):
  // once past warmupMinTime, if consecutive batch mets agree within
  // warmupTolerance for STABLE_BATCHES batches, exit early as "converged".
  // warmupTime is the cap either way; tolerance 0 restores fixed-time warmup.
  // Stability is only judged on batches >= MIN_JUDGE_BATCH_MS so timer
  // quantization can't fake (or hide) convergence.
  const STABLE_BATCHES = 2;
  const MIN_JUDGE_BATCH_MS: f64 = 5.0;

  let warmupIters: u64 = 1;
  let totalWarmupIters: u64 = 0;
  let warmupElapsedTime: f64 = 0;
  let prevBatchMet: f64 = 0;
  let stableBatches = 0;
  let stableElapsed: f64 = 0;
  let stableIters: u64 = 0;
  let converged = false;

  host.warmupStarted(cfgWarmupTime);
  while (true) {
    let start = timeNow();

    for (let i: u64 = 0; i < warmupIters; ++i) {
      if (deterministic) host.iter();
      routine();
    }

    const batchElapsed = timeNow() - start;
    totalWarmupIters += warmupIters;
    warmupElapsedTime += batchElapsed;

    const batchMet = batchElapsed / (warmupIters as f64);
    if (warmupTolerance > 0 && prevBatchMet > 0 && warmupElapsedTime >= warmupMinTime && batchElapsed >= MIN_JUDGE_BATCH_MS) {
      const drift = abs(batchMet - prevBatchMet) / prevBatchMet;
      if (drift <= warmupTolerance) {
        stableBatches++;
        stableElapsed += batchElapsed;
        stableIters += warmupIters;
        if (stableBatches >= STABLE_BATCHES) {
          converged = true;
          break;
        }
      } else {
        stableBatches = 0;
        stableElapsed = 0;
        stableIters = 0;
      }
    }
    prevBatchMet = batchMet;

    if (warmupElapsedTime > cfgWarmupTime) {
      break;
    }

    warmupIters *= 2;
  }

  // mean execution time per iteration, the basis of the sampling plan. A
  // converged warmup estimates it from the stable tail only — the cumulative
  // average includes the cold first batches and biases the plan upward.
  const met = converged && stableIters > 0 ? stableElapsed / (stableIters as f64) : warmupElapsedTime / (totalWarmupIters as f64);
  host.warmupEnded(warmupElapsedTime, met, converged ? 1 : 0);

  // resolve sample count: explicit override, or auto-fit to measurementTime.
  // aim for each sample to represent at least 10 ms of work so individual
  // samples are well above timer noise; clamp to [10, 500].
  cfgSampleSize = sampleSizeOverride !== 0
    ? sampleSizeOverride
    : max(10, min(500, <i32>floor(cfgMeasurementTime / max(met, 10.0))));
  ensureBuffers(cfgSampleSize, cfgNumResamples);

  const useFlatSampling = cfgSamplingMode == <i32>SamplingMode.Auto ? Sampling.chooseSamplingMode(met) : cfgSamplingMode == <i32>SamplingMode.Flat;

  if (useFlatSampling) {
    Sampling.flatSampling(mIters, met);
  } else {
    Sampling.linearSampling(mIters, met);
  }

  let expectedMs: f64 = 0;
  let totalIters: f64 = 0;
  for (let i = 0; i < cfgSampleSize; ++i) {
    const iters = mIters[i] as f64;
    expectedMs += iters * met;
    totalIters += iters;
  }
  host.measureStarted(expectedMs, totalIters, cfgSampleSize);

  // sample collection
  let notWarned = true;
  for (let i = 0; i < cfgSampleSize; ++i) {
    let start = timeNow();

    const iters = mIters[i];
    for (let j: u64 = 0; j < iters; ++j) {
      if (deterministic) host.iter();
      routine();
    }

    const res = timeNow() - start;
    if (res == 0 && notWarned) {
      host.faultyBenchmark();
      notWarned = false;
    }

    times[i] = res;
    averageTimes[i] = res / (iters as f64);
  }

  // expose the raw sample (iters as f64 + per-sample times) to the host —
  // baseline saving and external tooling hang off this
  for (let i = 0; i < cfgSampleSize; ++i) {
    mItersF[i] = mIters[i] as f64;
  }
  host.sampleDone(changetype<usize>(mItersF), changetype<usize>(times), cfgSampleSize);

  host.analyzing();
  averageTimes.sort();

  // saved-baseline comparison: pull (times, iters) from the host if it has a
  // matching baseline for this bench (as-tral flags bit 0b1, pull-based here)
  const hasBaseline = host.loadBaseline(changetype<usize>(baselineTimesBuf), changetype<usize>(baselineItersBuf), cfgSampleSize) != 0;
  if (hasBaseline) {
    compare(changetype<usize>(baselineTimesBuf), changetype<usize>(baselineItersBuf));
  }

  // point estimates
  const meanPoint = Stats.mean(averageTimes);
  const stdDevPoint = Stats.stdDev(averageTimes, meanPoint);
  const medianPoint = Stats.sorted.median(averageTimes);
  const MADPoint = Stats.sorted.MAD(averageTimes, medianPoint);

  // univariate bootstrap over the per-iteration averages
  for (let i = 0; i < cfgNumResamples; ++i) {
    for (let j = 0; j < cfgSampleSize; ++j) {
      resampleY[j] = averageTimes[(Math.random() * cfgSampleSize) as u32];
    }

    resampleY.sort();

    const mean = Stats.mean(resampleY);
    distMean[i] = mean;
    distStdDev[i] = Stats.stdDev(resampleY, mean);

    // as-tral read the median off the (still-empty) median distribution here;
    // the resample itself is what's being summarized.
    const median = Stats.sorted.median(resampleY);
    distMedian[i] = median;
    distMAD[i] = Stats.sorted.MAD(resampleY, median);
  }

  distMean.sort();
  distStdDev.sort();
  distMedian.sort();
  distMAD.sort();

  // confidence intervals
  host.estimate(0, Stats.sorted.CI.LB(distMean), meanPoint, Stats.sorted.CI.HB(distMean));
  host.estimate(1, Stats.sorted.CI.LB(distMedian), medianPoint, Stats.sorted.CI.HB(distMedian));
  host.estimate(2, Stats.sorted.CI.LB(distStdDev), stdDevPoint, Stats.sorted.CI.HB(distStdDev));
  host.estimate(3, Stats.sorted.CI.LB(distMAD), MADPoint, Stats.sorted.CI.HB(distMAD));

  // regression: headline is the slope under linear sampling, the mean under flat
  let resultLB: f64 = 0, resultPoint: f64 = 0, resultHB: f64 = 0;
  if (useFlatSampling) {
    flags &= ~FLAG_SLOPE;
    resultLB = Stats.sorted.CI.LB(distMean);
    resultPoint = meanPoint;
    resultHB = Stats.sorted.CI.HB(distMean);
    host.result(resultLB, resultPoint, resultHB);
  } else {
    flags |= FLAG_SLOPE;
    // mItersF already filled for sampleDone above
    const slopePoint = Regression.fit(mItersF, times);

    // bivariate bootstrap over (iterations, time) pairs
    for (let i = 0; i < cfgNumResamples; ++i) {
      for (let j = 0; j < cfgSampleSize; ++j) {
        const k = (Math.random() * cfgSampleSize) as u32;
        resampleX[j] = mItersF[k];
        resampleY[j] = times[k];
      }
      distFit[i] = Regression.fit(resampleX, resampleY);
    }

    distFit.sort();
    resultLB = Stats.sorted.CI.LB(distFit);
    resultHB = Stats.sorted.CI.HB(distFit);
    resultPoint = slopePoint;
    host.estimate(4, resultLB, resultPoint, resultHB);
    host.result(resultLB, resultPoint, resultHB);
  }

  // throughput: elements-per-second CI (CI bounds invert — lower time = higher rate)
  if (throughput > 0 && resultPoint > 0) {
    // times are in ms; divide by 1000 for seconds
    host.throughput(throughput / (resultHB / 1000), throughput / (resultPoint / 1000), throughput / (resultLB / 1000));
  }

  // report the saved-baseline delta before the suite block reuses the
  // comparison state (distMeanChange/pValue are shared scratch)
  if (hasBaseline) {
    distMeanChange.sort();
    host.change(Stats.sorted.CI.LB(distMeanChange), meanChangePoint, Stats.sorted.CI.HB(distMeanChange), pValue);
  }

  // suite-relative comparison: first bench is the baseline, the rest report
  // their delta against it
  if ((flags & FLAG_IN_SUITE) != 0) {
    if ((flags & FLAG_SUITE_BASELINE) != 0) {
      compare(changetype<usize>(suiteTimes), changetype<usize>(suiteIters));
      distMeanChange.sort();
      host.suiteChange(Stats.sorted.CI.LB(distMeanChange), meanChangePoint, Stats.sorted.CI.HB(distMeanChange), pValue);
    } else {
      for (let i = 0; i < cfgSampleSize; ++i) {
        suiteIters[i] = mIters[i] as f64;
        suiteTimes[i] = times[i];
      }
      flags |= FLAG_SUITE_BASELINE;
    }
  }

  // Tukey fences over the per-iteration averages
  const mild = 1.5;
  const severe = 3;

  const q1 = Stats.sorted.percentile(averageTimes, 25);
  const q3 = Stats.sorted.percentile(averageTimes, 75);
  const iqr = q3 - q1;
  const lost = q1 - severe * iqr;
  const lomt = q1 - mild * iqr;
  const himt = q3 + mild * iqr;
  const hist = q3 + severe * iqr;

  let los = 0;
  let lom = 0;
  let him = 0;
  let his = 0;
  for (let i = 0; i < cfgSampleSize; i++) {
    const x = averageTimes[i];
    if (x < lost) ++los;
    else if (x > hist) ++his;
    else if (x < lomt) ++lom;
    else if (x > himt) ++him;
  }

  host.outliers(los, lom, him, his);
  host.benchEnd();
}

// Two-sample comparison against a baseline given as raw (times, iters) f64
// arrays — pointer-based so it can read either the suite buffers or, later,
// a host-loaded saved baseline.
function compare(timesPtr: usize, itersPtr: usize): void {
  for (let i = 0; i < cfgSampleSize; ++i) {
    const baseAvgTime = load<f64>(timesPtr + ((<usize>i) << alignof<f64>())) / load<f64>(itersPtr + ((<usize>i) << alignof<f64>()));
    baseAvgTimes[i] = baseAvgTime;

    sample[i] = averageTimes[i];
    sample[i + cfgSampleSize] = baseAvgTime;
  }

  // mixed two-sample bootstrap on t score (criterion: analysis/compare.rs > t_test)
  const tPoint = Stats.t(averageTimes, baseAvgTimes);
  for (let i = 0; i < cfgNumResamples; ++i) {
    for (let j = 0; j < cfgSampleSize; ++j) {
      resampleX[j] = sample[(Math.random() * cfgSampleSize * 2) as u32];
      resampleY[j] = sample[(Math.random() * cfgSampleSize * 2) as u32];
    }
    tDist[i] = Stats.t(resampleX, resampleY);
  }

  // estimate change (criterion: analysis/compare.rs > estimates)
  meanChangePoint = Stats.mean(averageTimes) / Stats.mean(baseAvgTimes) - 1.0;

  baseAvgTimes.sort();

  // two-sample bootstrap (criterion: stats/univariate/mod.rs > bootstrap)
  const numResamplesSqrt = <i32>ceil(sqrt(<f64>cfgNumResamples));
  const perChunk = (cfgNumResamples + numResamplesSqrt - 1) / numResamplesSqrt;
  for (let i = 0; i < numResamplesSqrt; ++i) {
    const start = i * perChunk;
    const end = min((i + 1) * perChunk, cfgNumResamples);

    for (let j = 0; j < cfgSampleSize; ++j) {
      resampleX[j] = averageTimes[(Math.random() * cfgSampleSize) as u32];
    }

    resampleX.sort();
    for (let k = start; k < end; ++k) {
      for (let j = 0; j < cfgSampleSize; ++j) {
        resampleY[j] = baseAvgTimes[(Math.random() * cfgSampleSize) as u32];
      }
      resampleY.sort();
      distMeanChange[k] = Stats.mean(resampleX) / Stats.mean(resampleY) - 1.0;
    }
  }

  pValue = Stats.p_value_2(tDist, tPoint);
}
