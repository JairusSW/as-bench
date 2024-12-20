import { computeGrowthFactor, formatTime } from "./util";

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

export enum SamplingType {
    Fixed,
    Dynamic
}

const WARMUP_TIME: f64 = 3000.0;
const RUN_TIME: f64 = 5000.0;
const SAMPLES: u64 = 250;
const SAMPLE_RATE: u64 = u64(RUN_TIME) / SAMPLES;

export function bench(description: string, routine: () => void, type: SamplingType = SamplingType.Fixed): void {
    console.log(` - Warming up for ${WARMUP_TIME}ms`);
    let warmupIters: u64 = 1;
    let totalWarmupIters: u64 = 0;
    let warmupElapsedTime: f64 = 0;

    while (true) {
        const start = performance.now();

        for (let i: u64 = 0; i < warmupIters; i++) {
            routine();
        }

        totalWarmupIters += warmupIters;
        warmupElapsedTime += performance.now() - start;

        if (warmupElapsedTime >= WARMUP_TIME) break;

        warmupIters *= 2; // computeGrowthFactor(warmupIters);
    }

    // Initial calculation of sample time and iterations per sample
    let sampleTime = (warmupElapsedTime / f64(totalWarmupIters)) * f64(SAMPLE_RATE);
    let sampleIters = (totalWarmupIters / u64(warmupElapsedTime)) * SAMPLE_RATE;

    console.log(`Benchmarking ${description}:`);

    let runIters: u64 = 0;
    let runElapsedTime: f64 = 0;
    let samples: u64 = 0;

    while (true) {
        const start = performance.now();

        for (let i: u64 = 0; i < sampleIters; i++) {
            routine();
        }

        const elapsed = performance.now() - start;
        samples++;

        runIters += sampleIters;
        runElapsedTime += elapsed;

        if (runElapsedTime >= RUN_TIME) break;

        if (type === SamplingType.Dynamic) {
            sampleTime = (runElapsedTime / f64(runIters)) * f64(SAMPLE_RATE);
            sampleIters = (runIters / u64(runElapsedTime)) * SAMPLE_RATE;
        }
    }

    console.log(
        `Completed ${runIters} iterations in ${formatTime(runElapsedTime)} at (${runIters / u64(runElapsedTime / 1000)}ops/s). (${samples} samples taken out of ${SAMPLES} estimated samples)\n`
    );
}

const blackboxArea = memory.data(128);
export function blackbox<T>(x: T): T {
    store<T>(blackboxArea, x);
    return load<T>(blackboxArea);
}
