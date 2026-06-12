// Binaryen instrumentation pass for `asb profile --heaviest=instr`.
//
// Injects three mutable i64 globals per defined function — `__prof_c_<k>`
// (entry count), `__prof_n_<k>` (executed-instruction count), and
// `__prof_w_<k>` (cost-weighted instruction count) — all exported so the
// host can snapshot/diff them around each bench.
//
// Counting model: every binaryen IR node ≈ one wasm instruction (structural
// nodes — block, loop, nop — count as zero). The weighted counter scales
// each node by a static cost table (see costOf) so a division doesn't rank
// equal to an add. Increments are inserted at region granularity: function
// entry, each loop body, and each if-arm get `__prof_n += <count>` /
// `__prof_w += <cost>` where a region's totals exclude nested regions (they
// count themselves). Known imprecision: an early `br`/`return` out of a
// region still pays the region's full weight — fine for ranking, documented
// as "approximate".
//
// binaryen.js lacks JS wrappers for in-place mutation, so the three
// re-parenting operations use the raw C API (_BinaryenFunctionSetBody,
// _BinaryenLoopSetBody, _BinaryenIfSetIfTrue/False) — pointer-only calls, no
// string marshalling needed.

import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

// Resolve binaryen from the installed assemblyscript's context: asc pins an
// exact binaryen build, and instrumenting with the same one that compiled the
// module avoids any feature/encoding skew.
async function loadBinaryen(): Promise<typeof import("binaryen").default> {
  let resolved: string;
  try {
    const ascPkg = require.resolve("assemblyscript/package.json", { paths: [process.cwd(), import.meta.dirname ?? "."] });
    resolved = require.resolve("binaryen", { paths: [path.dirname(ascPkg)] });
  } catch {
    resolved = require.resolve("binaryen");
  }
  const mod = await import(resolved);
  return mod.default ?? mod;
}

export interface ProfiledFunction {
  /** Counter suffix: __prof_c_<k> / __prof_n_<k> / __prof_w_<k>. */
  k: number;
  name: string;
}

export interface InstrumentResult {
  wasm: Uint8Array;
  functions: ProfiledFunction[];
}

