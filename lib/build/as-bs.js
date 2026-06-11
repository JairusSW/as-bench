import fs from "node:fs";
export function now() {
    return performance.now();
}
export var EstimateKind;
(function (EstimateKind) {
    EstimateKind[EstimateKind["Mean"] = 0] = "Mean";
    EstimateKind[EstimateKind["Median"] = 1] = "Median";
    EstimateKind[EstimateKind["StdDev"] = 2] = "StdDev";
    EstimateKind[EstimateKind["MAD"] = 3] = "MAD";
    EstimateKind[EstimateKind["Slope"] = 4] = "Slope";
})(EstimateKind || (EstimateKind = {}));
const TUNE_KEYS = [
    "warmupTime",
    "measurementTime",
    "sampleSize",
    "numResamples",
    "samplingMode",
    "confidenceLevel",
];
let wasiWarningFiltered = false;
function filterWasiWarning() {
    if (wasiWarningFiltered)
        return;
    wasiWarningFiltered = true;
    const original = process.emitWarning.bind(process);
    process.emitWarning = ((warning, ...args) => {
        if (String(warning instanceof Error ? warning.message : warning).includes("WASI"))
            return;
        original(warning, ...args);
    });
}
const utf16 = new TextDecoder("utf-16le");
function readString(memory, ptr, len) {
    return utf16.decode(new Uint8Array(memory.buffer, ptr, len * 2));
}
export function benchImports(getMem, reporter = {}, tunes = {}) {
    return {
        now,
        tune(kind, value) {
            const key = TUNE_KEYS[kind];
            const override = key === undefined ? undefined : tunes[key];
            return override === undefined ? value : override;
        },
        benchStart: (ptr, len) => reporter.benchStart?.(readString(getMem(), ptr, len)),
        warmupStarted: (ms) => reporter.warmupStarted?.(ms),
        measureStarted: (est, iters, samples) => reporter.measureStarted?.(est, iters, samples),
        analyzing: () => reporter.analyzing?.(),
        faultyConfig: (linear, actualMs, rec) => reporter.faultyConfig?.(linear !== 0, actualMs, rec),
        faultyBenchmark: () => reporter.faultyBenchmark?.(),
        estimate: (kind, lb, point, hb) => reporter.estimate?.(kind, lb, point, hb),
        result: (lb, point, hb) => reporter.result?.(lb, point, hb),
        outliers: (los, lom, him, his) => reporter.outliers?.(los, lom, him, his),
        benchEnd: () => reporter.benchEnd?.(),
        suiteStart: (ptr, len) => reporter.suiteStart?.(readString(getMem(), ptr, len)),
        suiteChange: (lb, point, hb, p) => reporter.suiteChange?.(lb, point, hb, p),
        suiteEnd: () => reporter.suiteEnd?.(),
    };
}
export async function runBenchFile(wasmPath, reporter = {}, tunes = {}, extraImports = {}) {
    const bytes = fs.readFileSync(wasmPath);
    filterWasiWarning();
    const { WASI } = await import("node:wasi");
    const wasi = new WASI({ version: "preview1", args: [wasmPath], env: {}, preopens: {} });
    let instance;
    const getMem = () => instance.exports.memory;
    const imports = {
        wasi_snapshot_preview1: wasi.wasiImport,
        __asbench: benchImports(getMem, reporter, tunes),
        ...extraImports,
    };
    const module = await WebAssembly.compile(bytes);
    instance = await WebAssembly.instantiate(module, imports);
    wasi.start(instance);
}
function resolveRuntimeTarget() {
    const env = process.env.AS_BENCH_RUNTIME_TARGET;
    if (env === "wasi")
        return "wasi";
    return "bindings";
}
function resolveWasmPath() {
    const env = process.env.AS_BENCH_WASM;
    if (env)
        return env;
    const last = process.argv[process.argv.length - 1];
    if (!last || !last.endsWith(".wasm")) {
        throw new Error("as-bench: no wasm path (set AS_BENCH_WASM or pass the .wasm as the last argument)");
    }
    return last;
}
export function defaultImports() {
    return {
        env: {
            abort(_msg, _file, line, column) {
                throw new Error(`as-bench: wasm abort at ${line}:${column}`);
            },
        },
    };
}
async function instantiateBindings(bytes, imports) {
    const module = await WebAssembly.compile(bytes);
    return WebAssembly.instantiate(module, imports);
}
async function instantiateWasi(bytes, imports) {
    const { WASI } = await import("node:wasi");
    const wasi = new WASI({ version: "preview1", args: process.argv, env: process.env, preopens: {} });
    const merged = { wasi_snapshot_preview1: wasi.wasiImport, ...imports };
    const module = await WebAssembly.compile(bytes);
    const instance = await WebAssembly.instantiate(module, merged);
    const exports = instance.exports;
    if (typeof exports._start === "function") {
        wasi.start(instance);
    }
    else {
        wasi.initialize(instance);
    }
    return instance;
}
export async function instantiate(imports = defaultImports()) {
    const bytes = fs.readFileSync(resolveWasmPath());
    const target = resolveRuntimeTarget();
    if (target === "wasi") {
        return instantiateWasi(bytes, imports);
    }
    return instantiateBindings(bytes, imports);
}
