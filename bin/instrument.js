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
async function loadBinaryen() {
  let resolved;
  try {
    const ascPkg = require.resolve("assemblyscript/package.json", { paths: [process.cwd(), import.meta.dirname ?? "."] });
    resolved = require.resolve("binaryen", { paths: [path.dirname(ascPkg)] });
  } catch {
    resolved = require.resolve("binaryen");
  }
  const mod = await import(resolved);
  return mod.default ?? mod;
}
export async function instrumentWasm(input) {
  const binaryen = await loadBinaryen();
  const module = binaryen.readBinary(input);
  module.setFeatures(binaryen.Features.All);
  // raw C-API handles (pointer-only mutation calls)
  const raw = binaryen;
  const modPtr = module.ptr;
  // structural nodes that don't lower to executed instructions
  const ZERO_WEIGHT = new Set([binaryen.BlockId, binaryen.LoopId, binaryen.NopId]);
  const childRefs = (info) => {
    if (info.id === binaryen.ConstId) return []; // `value` is a literal here
    const out = [];
    for (const key of ["children", "operands", "condition", "ifTrue", "ifFalse", "body", "value", "left", "right", "ptr", "target", "dest", "source", "size", "delta"]) {
      const v = info[key];
      if (typeof v === "number" && v !== 0) out.push(v);
      else if (Array.isArray(v)) for (const c of v) if (typeof c === "number" && c !== 0) out.push(c);
    }
    return out;
  };
  const i64 = binaryen.i64;
  // this binaryen.js takes a single bigint for i64.const
  const i64const = (v) => module.i64.const(v);
  const incr = (global, amount) => {
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
  const isFloat = (t) => t === binaryen.f32 || t === binaryen.f64;
  const opSet = (ops) => new Set(ops.filter((o) => o !== undefined));
  const b = binaryen;
  const INT_DIV_OPS = opSet([b.DivSInt32, b.DivUInt32, b.RemSInt32, b.RemUInt32, b.DivSInt64, b.DivUInt64, b.RemSInt64, b.RemUInt64]);
  const FLOAT_DIV_OPS = opSet([b.DivFloat32, b.DivFloat64]);
  const INT_MUL_OPS = opSet([b.MulInt32, b.MulInt64]);
  const SQRT_OPS = opSet([b.SqrtFloat32, b.SqrtFloat64]);
  const TRUNC_OPS = opSet([b.TruncSFloat32ToInt32, b.TruncUFloat32ToInt32, b.TruncSFloat64ToInt32, b.TruncUFloat64ToInt32, b.TruncSFloat32ToInt64, b.TruncUFloat32ToInt64, b.TruncSFloat64ToInt64, b.TruncUFloat64ToInt64, b.TruncSatSFloat32ToInt32, b.TruncSatUFloat32ToInt32, b.TruncSatSFloat64ToInt32, b.TruncSatUFloat64ToInt32, b.TruncSatSFloat32ToInt64, b.TruncSatUFloat32ToInt64, b.TruncSatSFloat64ToInt64, b.TruncSatUFloat64ToInt64]);
  const ATOMIC_IDS = opSet([b.AtomicRMWId, b.AtomicCmpxchgId, b.AtomicWaitId, b.AtomicNotifyId, b.AtomicFenceId]);
  const costOf = (x) => {
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
        const op = x.op;
        if (INT_DIV_OPS.has(op)) return 15;
        if (FLOAT_DIV_OPS.has(op)) return 12;
        if (INT_MUL_OPS.has(op)) return 3;
        // float arithmetic — compares yield i32, so peek the left operand
        if (isFloat(x.type)) return 2;
        const left = x.left;
        if (left && raw._BinaryenExpressionGetId(left) !== binaryen.UnreachableId && isFloat(binaryen.getExpressionInfo(left).type)) return 2;
        return 1;
      }
      case binaryen.UnaryId: {
        const op = x.op;
        if (SQRT_OPS.has(op)) return 12;
        if (TRUNC_OPS.has(op)) return 3;
        if (isFloat(x.type)) return 2;
        return 1;
      }
      default:
        if (ATOMIC_IDS.has(x.id)) return 10;
        return ZERO_WEIGHT.has(x.id) ? 0 : 1;
    }
  };
  const functions = [];
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
    const walk = (ref) => {
      // this binaryen.js nightly's getExpressionInfo throws on `unreachable`;
      // it's a childless 1-instruction leaf either way
      if (raw._BinaryenExpressionGetId(ref) === binaryen.UnreachableId) return [1, 1];
      const x = binaryen.getExpressionInfo(ref);
      let n = ZERO_WEIGHT.has(x.id) ? 0 : 1;
      let w = costOf(x);
      if (x.id === binaryen.IfId) {
        const ifInfo = x;
        const [cn, cw] = walk(ifInfo.condition);
        n += cn;
        w += cw;
        wrapRegion(ifInfo.ifTrue, (b2) => raw._BinaryenIfSetIfTrue(ref, b2));
        if (ifInfo.ifFalse) wrapRegion(ifInfo.ifFalse, (b2) => raw._BinaryenIfSetIfFalse(ref, b2));
      } else if (x.id === binaryen.LoopId) {
        const loopInfo = x;
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
    const wrapRegion = (regionRef, replace) => {
      const [n, w] = walk(regionRef);
      if (n === 0) return;
      replace(module.block(null, [incr(nGlobal, n), incr(wGlobal, w), regionRef], binaryen.auto));
    };
    const [bodyCount, bodyCost] = walk(info.body);
    const prelude = [incr(cGlobal, 1)];
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
export async function instrumentTimeWasm(input, minWeight) {
  const binaryen = await loadBinaryen();
  const module = binaryen.readBinary(input);
  module.setFeatures(binaryen.Features.All);
  const raw = binaryen;
  const modPtr = module.ptr;
  const ZERO_WEIGHT = new Set([binaryen.BlockId, binaryen.LoopId, binaryen.NopId]);
  const childRefs = (info) => {
    if (info.id === binaryen.ConstId) return [];
    const out = [];
    for (const key of ["children", "operands", "condition", "ifTrue", "ifFalse", "body", "value", "left", "right", "ptr", "target", "dest", "source", "size", "delta"]) {
      const v = info[key];
      if (typeof v === "number" && v !== 0) out.push(v);
      else if (Array.isArray(v)) for (const c of v) if (typeof c === "number" && c !== 0) out.push(c);
    }
    return out;
  };
  // total static weight of a body — same node≈instruction model as the
  // instr pass, but flat (regions don't matter here)
  const weigh = (ref) => {
    if (raw._BinaryenExpressionGetId(ref) === binaryen.UnreachableId) return 1;
    const x = binaryen.getExpressionInfo(ref);
    let w = ZERO_WEIGHT.has(x.id) ? 0 : 1;
    for (const child of childRefs(x)) w += weigh(child);
    return w;
  };
  const i64 = binaryen.i64;
  const i32 = binaryen.i32;
  const i64const = (v) => module.i64.const(v);
  const NOW = "__tprof_now";
  const CHILD = "__tprof_child";
  const CCG = "__tprof_ccg";
  const SCG = "__tprof_scg"; // wrapped calls in the current frame's subtree
  module.addFunctionImport(NOW, "__asbench", "tnow", binaryen.none, i64);
  module.addGlobal(CHILD, i64, true, i64const(0n));
  module.addGlobal(CCG, i64, true, i64const(0n));
  module.addGlobal(SCG, i64, true, i64const(0n));
  const addToGlobal = (g, v) => module.global.set(g, module.i64.add(module.global.get(g, i64), v));
  const wrapFunction = (k, name, innerName, params, results) => {
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
    const vars = [i64, i64, i64, i64];
    if (hasResult) vars.push(results);
    const dur = () => module.local.get(T0, i64);
    const callInner = module.call(
      innerName,
      paramTypes.map((t, j) => module.local.get(j, t)),
      results,
    );
    const body = [
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
  const targets = [];
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
  const functions = [];
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
// Allocation pass for `asb profile --heaviest=alloc`.
//
// The runtime's allocation chokepoint gets a prelude bumping two shared
// monotone globals — `__aprof_b` (bytes claimed) and `__aprof_a` (allocation
// count). Every user-level function is then outlined with the same move-body
// wrapper as the time pass, but reading those globals instead of a clock:
// the identical save/zero/restore algebra attributes exact self bytes (own
// frame minus wrapped callees) and outermost-gated inclusive bytes. Unlike
// =time this is overhead-free measurement — the wrapper can't distort a
// byte counter — so results are exact and deterministic, need no
// calibration, and wrap everything regardless of size.
//
// Chokepoint selection: managed `__new` and unmanaged `__alloc` (heap.alloc)
// both funnel into tlsf's `allocateBlock`, and asc -O inlines `__alloc` out
// of existence — so instrument the DEEPEST layer that survives, and only
// one layer, or managed allocations double-count. allocateBlock also
// catches realloc/renew moves; in-place realloc growth claims no new block
// and counts zero (the per-bench page report still shows real memory
// growth). Sizes at allocateBlock include the 16-byte managed-object
// header; heap.alloc sizes are exact as requested.
//
// `~lib/rt/*` itself is never wrapped: the allocator's bumps must land in
// the frame of whoever asked for the memory, and runtime helpers
// (__newArray etc.) should charge their user-level caller, not themselves.
// Measures allocation pressure, not live or peak memory — GC frees don't
// subtract.
export async function instrumentAllocWasm(input) {
  const binaryen = await loadBinaryen();
  const module = binaryen.readBinary(input);
  module.setFeatures(binaryen.Features.All);
  const raw = binaryen;
  const modPtr = module.ptr;
  const i64 = binaryen.i64;
  const i32 = binaryen.i32;
  const i64const = (v) => module.i64.const(v);
  const BYTES = "__aprof_b"; // all bytes claimed (chokepoint)
  const ALLOCS = "__aprof_a";
  const MBYTES = "__aprof_mb"; // managed payload bytes (__new sizes, headers excluded)
  const MALLOCS = "__aprof_ma";
  const RBYTES = "__aprof_rb"; // realloc requested bytes (tlsf reallocateBlock)
  const RCOUNT = "__aprof_rc";
  const CHILDB = "__aprof_childb";
  const CHILDA = "__aprof_childa";
  const CHILDP = "__aprof_childp"; // pages grown in wrapped-child frames
  for (const g of [BYTES, ALLOCS, MBYTES, MALLOCS, RBYTES, RCOUNT, CHILDB, CHILDA, CHILDP]) {
    module.addGlobal(g, i64, true, i64const(0n));
  }
  // bench-level kind summary reads these directly
  for (const g of [BYTES, ALLOCS, MBYTES, MALLOCS, RBYTES, RCOUNT]) module.addGlobalExport(g, g);
  const addToGlobal = (g, v) => module.global.set(g, module.i64.add(module.global.get(g, i64), v));
  // pages: memory.size is itself a monotone counter (memory never shrinks),
  // so page growth gets the same frame algebra as bytes with no grow-site
  // instrumentation at all — GC- or allocator-triggered memory.grow lands in
  // whichever wrapped frame was live
  const memPages = () => module.i64.extend_u(module.memory.size());
  const wrapFunction = (k, name, innerName, params, results) => {
    const cG = `__aprof_c_${k}`;
    const sbG = `__aprof_sb_${k}`;
    const ibG = `__aprof_ib_${k}`;
    const saG = `__aprof_sa_${k}`;
    const spG = `__aprof_sp_${k}`;
    const dG = `__aprof_d_${k}`;
    for (const g of [cG, sbG, ibG, saG, spG]) {
      module.addGlobal(g, i64, true, i64const(0n));
      module.addGlobalExport(g, g);
    }
    module.addGlobal(dG, i32, true, module.i32.const(0));
    const paramTypes = binaryen.expandType(params);
    const P = paramTypes.length;
    const hasResult = results !== binaryen.none;
    // locals: B0/A0/P0 double as entry snapshots then frame deltas
    const B0 = P;
    const SAVEDB = P + 1;
    const A0 = P + 2;
    const SAVEDA = P + 3;
    const P0 = P + 4;
    const SAVEDP = P + 5;
    const RES = P + 6;
    const vars = [i64, i64, i64, i64, i64, i64];
    if (hasResult) vars.push(results);
    const durB = () => module.local.get(B0, i64);
    const durA = () => module.local.get(A0, i64);
    const durP = () => module.local.get(P0, i64);
    const callInner = module.call(
      innerName,
      paramTypes.map((t, j) => module.local.get(j, t)),
      results,
    );
    const body = [
      module.local.set(B0, module.global.get(BYTES, i64)),
      module.local.set(SAVEDB, module.global.get(CHILDB, i64)),
      module.local.set(A0, module.global.get(ALLOCS, i64)),
      module.local.set(SAVEDA, module.global.get(CHILDA, i64)),
      module.local.set(P0, memPages()),
      module.local.set(SAVEDP, module.global.get(CHILDP, i64)),
      module.global.set(CHILDB, i64const(0n)),
      module.global.set(CHILDA, i64const(0n)),
      module.global.set(CHILDP, i64const(0n)),
      addToGlobal(cG, i64const(1n)),
      module.global.set(dG, module.i32.add(module.global.get(dG, i32), module.i32.const(1))),
      hasResult ? module.local.set(RES, callInner) : callInner,
      module.local.set(B0, module.i64.sub(module.global.get(BYTES, i64), module.local.get(B0, i64))), // B0 := frame bytes
      module.local.set(A0, module.i64.sub(module.global.get(ALLOCS, i64), module.local.get(A0, i64))), // A0 := frame allocs
      module.local.set(P0, module.i64.sub(memPages(), module.local.get(P0, i64))), // P0 := frame pages grown
      addToGlobal(sbG, module.i64.sub(durB(), module.global.get(CHILDB, i64))),
      addToGlobal(saG, module.i64.sub(durA(), module.global.get(CHILDA, i64))),
      addToGlobal(spG, module.i64.sub(durP(), module.global.get(CHILDP, i64))),
      module.global.set(dG, module.i32.sub(module.global.get(dG, i32), module.i32.const(1))),
      module.if(module.i32.eqz(module.global.get(dG, i32)), addToGlobal(ibG, durB())),
      module.global.set(CHILDB, module.i64.add(module.local.get(SAVEDB, i64), durB())),
      module.global.set(CHILDA, module.i64.add(module.local.get(SAVEDA, i64), durA())),
      module.global.set(CHILDP, module.i64.add(module.local.get(SAVEDP, i64), durP())),
    ];
    if (hasResult) body.push(module.local.get(RES, results));
    module.addFunction(name, params, results, vars, module.block(null, body, hasResult ? results : binaryen.none));
  };
  // deepest-first chokepoint candidates; exactly one layer gets instrumented
  const CHOKEPOINTS = [
    { re: /^~lib\/rt\/tlsf\/allocateBlock$/, sizeParam: 1 }, // (root, size)
    { re: /^~lib\/rt\/(tlsf|stub)\/__alloc$/, sizeParam: 0 }, // (size)
    { re: /^~lib\/rt\/(itcms|stub|tlsf)\/__new$/, sizeParam: 0 }, // (size, id)
  ];
  const targets = [];
  const candidates = [];
  // managed split (__new sees the payload size pre-header) and realloc
  // requests (tlsf reallocateBlock covers in-place growth AND moves; its
  // moves allocate through the chokepoint, so these counters stay separate
  // from the claimed-bytes total — adding them in would double-count)
  const extras = [];
  const reallocCandidates = [];
  const numFns = raw._BinaryenGetNumFunctions(modPtr);
  for (let i = 0; i < numFns; i++) {
    const fnRef = raw._BinaryenGetFunctionByIndex(modPtr, i);
    const info = binaryen.getFunctionInfo(fnRef);
    if (!info.body) continue; // imported
    const level = CHOKEPOINTS.findIndex((c) => c.re.test(info.name));
    if (level >= 0) candidates.push({ ref: fnRef, body: info.body, level, sizeParam: CHOKEPOINTS[level].sizeParam });
    if (/^~lib\/rt\/(itcms|stub|tlsf)\/__new$/.test(info.name)) extras.push({ ref: fnRef, body: info.body, sizeParam: 0, bytesG: MBYTES, countG: MALLOCS });
    // realloc requests: reallocateBlock sees every request (in-place + move)
    // but inlines away under -O (single caller); moveBlock survives and
    // catches moves — never both, or moves double-count
    if (/^~lib\/rt\/tlsf\/(reallocateBlock|moveBlock)$/.test(info.name)) {
      reallocCandidates.push({ ref: fnRef, body: info.body, outer: info.name.endsWith("reallocateBlock") });
    }
    if (info.name.startsWith("~lib/rt/")) continue; // charge runtime work to its caller
    if (binaryen.expandType(info.results).length > 1) continue; // multivalue: can't forward through one RES local
    targets.push({ name: info.name, params: info.params, results: info.results, vars: info.vars, body: info.body });
  }
  // bump the monotone counters with the claimed size at the deepest layer
  // present; a function carrying both a chokepoint and an extra counter
  // (e.g. __new as the fallback chokepoint) gets both preludes fused
  const best = candidates.length > 0 ? Math.min(...candidates.map((c) => c.level)) : -1;
  const preludes = new Map();
  const addPrelude = (ref, body, sizeParam, bytesG, countG) => {
    const entry = preludes.get(ref) ?? { body, stmts: [] };
    entry.stmts.push(addToGlobal(bytesG, module.i64.extend_u(module.local.get(sizeParam, i32))), addToGlobal(countG, i64const(1n)));
    preludes.set(ref, entry);
  };
  for (const a of candidates) if (a.level === best) addPrelude(a.ref, a.body, a.sizeParam, BYTES, ALLOCS);
  const haveOuterRealloc = reallocCandidates.some((r) => r.outer);
  for (const r of reallocCandidates) {
    if (r.outer === haveOuterRealloc) extras.push({ ref: r.ref, body: r.body, sizeParam: 2, bytesG: RBYTES, countG: RCOUNT });
  }
  for (const e of extras) addPrelude(e.ref, e.body, e.sizeParam, e.bytesG, e.countG);
  for (const [ref, p] of preludes) {
    raw._BinaryenFunctionSetBody(ref, module.block(null, [...p.stmts, p.body], binaryen.auto));
  }
  const functions = [];
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
  return { wasm, functions, hasAllocator: candidates.length > 0 };
}