export async function instrumentWasm(input: Uint8Array): Promise<InstrumentResult> {
  const binaryen = await loadBinaryen();
  const module = binaryen.readBinary(input);
  module.setFeatures(binaryen.Features.All);

  // raw C-API handles (pointer-only mutation calls)
  const raw = binaryen as unknown as {
    _BinaryenGetNumFunctions(mod: number): number;
    _BinaryenGetFunctionByIndex(mod: number, i: number): number;
    _BinaryenFunctionSetBody(fn: number, body: number): void;
    _BinaryenLoopSetBody(loop: number, body: number): void;
    _BinaryenIfSetIfTrue(ifRef: number, ref: number): void;
    _BinaryenIfSetIfFalse(ifRef: number, ref: number): void;
    _BinaryenExpressionGetId(ref: number): number;
  };
  const modPtr = (module as unknown as { ptr: number }).ptr;

  // structural nodes that don't lower to executed instructions
  const ZERO_WEIGHT = new Set<number>([binaryen.BlockId, binaryen.LoopId, binaryen.NopId]);

  type Info = Record<string, unknown> & { id: number };
  const childRefs = (info: Info): number[] => {
    if (info.id === binaryen.ConstId) return []; // `value` is a literal here
    const out: number[] = [];
    for (const key of ["children", "operands", "condition", "ifTrue", "ifFalse", "body", "value", "left", "right", "ptr", "target", "dest", "source", "size", "delta"]) {
      const v = info[key];
      if (typeof v === "number" && v !== 0) out.push(v);
      else if (Array.isArray(v)) for (const c of v) if (typeof c === "number" && c !== 0) out.push(c);
    }
    return out;
  };

  const i64 = binaryen.i64;
  // this binaryen.js takes a single bigint for i64.const
  const i64const = (v: bigint): number => (module.i64.const as unknown as (v: bigint) => number)(v);
  const incr = (global: string, amount: number | bigint): number => {
    return module.global.set(global, module.i64.add(module.global.get(global, i64), i64const(BigInt(amount))));
  };

  // Static per-node cost table, in relative units ≈ modern-x86 latency
  // class: 1 = ALU op / const / local traffic, loads 3 / stores 2 (L1
  // assumption — cache behavior belongs to --heaviest=time), int mul 3,
  // divisions/sqrt 12–15, calls 5 (indirect 8), atomics 10, memory.grow 100.
  // Deliberately coarse and NOT timing-calibrated: per-instruction wall
  // times aren't additive under superscalar execution, so a measured table
  // would only pretend to more precision than exists.
  // The unary and binary op enums overlap numerically (AddInt32 === ClzInt32
  // === 0), so op sets are only consulted under their expression id.
  const isFloat = (t: number): boolean => t === binaryen.f32 || t === binaryen.f64;
  const opSet = (ops: (number | undefined)[]): Set<number> => new Set(ops.filter((o): o is number => o !== undefined));
  const b = binaryen as unknown as Record<string, number | undefined>;
  const INT_DIV_OPS = opSet([b.DivSInt32, b.DivUInt32, b.RemSInt32, b.RemUInt32, b.DivSInt64, b.DivUInt64, b.RemSInt64, b.RemUInt64]);
  const FLOAT_DIV_OPS = opSet([b.DivFloat32, b.DivFloat64]);
  const INT_MUL_OPS = opSet([b.MulInt32, b.MulInt64]);
  const SQRT_OPS = opSet([b.SqrtFloat32, b.SqrtFloat64]);
  const TRUNC_OPS = opSet([b.TruncSFloat32ToInt32, b.TruncUFloat32ToInt32, b.TruncSFloat64ToInt32, b.TruncUFloat64ToInt32, b.TruncSFloat32ToInt64, b.TruncUFloat32ToInt64, b.TruncSFloat64ToInt64, b.TruncUFloat64ToInt64, b.TruncSatSFloat32ToInt32, b.TruncSatUFloat32ToInt32, b.TruncSatSFloat64ToInt32, b.TruncSatUFloat64ToInt32, b.TruncSatSFloat32ToInt64, b.TruncSatUFloat32ToInt64, b.TruncSatSFloat64ToInt64, b.TruncSatUFloat64ToInt64]);
  const ATOMIC_IDS = opSet([b.AtomicRMWId, b.AtomicCmpxchgId, b.AtomicWaitId, b.AtomicNotifyId, b.AtomicFenceId]);

  const costOf = (x: Info): number => {
    switch (x.id) {
      case binaryen.LoadId:
        return x.isAtomic ? 10 : 3;
      case binaryen.StoreId:
        return x.isAtomic ? 10 : 2;
      case binaryen.CallId:
        return 5;
      case binaryen.CallIndirectId:
        return 8;
      case binaryen.MemoryGrowId:
        return 100;
      case binaryen.MemoryCopyId:
      case binaryen.MemoryFillId:
        return 8;
      case binaryen.BinaryId: {
        const op = x.op as number;
        if (INT_DIV_OPS.has(op)) return 15;
        if (FLOAT_DIV_OPS.has(op)) return 12;
        if (INT_MUL_OPS.has(op)) return 3;
        // float arithmetic — compares yield i32, so peek the left operand
        if (isFloat(x.type as number)) return 2;
        const left = x.left as number;
        if (left && raw._BinaryenExpressionGetId(left) !== binaryen.UnreachableId && isFloat((binaryen.getExpressionInfo(left) as unknown as Info).type as number)) return 2;
        return 1;
      }
      case binaryen.UnaryId: {
        const op = x.op as number;
        if (SQRT_OPS.has(op)) return 12;
        if (TRUNC_OPS.has(op)) return 3;
        if (isFloat(x.type as number)) return 2;
        return 1;
      }
      default:
        if (ATOMIC_IDS.has(x.id)) return 10;
        return ZERO_WEIGHT.has(x.id) ? 0 : 1;
    }
  };

  const functions: ProfiledFunction[] = [];
  const numFns = raw._BinaryenGetNumFunctions(modPtr);

  for (let i = 0; i < numFns; i++) {
    const fnRef = raw._BinaryenGetFunctionByIndex(modPtr, i);
    const info = binaryen.getFunctionInfo(fnRef);
    if (!info.body) continue; // imported

    const k = functions.length;
    functions.push({ k, name: info.name });
    const cGlobal = `__prof_c_${k}`;
    const nGlobal = `__prof_n_${k}`;
    const wGlobal = `__prof_w_${k}`;
    for (const g of [cGlobal, nGlobal, wGlobal]) {
      module.addGlobal(g, i64, true, i64const(0n));
      module.addGlobalExport(g, g);
    }

    // Walk the body totalling the current region's [count, cost]; loop
    // bodies and if-arms start their own regions (instrumented inside the
    // recursion).
    const walk = (ref: number): [number, number] => {
      // this binaryen.js nightly's getExpressionInfo throws on `unreachable`;
      // it's a childless 1-instruction leaf either way
      if (raw._BinaryenExpressionGetId(ref) === binaryen.UnreachableId) return [1, 1];
      const x = binaryen.getExpressionInfo(ref) as unknown as Info;
      let n = ZERO_WEIGHT.has(x.id) ? 0 : 1;
      let w = costOf(x);
      if (x.id === binaryen.IfId) {
        const ifInfo = x as Info & { condition: number; ifTrue: number; ifFalse: number };
        const [cn, cw] = walk(ifInfo.condition);
        n += cn;
        w += cw;
        wrapRegion(ifInfo.ifTrue, (b2) => raw._BinaryenIfSetIfTrue(ref, b2));
        if (ifInfo.ifFalse) wrapRegion(ifInfo.ifFalse, (b2) => raw._BinaryenIfSetIfFalse(ref, b2));
      } else if (x.id === binaryen.LoopId) {
        const loopInfo = x as Info & { body: number };
        wrapRegion(loopInfo.body, (b2) => raw._BinaryenLoopSetBody(ref, b2));
      } else {
        for (const child of childRefs(x)) {
          const [cn, cw] = walk(child);
          n += cn;
          w += cw;
        }
      }
      return [n, w];
    };

    const wrapRegion = (regionRef: number, replace: (blockRef: number) => void): void => {
      const [n, w] = walk(regionRef);
      if (n === 0) return;
      replace(module.block(null, [incr(nGlobal, n), incr(wGlobal, w), regionRef], binaryen.auto));
    };

    const [bodyCount, bodyCost] = walk(info.body);
    const prelude: number[] = [incr(cGlobal, 1)];
    if (bodyCount > 0) prelude.push(incr(nGlobal, bodyCount), incr(wGlobal, bodyCost));
    raw._BinaryenFunctionSetBody(fnRef, module.block(null, [...prelude, info.body], binaryen.auto));
  }

  if (!module.validate()) {
    throw new Error("instrumented module failed binaryen validation");
  }
  const wasm = module.emitBinary();
  module.dispose();
  return { wasm, functions };
}

