export type RuntimeTarget = "bindings" | "wasi";
export declare function now(): number;
export declare enum EstimateKind {
    Mean = 0,
    Median = 1,
    StdDev = 2,
    MAD = 3,
    Slope = 4
}
export interface TuneOverrides {
    warmupTime?: number;
    measurementTime?: number;
    sampleSize?: number;
    numResamples?: number;
    samplingMode?: number;
    confidenceLevel?: number;
}
export interface BenchReporter {
    benchStart?(name: string): void;
    warmupStarted?(durationMs: number): void;
    measureStarted?(estimatedMs: number, totalIters: number, sampleCount: number): void;
    analyzing?(): void;
    faultyConfig?(linear: boolean, actualMs: number, recommendedSamples: number): void;
    faultyBenchmark?(): void;
    estimate?(kind: EstimateKind, lb: number, point: number, hb: number): void;
    result?(lb: number, point: number, hb: number): void;
    outliers?(los: number, lom: number, him: number, his: number): void;
    benchEnd?(): void;
    suiteStart?(name: string): void;
    suiteChange?(lb: number, point: number, hb: number, pValue: number): void;
    suiteEnd?(): void;
}
export declare function benchImports(getMem: () => WebAssembly.Memory, reporter?: BenchReporter, tunes?: TuneOverrides): WebAssembly.ModuleImports;
export declare function runBenchFile(wasmPath: string, reporter?: BenchReporter, tunes?: TuneOverrides, extraImports?: WebAssembly.Imports): Promise<void>;
export declare function defaultImports(): WebAssembly.Imports;
export declare function instantiate(imports?: WebAssembly.Imports): Promise<WebAssembly.Instance>;
