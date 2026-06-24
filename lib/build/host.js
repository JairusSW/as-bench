import fs from "node:fs";
import { DeterministicHarness } from "./replay.js";
export { DeterministicHarness } from "./replay.js";
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
export const TUNE_KEYS = ["warmupTime", "measurementTime", "sampleSize", "numResamples", "samplingMode", "confidenceLevel", "warmupTolerance", "warmupMinTime", "profileMode", "deterministic"];
let wasiWarningFiltered = false;
export function filterWasiWarning() {
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
export function benchImports(getMem, reporter = {}, tunes = {}, harness = null, filter = null) {
    let suiteName = null;
    let benchName = "";
    const key = () => (suiteName !== null ? `${suiteName}/${benchName}` : benchName);
    return {
        now,
        tune(kind, value) {
            const key = TUNE_KEYS[kind];
            const override = key === undefined ? undefined : tunes[key];
            return override === undefined ? value : override;
        },
        benchStart: (ptr, len) => {
            benchName = readString(getMem(), ptr, len);
            reporter.benchStart?.(benchName);
        },
        warmupStarted: (ms) => reporter.warmupStarted?.(ms),
        warmupEnded: (elapsed, met, converged) => reporter.warmupEnded?.(elapsed, met, converged !== 0),
        measureStarted: (est, iters, samples) => reporter.measureStarted?.(est, iters, samples),
        analyzing: () => {
            harness?.reset();
            reporter.analyzing?.();
        },
        faultyConfig: (linear, actualMs, rec) => reporter.faultyConfig?.(linear !== 0, actualMs, rec),
        faultyBenchmark: () => reporter.faultyBenchmark?.(),
        estimate: (kind, lb, point, hb) => reporter.estimate?.(kind, lb, point, hb),
        result: (lb, point, hb) => reporter.result?.(lb, point, hb),
        outliers: (los, lom, him, his) => reporter.outliers?.(los, lom, him, his),
        benchEnd: () => {
            harness?.reset();
            reporter.benchEnd?.();
        },
        iter: () => harness?.iter(),
        suiteStart: (ptr, len) => {
            suiteName = readString(getMem(), ptr, len);
            reporter.suiteStart?.(suiteName);
        },
        suiteChange: (lb, point, hb, p) => reporter.suiteChange?.(lb, point, hb, p),
        suiteEnd: () => {
            suiteName = null;
            reporter.suiteEnd?.();
        },
        sampleDone: (itersPtr, timesPtr, n) => {
            if (!reporter.sampleDone)
                return;
            const mem = getMem();
            reporter.sampleDone(key(), new Float64Array(mem.buffer, itersPtr, n).slice(), new Float64Array(mem.buffer, timesPtr, n).slice());
        },
        loadBaseline: (timesPtr, itersPtr, n) => {
            const baseline = reporter.getBaseline?.(key(), n);
            if (!baseline || baseline.times.length !== n || baseline.iters.length !== n)
                return 0;
            const mem = getMem();
            new Float64Array(mem.buffer, timesPtr, n).set(baseline.times);
            new Float64Array(mem.buffer, itersPtr, n).set(baseline.iters);
            return 1;
        },
        change: (lb, point, hb, p) => reporter.change?.(lb, point, hb, p),
        throughput: (lb, point, hb) => reporter.throughput?.(lb, point, hb),
        suiteChart: (namePtr, nameLen, typePtr, typeLen) => {
            const name = readString(getMem(), namePtr, nameLen);
            const type = readString(getMem(), typePtr, typeLen);
            reporter.suiteChart?.(name, type);
        },
        shouldSkip: (ptr, len) => {
            if (!filter)
                return 0;
            const name = readString(getMem(), ptr, len);
            return filter(name) ? 0 : 1;
        },
    };
}
export async function runBenchFile(wasmPath, reporter = {}, tunes = {}, extraImports = {}, filter = null) {
    const bytes = fs.readFileSync(wasmPath);
    filterWasiWarning();
    const { WASI } = await import("node:wasi");
    const wasi = new WASI({ version: "preview1", args: [wasmPath], env: {}, preopens: {} });
    let instance;
    const getMem = () => instance.exports.memory;
    const harness = tunes.deterministic === 1 ? new DeterministicHarness(getMem) : null;
    const wrapNs = (ns, mod) => (harness ? harness.wrapNamespace(ns, mod) : mod);
    const imports = {
        wasi_snapshot_preview1: wrapNs("wasi_snapshot_preview1", wasi.wasiImport),
        __asbench: benchImports(getMem, reporter, tunes, harness, filter),
    };
    for (const ns of Object.keys(extraImports)) {
        imports[ns] = ns === "__asbench" ? extraImports[ns] : wrapNs(ns, extraImports[ns]);
    }
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
