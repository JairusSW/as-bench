import { formatTime } from "./util";

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
    console.log(`Benchmarking ${description}:`);
    warmup(description, routine, warmup_duration);
    execute(description, routine, execute_duration, 10);
}

export function warmup(description: string, routine: () => void, ms: i32): void {
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
        if (total_time >= ms) break;

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
    }
}

export function execute(description: string, routine: () => void, ms: i32, calibrate_at_ms: i32): void {
    console.log(` - Calibrating precision`);
    let calibrated = false;
    let calibration_time: f64 = 0.0;

    let warnType: WarningTypes = WarningTypes.None;

    let sample_count: u64 = 0;
    let sample_time: f64 = 0.0;
    let sample_iters: u64 = 1;

    let samples_taken: u64 = 0;

    let sample_data = new StaticArray<SampleData>(i32(sample_count));
    let benchmark_time: f64 = 0.0;

    do {
        const start_time = performance.now();
        let i = sample_iters;
        while (i--) {
            routine();
        }
        const loop_time = performance.now() - start_time;
        if (calibrated) {
            // Calculate sample results
            const sample = new SampleData(loop_time, sample_time, sample_iters);
            sample_data[i32(samples_taken)] = sample;
            if (benchmark_time >= ms) {
                console.log(`Completed ${sample_iters * sample_count} iterations in ${formatTime(benchmark_time)}.`);
                break;
            }
        } else {
            calibration_time += loop_time;
            if (loop_time == 0.0) {
                // Zero time execution
                console.log("WARNING: A routine executed in zero time. This should not be possible. Please blackbox the routine function and its parameters.");
                console.log("SKIPPING: Could not calibrate this benchmark. Skipping to next benchmark.");
                warnType = WarningTypes.Throw;
                break;
            } else if (calibration_time >= ms) {
                // Possibly have a zero-time execution
                console.log(`WARNING: Could not attain calibration within ${ms}ms. Please blackbox the routine function and its parameters.`);
                console.log("SKIPPING: Could not calibrate this benchmark. Skipping to next benchmark.");
                warnType = WarningTypes.Throw;
                break;
            } else if (loop_time >= calibrate_at_ms) {
                // We have calculated proper sample size
                calibrated = true;
                // Estimated ms per sample
                sample_time = loop_time;
                // Exact count of samples to be taken
                sample_count = u64(5000.0 / loop_time);
            } else {
                // Exponentially increase amount of iterations to reach calibration time
                sample_iters *= 2;
            }
        }
    } while (true);
}

const blackboxArea = memory.data(128);
export function blackbox<T>(x: T): T {
    store<T>(blackboxArea, x);
    return load<T>(blackboxArea);
}