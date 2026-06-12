// Binaryen instrumentation pass for `asb profile --heaviest=instr`.
//
// Injects two mutable i64 globals per defined function — `__prof_c_<k>`
// (entry count) and `__prof_n_<k>` (executed-instruction count) — both
// exported so the host can snapshot/diff them around each bench.
//
// Counting model: every binaryen IR node ≈ one wasm instruction (structural
// nodes — block, loop, nop — count as zero). Increments are inserted at
// region granularity: function entry, each loop body, and each if-arm get
// `__prof_n += <static weight of the region>` where a region's weight
// excludes nested regions (they count themselves). Known imprecision: an
// early `br`/`return` out of a region still pays the region's full weight —
// fine for ranking, documented as "approximate".
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
    module.addGlobal(cGlobal, i64, true, i64const(0n));
    module.addGlobal(nGlobal, i64, true, i64const(0n));
    module.addGlobalExport(cGlobal, cGlobal);
    module.addGlobalExport(nGlobal, nGlobal);
    // Walk the body counting the current region's weight; loop bodies and
    // if-arms start their own regions (instrumented inside the recursion).
    const walk = (ref) => {
      // this binaryen.js nightly's getExpressionInfo throws on `unreachable`;
      // it's a childless 1-instruction leaf either way
      if (raw._BinaryenExpressionGetId(ref) === binaryen.UnreachableId) return 1;
      const x = binaryen.getExpressionInfo(ref);
      let w = ZERO_WEIGHT.has(x.id) ? 0 : 1;
      if (x.id === binaryen.IfId) {
        const ifInfo = x;
        w += walk(ifInfo.condition);
        wrapRegion(ifInfo.ifTrue, (b) => raw._BinaryenIfSetIfTrue(ref, b));
        if (ifInfo.ifFalse) wrapRegion(ifInfo.ifFalse, (b) => raw._BinaryenIfSetIfFalse(ref, b));
      } else if (x.id === binaryen.LoopId) {
        const loopInfo = x;
        wrapRegion(loopInfo.body, (b) => raw._BinaryenLoopSetBody(ref, b));
      } else {
        for (const child of childRefs(x)) w += walk(child);
      }
      return w;
    };
    const wrapRegion = (regionRef, replace) => {
      const w = walk(regionRef);
      if (w === 0) return;
      replace(module.block(null, [incr(nGlobal, w), regionRef], binaryen.auto));
    };
    const bodyWeight = walk(info.body);
    const prelude = [incr(cGlobal, 1)];
    if (bodyWeight > 0) prelude.push(incr(nGlobal, bodyWeight));
    raw._BinaryenFunctionSetBody(fnRef, module.block(null, [...prelude, info.body], binaryen.auto));
  }
  if (!module.validate()) {
    throw new Error("instrumented module failed binaryen validation");
  }
  const wasm = module.emitBinary();
  module.dispose();
  return { wasm, functions };
}
