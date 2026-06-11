import fs from "node:fs";
export function now() {
    return performance.now();
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
        bench: {
            now,
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
