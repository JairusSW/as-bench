// Thin, runtime-agnostic JS host for as-bench. A runner imports `instantiate`
// from `as-bench/lib`, hands it an import object, and gets back a started
// instance — the same wasm runs unchanged under node bindings, WASI, etc. The
// statistics engine lives inside the wasm; this layer only supplies timing,
// the data/IO channel, and (later) the record/replay glue.
//
// Scaffold stage: bindings + WASI instantiation and a live `now()`. WIPC and
// replay wiring land in steps 2–3.

import fs from "node:fs";

export type RuntimeTarget = "bindings" | "wasi";

/** High-resolution monotonic-ish clock the wasm engine times against. */
export function now(): number {
  return performance.now();
}

function resolveRuntimeTarget(): RuntimeTarget {
  const env = process.env.AS_BENCH_RUNTIME_TARGET;
  if (env === "wasi") return "wasi";
  return "bindings";
}

function resolveWasmPath(): string {
  const env = process.env.AS_BENCH_WASM;
  if (env) return env;
  const last = process.argv[process.argv.length - 1];
  if (!last || !last.endsWith(".wasm")) {
    throw new Error("as-bench: no wasm path (set AS_BENCH_WASM or pass the .wasm as the last argument)");
  }
  return last;
}

/**
 * Default import object. `env.abort` mirrors AssemblyScript's abort ABI; the
 * `bench` namespace carries the host calls the engine relies on (currently just
 * `now`). Runners may spread additional imports on top.
 */
export function defaultImports(): WebAssembly.Imports {
  return {
    env: {
      abort(_msg: number, _file: number, line: number, column: number): void {
        throw new Error(`as-bench: wasm abort at ${line}:${column}`);
      },
    },
    bench: {
      now,
    },
  };
}

async function instantiateBindings(bytes: Uint8Array, imports: WebAssembly.Imports): Promise<WebAssembly.Instance> {
  // Compile-then-instantiate (the Module overload) to keep the return type an
  // unambiguous Instance rather than a {module, instance} source. The cast
  // sidesteps the Buffer/BufferSource ArrayBufferLike mismatch in TS6 libs.
  const module = await WebAssembly.compile(bytes as BufferSource);
  return WebAssembly.instantiate(module, imports);
}

async function instantiateWasi(bytes: Uint8Array, imports: WebAssembly.Imports): Promise<WebAssembly.Instance> {
  const { WASI } = await import("node:wasi");
  const wasi = new WASI({ version: "preview1", args: process.argv, env: process.env as Record<string, string>, preopens: {} });
  const merged: WebAssembly.Imports = { wasi_snapshot_preview1: wasi.wasiImport, ...imports };
  const module = await WebAssembly.compile(bytes as BufferSource);
  const instance = await WebAssembly.instantiate(module, merged);
  // Reactor vs command: initialize when there's no _start, start otherwise.
  const exports = instance.exports as Record<string, unknown>;
  if (typeof exports._start === "function") {
    wasi.start(instance);
  } else {
    wasi.initialize(instance);
  }
  return instance;
}

/**
 * Instantiate the benchmark wasm on the active runtime target. The wasm path is
 * resolved from `AS_BENCH_WASM` or the final CLI argument; the target from
 * `AS_BENCH_RUNTIME_TARGET` (defaults to node bindings).
 */
export async function instantiate(imports: WebAssembly.Imports = defaultImports()): Promise<WebAssembly.Instance> {
  const bytes = fs.readFileSync(resolveWasmPath());
  const target = resolveRuntimeTarget();
  if (target === "wasi") {
    return instantiateWasi(bytes, imports);
  }
  return instantiateBindings(bytes, imports);
}