export interface InstrumentTimeResult {
  wasm: Uint8Array;
  functions: ProfiledFunction[];
  /** Counter index of the injected `__tprof_calib` calibration function. */
  calibK: number;
  /** Functions left unwrapped (static weight < minWeight); their time accrues to callers. */
  skipped: number;
}

// Time pass for `asb profile --heaviest=time`.
//
// Every defined function whose static weight >= minWeight is outlined: its
// body moves to `<name>$tprof_inner` and a wrapper takes the original name,
// so exports, element segments (call_indirect — bench callbacks are function
// refs), and direct calls all flow through timing without any body surgery.
//
// Accounting (exact self-time, recursion-safe — see PLAN.md):
//   shared globals  __tprof_child (ns of direct wrapped callees in the
//                   current frame), __tprof_ccg (their call count)
//   per function k  __tprof_s_<k> self ns, __tprof_i_<k> inclusive ns,
//                   __tprof_c_<k> calls, __tprof_cc_<k> direct child calls,
//                   __tprof_d_<k> live depth (not exported)
//
//   wrapper: t0 = tnow(); save child/ccg in locals; zero them; depth++
//            r = call $inner(...)
//            dur = tnow() - t0
//            self += dur - child; cc += ccg; depth--
//            if depth == 0: incl += dur            (outermost frame only)
//            child = saved_child + dur; ccg = saved_ccg + 1
//
// `self` subtracts direct wrapped callees → exact self-time; the depth gate
// keeps recursive inclusive time from multi-counting. Per-frame state lives
// in wrapper locals, so the real call stack is the bookkeeping stack. Traps
// leak one frame (the run is over anyway).
//
// Overhead is measured, not guessed: `__tprof_calib` is an empty wrapped
// function and `__tprof_calib_run(n)` calls it n times in-wasm, returning
// the elapsed ns. The host derives the inside-window cost (calib's own
// self/n, charged to each wrapped function per call) and the outside-window
// remainder (charged to callers per child call) and subtracts both.
export async function instrumentTimeWasm(input: Uint8Array, minWeight: number): Promise<InstrumentTimeResult> {
  const binaryen = await loadBinaryen();
  const module = binaryen.readBinary(input);
  module.setFeatures(binaryen.Features.All);

  const raw = binaryen as unknown as {
    _BinaryenGetNumFunctions(mod: number): number;
    _BinaryenGetFunctionByIndex(mod: number, i: number): number;
    _BinaryenExpressionGetId(ref: number): number;
  };
  const modPtr = (module as unknown as { ptr: number }).ptr;

  const ZERO_WEIGHT = new Set<number>([binaryen.BlockId, binaryen.LoopId, binaryen.NopId]);
  type Info = Record<string, unknown> & { id: number };
  const childRefs = (info: Info): number[] => {
    if (info.id === binaryen.ConstId) return [];
    const out: number[] = [];
    for (const key of ["children", "operands", "condition", "ifTrue", "ifFalse", "body", "value", "left", "right", "ptr", "target", "dest", "source", "size", "delta"]) {
      const v = info[key];
      if (typeof v === "number" && v !== 0) out.push(v);
      else if (Array.isArray(v)) for (const c of v) if (typeof c === "number" && c !== 0) out.push(c);
    }
    return out;
  };
  // total static weight of a body — same node≈instruction model as the
  // instr pass, but flat (regions don't matter here)
  const weigh = (ref: number): number => {
    if (raw._BinaryenExpressionGetId(ref) === binaryen.UnreachableId) return 1;
    const x = binaryen.getExpressionInfo(ref) as unknown as Info;
    let w = ZERO_WEIGHT.has(x.id) ? 0 : 1;
    for (const child of childRefs(x)) w += weigh(child);
    return w;
  };

  const i64 = binaryen.i64;
  const i32 = binaryen.i32;
  const i64const = (v: bigint): number => (module.i64.const as unknown as (v: bigint) => number)(v);

  const NOW = "__tprof_now";
  const CHILD = "__tprof_child";
  const CCG = "__tprof_ccg";
  const SCG = "__tprof_scg"; // wrapped calls in the current frame's subtree
  module.addFunctionImport(NOW, "__asbench", "tnow", binaryen.none, i64);
  module.addGlobal(CHILD, i64, true, i64const(0n));
  module.addGlobal(CCG, i64, true, i64const(0n));
  module.addGlobal(SCG, i64, true, i64const(0n));

  const addToGlobal = (g: string, v: number): number => module.global.set(g, module.i64.add(module.global.get(g, i64), v));

  const wrapFunction = (k: number, name: string, innerName: string, params: number, results: number): void => {
    const cG = `__tprof_c_${k}`;
    const sG = `__tprof_s_${k}`;
    const iG = `__tprof_i_${k}`;
    const ccG = `__tprof_cc_${k}`;
    const iscG = `__tprof_isc_${k}`; // subtree calls under outermost frames (corrects incl)
    const dG = `__tprof_d_${k}`;
    for (const g of [cG, sG, iG, ccG, iscG]) {
      module.addGlobal(g, i64, true, i64const(0n));
      module.addGlobalExport(g, g);
    }
    module.addGlobal(dG, i32, true, module.i32.const(0));

    const paramTypes = binaryen.expandType(params);
    const P = paramTypes.length;
    const hasResult = results !== binaryen.none;
    // locals: T0 doubles as t0 then dur; SAVED*/RES carry per-frame state
    const T0 = P;
    const SAVED = P + 1;
    const SAVEDCC = P + 2;
    const SAVEDSC = P + 3;
    const RES = P + 4;
    const vars: number[] = [i64, i64, i64, i64];
    if (hasResult) vars.push(results);
    const dur = (): number => module.local.get(T0, i64);

    const callInner = module.call(
      innerName,
      paramTypes.map((t, j) => module.local.get(j, t)),
      results,
    );
    const body: number[] = [
      module.local.set(T0, module.call(NOW, [], i64)),
      module.local.set(SAVED, module.global.get(CHILD, i64)),
      module.local.set(SAVEDCC, module.global.get(CCG, i64)),
      module.local.set(SAVEDSC, module.global.get(SCG, i64)),
      module.global.set(CHILD, i64const(0n)),
      module.global.set(CCG, i64const(0n)),
      module.global.set(SCG, i64const(0n)),
      addToGlobal(cG, i64const(1n)),
      module.global.set(dG, module.i32.add(module.global.get(dG, i32), module.i32.const(1))),
      hasResult ? module.local.set(RES, callInner) : callInner,
      module.local.set(T0, module.i64.sub(module.call(NOW, [], i64), module.local.get(T0, i64))), // T0 := dur
      addToGlobal(sG, module.i64.sub(dur(), module.global.get(CHILD, i64))),
      addToGlobal(ccG, module.global.get(CCG, i64)),
      module.global.set(dG, module.i32.sub(module.global.get(dG, i32), module.i32.const(1))),
      // outermost frame: bank inclusive time and the subtree call count
      // (scg + 1 = descendants + me) that corrects it at render time
      module.if(module.i32.eqz(module.global.get(dG, i32)), module.block(null, [addToGlobal(iG, dur()), addToGlobal(iscG, module.i64.add(module.global.get(SCG, i64), i64const(1n)))])),
      module.global.set(CHILD, module.i64.add(module.local.get(SAVED, i64), dur())),
      module.global.set(CCG, module.i64.add(module.local.get(SAVEDCC, i64), i64const(1n))),
      module.global.set(SCG, module.i64.add(module.local.get(SAVEDSC, i64), module.i64.add(module.global.get(SCG, i64), i64const(1n)))),
    ];
    if (hasResult) body.push(module.local.get(RES, results));
    module.addFunction(name, params, results, vars, module.block(null, body, hasResult ? results : binaryen.none));
  };

  // collect first — adding/removing functions invalidates index iteration
  interface Target {
    name: string;
    params: number;
    results: number;
    vars: number[];
    body: number;
  }
  const targets: Target[] = [];
  let skipped = 0;
  const numFns = raw._BinaryenGetNumFunctions(modPtr);
  for (let i = 0; i < numFns; i++) {
    const info = binaryen.getFunctionInfo(raw._BinaryenGetFunctionByIndex(modPtr, i));
    if (!info.body) continue; // imported
    if (binaryen.expandType(info.results).length > 1) continue; // multivalue: can't forward through one RES local
    if (weigh(info.body) < minWeight) {
      skipped++;
      continue;
    }
    targets.push({ name: info.name, params: info.params, results: info.results, vars: info.vars, body: info.body });
  }

  const functions: ProfiledFunction[] = [];
  for (const t of targets) {
    const k = functions.length;
    functions.push({ k, name: t.name });
    const innerName = `${t.name}$tprof_inner`;
    // move the body (expressions are module-arena-owned; the remove/re-add
    // under the same name keeps exports, element segments, and direct calls
    // pointing at the wrapper)
    module.addFunction(innerName, t.params, t.results, t.vars, t.body);
    module.removeFunction(t.name);
    wrapFunction(k, t.name, innerName, t.params, t.results);
  }

  // calibration: empty wrapped function + in-wasm driver returning elapsed ns
  const calibK = functions.length;
  module.addFunction("__tprof_calib$tprof_inner", binaryen.none, binaryen.none, [], module.nop());
  wrapFunction(calibK, "__tprof_calib", "__tprof_calib$tprof_inner", binaryen.none, binaryen.none);
  module.addFunctionExport("__tprof_calib", "__tprof_calib");
  {
    const T0 = 1; // param n = 0
    const I = 2;
    const body = module.block(null, [module.local.set(T0, module.call(NOW, [], i64)), module.block("tprof_out", [module.loop("tprof_loop", module.block(null, [module.br("tprof_out", module.i32.ge_u(module.local.get(I, i32), module.local.get(0, i32))), module.call("__tprof_calib", [], binaryen.none), module.local.set(I, module.i32.add(module.local.get(I, i32), module.i32.const(1))), module.br("tprof_loop")]))]), module.i64.sub(module.call(NOW, [], i64), module.local.get(T0, i64))], i64);
    module.addFunction("__tprof_calib_run", binaryen.createType([i32]), i64, [i64, i32], body);
    module.addFunctionExport("__tprof_calib_run", "__tprof_calib_run");
  }

  if (!module.validate()) {
    throw new Error("time-instrumented module failed binaryen validation");
  }
  const wasm = module.emitBinary();
  module.dispose();
  return { wasm, functions, calibK, skipped };
}

