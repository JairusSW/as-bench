import { freeMemory, formatTime } from "./util";

const BENCHMARK_WASM_VERSION = "0.0.0-alpha";

export class SampleData {
    public expectedTime: f64;
    public actualTime: f64;
    public iterations: u64;

    public avgTimePerIter: f64;
    constructor(actualTime: f64, expectedTime: f64, iters: u64) {
        this.actualTime = actualTime;
        this.expectedTime = expectedTime;
        this.iterations = iters;

        this.avgTimePerIter = actualTime / f64(iters);
    }
}

export enum WarningTypes {
    None,
    Warn,
    Throw
}

const warmup_duration = 5000;
const execute_duration = 5000;

export function bench(description: string, routine: () => void): void {
    //console.log(`Running benchmark-wasm v${BENCHMARK_WASM_VERSION}`);
    //console.log(` - Runtime: ${numToRuntime(ASC_RUNTIME)}`);
    console.log(`Benchmarking ${description}:`);
    const ratio = warmup(description, routine, warmup_duration);
    execute(description, routine, execute_duration, 100, ratio);
}

export function warmup(description: string, routine: () => void, ms: i32): f64 {
    console.log(` - Warming up for ${ms}ms`);
    let calibrated = false;
    let current_iter: u64 = 1;
    let total_iter: u64 = 0;
    let total_time: f64 = 0.0;
    while (true) {
        const start_time = performance.now();
        let running_iters = current_iter;
        while (--running_iters) {
            routine();
        }
        const loop_time = performance.now() - start_time;
        total_time += loop_time;
        if (total_time >= ms) return (total_time / f64(total_iter));

        if (calibrated) {
            total_iter += current_iter;
        } else {
            if (loop_time >= 5) {
                calibrated = true;
                current_iter = u64(5000.0 / loop_time);
                total_time = 0.0;
            } else {
                current_iter *= 2;
            }
        }
        freeMemory();
    }
}

export function execute(description: string, routine: () => void, ms: i32, sample_count: u32, ratio: f64): void {
    console.log(` - Calibrating precision`);
    let calibrated = false;
    let bench_time: f64 = 0.0;
    let bench_iters: u64 = 0;

    //let ratio: f64 = 0;

    let warnType: WarningTypes = WarningTypes.None;

    let sample_time: f64 = 0.0;
    let sample_iters: u64 = 1;

    let samples_taken: u64 = 0;

    while (true) {
        const start_time = performance.now();
        let i = sample_iters;
        while (i--) {
            routine();
        }
        const loop_time = performance.now() - start_time;
        bench_time += loop_time;
        bench_iters += sample_iters;
        // Clear the memory after each run.
        // This prevents memory overflow and releases the GC for more accurate results
        // Though not real world conditions
        freeMemory();
        if (calibrated) {
            // Calculate sample results
            //const sample = new SampleData(loop_time, sample_time, sample_iters);
            //sample_data[i32(samples_taken)] = sample;
            samples_taken++;
            if (bench_time >= 5000.0) {
                console.log(`Completed ${bench_iters} iterations in ${formatTime(bench_time)}. (${samples_taken} samples taken out of ${sample_count} estimated samples)\n`);
                break;
            }
            //sample_iters = u64(5000.0 / loop_time);
        } else {
            bench_time += loop_time;
            if (loop_time == 0.0) {
                // Zero time execution
                console.log("WARNING: A routine executed in zero time. This should not be possible. Please blackbox the routine function and its parameters.");
                console.log("SKIPPING: Could not calibrate this benchmark. Skipping to next benchmark.");
                warnType = WarningTypes.Throw;
                break;
            } else if (bench_time >= ms) {
                // Possibly have a zero-time execution
                console.log(`WARNING: Could not attain calibration within ${ms}ms. Please blackbox the routine function and its parameters.`);
                console.log("SKIPPING: Could not calibrate this benchmark. Skipping to next benchmark.");
                warnType = WarningTypes.Throw;
                break;
            } else if (loop_time >= 50) {
                // We have calculated proper sample size
                calibrated = true;

                // Ratio between # of operations and time
                ratio = bench_time / f64(bench_iters);

                // Exact count of samples to be taken
                sample_count = 100//u32(f64(ms) / loop_time);
                //console.log(`Sample Count: ${sample_count}`);

                // Exact number of iterations per sample
                sample_iters = u64((f64(ms) / f64(sample_count)) / ratio);
                //console.log(`Sample Iterations: ${sample_iters}`);
                // Estimated ms per sample
                sample_time = loop_time;
                //console.log(`Sample Time: ${sample_time}`)
                bench_time = 0.0;
                console.log(` - Running benchmark`);
            } else {
                // Exponentially increase amount of iterations to reach calibration time
                sample_iters *= 2;
            }
        }
    }
}

const blackboxArea = memory.data(128);
export function blackbox<T>(x: T): T {
    store<T>(blackboxArea, x);
    return load<T>(blackboxArea);
}