export interface InstrumentAllocResult {
  wasm: Uint8Array;
  functions: ProfiledFunction[];
  /** False when the module contains no AS runtime allocator (nothing in it can allocate). */
  hasAllocator: boolean;
}

// Allocation pass for `asb profile --heaviest=alloc`.
//
// The AS runtime's `~lib/rt/*/__new(size, id)` gets a prelude bumping two
// shared monotone globals — `__aprof_b` (bytes requested) and `__aprof_a`
// (allocation count). Every other user-level function is then outlined with
// the same move-body wrapper as the time pass, but reading those globals
// instead of a clock: the identical save/zero/restore algebra attributes
// exact self bytes (own frame minus wrapped callees) and outermost-gated
// inclusive bytes. Unlike =time this is overhead-free measurement — the
// wrapper can't distort a byte counter — so results are exact and
// deterministic, need no calibration, and wrap everything regardless of
// size.
//
// `~lib/rt/*` itself is never wrapped: the allocator's bumps must land in
// the frame of whoever asked for the memory, and runtime helpers
// (__newArray etc.) should charge their user-level caller, not themselves.
// Measures allocation pressure (bytes requested from __new, headers
// excluded), not live or peak memory — GC frees don't subtract.
export async function instrumentAllocWasm(input: Uint8Array): Promise<InstrumentAllocResult> {
  const binaryen = await loadBinaryen();
  const module = binaryen.readBinary(input);
  module.setFeatures(binaryen.Features.All);

  const raw = binaryen as unknown as {
    _BinaryenGetNumFunctions(mod: number): number;
    _BinaryenGetFunctionByIndex(mod: number, i: number): number;
    _BinaryenFunctionSetBody(fn: number, body: number): void;
  };
  const modPtr = (module as unknown as { ptr: number }).ptr;

  const i64 = binaryen.i64;
  const i32 = binaryen.i32;
  const i64const = (v: bigint): number => (module.i64.const as unknown as (v: bigint) => number)(v);

  const BYTES = "__aprof_b";
  const ALLOCS = "__aprof_a";
  const CHILDB = "__aprof_childb";
  const CHILDA = "__aprof_childa";
  for (const g of [BYTES, ALLOCS, CHILDB, CHILDA]) module.addGlobal(g, i64, true, i64const(0n));

  const addToGlobal = (g: string, v: number): number => module.global.set(g, module.i64.add(module.global.get(g, i64), v));

  const wrapFunction = (k: number, name: string, innerName: string, params: number, results: number): void => {
    const cG = `__aprof_c_${k}`;
    const sbG = `__aprof_sb_${k}`;
    const ibG = `__aprof_ib_${k}`;
    const saG = `__aprof_sa_${k}`;
    const dG = `__aprof_d_${k}`;
    for (const g of [cG, sbG, ibG, saG]) {
      module.addGlobal(g, i64, true, i64const(0n));
      module.addGlobalExport(g, g);
    }
    module.addGlobal(dG, i32, true, module.i32.const(0));

    const paramTypes = binaryen.expandType(params);
    const P = paramTypes.length;
    const hasResult = results !== binaryen.none;
    // locals: B0/A0 double as entry snapshots then frame deltas
    const B0 = P;
    const SAVEDB = P + 1;
    const A0 = P + 2;
    const SAVEDA = P + 3;
    const RES = P + 4;
    const vars: number[] = [i64, i64, i64, i64];
    if (hasResult) vars.push(results);
    const durB = (): number => module.local.get(B0, i64);
    const durA = (): number => module.local.get(A0, i64);

    const callInner = module.call(
      innerName,
      paramTypes.map((t, j) => module.local.get(j, t)),
      results,
    );
    const body: number[] = [
      module.local.set(B0, module.global.get(BYTES, i64)),
      module.local.set(SAVEDB, module.global.get(CHILDB, i64)),
      module.local.set(A0, module.global.get(ALLOCS, i64)),
      module.local.set(SAVEDA, module.global.get(CHILDA, i64)),
      module.global.set(CHILDB, i64const(0n)),
      module.global.set(CHILDA, i64const(0n)),
      addToGlobal(cG, i64const(1n)),
      module.global.set(dG, module.i32.add(module.global.get(dG, i32), module.i32.const(1))),
      hasResult ? module.local.set(RES, callInner) : callInner,
      module.local.set(B0, module.i64.sub(module.global.get(BYTES, i64), module.local.get(B0, i64))), // B0 := frame bytes
      module.local.set(A0, module.i64.sub(module.global.get(ALLOCS, i64), module.local.get(A0, i64))), // A0 := frame allocs
      addToGlobal(sbG, module.i64.sub(durB(), module.global.get(CHILDB, i64))),
      addToGlobal(saG, module.i64.sub(durA(), module.global.get(CHILDA, i64))),
      module.global.set(dG, module.i32.sub(module.global.get(dG, i32), module.i32.const(1))),
      module.if(module.i32.eqz(module.global.get(dG, i32)), addToGlobal(ibG, durB())),
      module.global.set(CHILDB, module.i64.add(module.local.get(SAVEDB, i64), durB())),
      module.global.set(CHILDA, module.i64.add(module.local.get(SAVEDA, i64), durA())),
    ];
    if (hasResult) body.push(module.local.get(RES, results));
    module.addFunction(name, params, results, vars, module.block(null, body, hasResult ? results : binaryen.none));
  };

  // collect first — adding/removing functions invalidates index iteration
  interface Target {
    name: string;
    params: number;
    results: number;
    vars: number[];
    body: number;
  }
  const targets: Target[] = [];
  const allocators: { ref: number; body: number }[] = [];
  const numFns = raw._BinaryenGetNumFunctions(modPtr);
  for (let i = 0; i < numFns; i++) {
    const fnRef = raw._BinaryenGetFunctionByIndex(modPtr, i);
    const info = binaryen.getFunctionInfo(fnRef);
    if (!info.body) continue; // imported
    if (/^~lib\/rt\/.*\/__new$/.test(info.name)) {
      allocators.push({ ref: fnRef, body: info.body });
      continue;
    }
    if (info.name.startsWith("~lib/rt/")) continue; // charge runtime work to its caller
    if (binaryen.expandType(info.results).length > 1) continue; // multivalue: can't forward through one RES local
    targets.push({ name: info.name, params: info.params, results: info.results, vars: info.vars, body: info.body });
  }

  // __new(size, id): bump the monotone counters with the requested size
  for (const a of allocators) {
    const prelude = [addToGlobal(BYTES, module.i64.extend_u(module.local.get(0, i32))), addToGlobal(ALLOCS, i64const(1n))];
    raw._BinaryenFunctionSetBody(a.ref, module.block(null, [...prelude, a.body], binaryen.auto));
  }

  const functions: ProfiledFunction[] = [];
  for (const t of targets) {
    const k = functions.length;
    functions.push({ k, name: t.name });
    const innerName = `${t.name}$aprof_inner`;
    module.addFunction(innerName, t.params, t.results, t.vars, t.body);
    module.removeFunction(t.name);
    wrapFunction(k, t.name, innerName, t.params, t.results);
  }

  if (!module.validate()) {
    throw new Error("alloc-instrumented module failed binaryen validation");
  }
  const wasm = module.emitBinary();
  module.dispose();
  return { wasm, functions, hasAllocator: allocators.length > 0 };
}
