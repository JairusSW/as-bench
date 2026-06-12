// Deterministic-mode record/replay harness. Core approach ported from the
// playground replay system (host-side memory snapshot/diff around wrapped
// imports, divergence verification, the wasm binary never instrumented),
// adapted for the benchmark hot loop:
//
//  - It runs IN-PROCESS, mid-measurement, instead of as a separate record
//    phase: the engine announces every routine invocation via the `iter()`
//    import, and the harness keeps iteration 1 live (lazy one-time inits —
//    Math.random seeding, first allocations — fire for real), RECORDS
//    iteration 2 (the steady-state call pattern), then REPLAYS iteration 3+
//    from the in-memory tape. Same process ⇒ same memory layout, which is
//    what makes recorded memory-diff offsets valid during replay.
//  - Every replayed iteration is verified: same import order, same args
//    (tagged number/bigint equality), and full tape consumption at the next
//    iter() boundary. Any drift throws with the exact call index — a routine
//    that allocates fresh buffers per iteration fails loudly on the pointer
//    arg, which is the correct message ("pre-allocate state in deterministic
//    mode"), not silent corruption.
//  - Calls OUTSIDE bench windows (registration, between benches) pass
//    through live; reset() re-arms the harness for the next bench.
//
// Known semantics: a side-effectful import (e.g. fd_write from console.log
// inside the routine) executes for real once — live iter + record iter — and
// is served from the tape afterwards.

const PAGE = 65536;

interface MemDiff {
  offset: number;
  bytes: Uint8Array;
}

interface RecordedCall {
  name: string; // "namespace.import"
  args: (number | bigint)[];
  ret: number | bigint | undefined;
  diffs: MemDiff[];
}

function valEq(a: number | bigint, b: number | bigint): boolean {
  if (typeof a !== typeof b) return false;
  return typeof a === "bigint" ? a === b : Object.is(a, b);
}

/** Full-buffer copy; one live at a time, only during the record iteration. */
function snapshot(mem: WebAssembly.Memory): Uint8Array {
  return new Uint8Array(mem.buffer).slice();
}

/** Per-page contiguous changed-run capture (over-captures within a page; correct, just fatter). */
function diff(mem: WebAssembly.Memory, before: Uint8Array): MemDiff[] {
  const after = new Uint8Array(mem.buffer);
  const diffs: MemDiff[] = [];
  const pages = Math.ceil(after.length / PAGE);
  for (let p = 0; p < pages; p++) {
    const base = p * PAGE;
    const end = Math.min(base + PAGE, after.length);
    let first = -1;
    let last = -1;
    for (let i = base; i < end; i++) {
      const b = i < before.length ? before[i] : 0;
      if (after[i] !== b) {
        if (first < 0) first = i;
        last = i;
      }
    }
    if (first >= 0) diffs.push({ offset: first, bytes: after.slice(first, last + 1) });
  }
  return diffs;
}

/** Blit recorded writes back, growing memory first if a recorded grow demands it. */
function applyDiffs(mem: WebAssembly.Memory, diffs: MemDiff[]): void {
  let need = 0;
  for (const d of diffs) {
    const end = d.offset + d.bytes.length;
    if (end > need) need = end;
  }
  const have = mem.buffer.byteLength;
  if (need > have) mem.grow(Math.ceil((need - have) / PAGE));
  const u8 = new Uint8Array(mem.buffer); // re-derive AFTER any grow
  for (const d of diffs) u8.set(d.bytes, d.offset);
}

type Mode = "live" | "record" | "replay";

export class DeterministicHarness {
  private mode: Mode = "live";
  private iterCount = 0;
  private tape: RecordedCall[] = [];
  private cursor = 0;

  constructor(private getMem: () => WebAssembly.Memory) {}

  /** Engine signal: a routine invocation is about to start. */
  iter(): void {
    this.iterCount++;
    if (this.iterCount === 1) {
      // live: let lazy one-time inits (seeding, first allocs) happen for real
      return;
    }
    if (this.iterCount === 2) {
      this.mode = "record";
      this.tape = [];
      return;
    }
    if (this.iterCount === 3) {
      this.mode = "replay";
      this.cursor = 0;
      return;
    }
    // replay → replay boundary: previous iteration must have consumed the
    // whole tape, then rewind
    if (this.cursor !== this.tape.length) {
      throw new Error(`as-bench deterministic: iteration consumed ${this.cursor}/${this.tape.length} recorded host calls — call pattern varies between iterations`);
    }
    this.cursor = 0;
  }

  /** Bench window ended — back to live passthrough until the next bench. */
  reset(): void {
    this.mode = "live";
    this.iterCount = 0;
    this.tape = [];
    this.cursor = 0;
  }

  /** Wrap one function import for record/replay. */
  wrap(qualifiedName: string, real: (...args: never[]) => unknown, thisArg: unknown): (...args: (number | bigint)[]) => unknown {
    return (...args: (number | bigint)[]) => {
      if (this.mode === "live") {
        return (real as (...a: (number | bigint)[]) => unknown).apply(thisArg, args);
      }
      if (this.mode === "record") {
        const before = snapshot(this.getMem());
        const ret = (real as (...a: (number | bigint)[]) => unknown).apply(thisArg, args) as number | bigint | undefined;
        this.tape.push({ name: qualifiedName, args, ret, diffs: diff(this.getMem(), before) });
        return ret;
      }
      // replay
      const call = this.tape[this.cursor];
      if (!call) {
        throw new Error(`as-bench deterministic: ${qualifiedName} called but the tape is exhausted (${this.tape.length} calls/iteration recorded)`);
      }
      if (call.name !== qualifiedName) {
        throw new Error(`as-bench deterministic: divergence at call ${this.cursor} — wasm called ${qualifiedName}, tape expected ${call.name}`);
      }
      if (call.args.length !== args.length) {
        throw new Error(`as-bench deterministic: ${qualifiedName} arg count diverged at call ${this.cursor} (${args.length} vs ${call.args.length})`);
      }
      for (let i = 0; i < args.length; i++) {
        if (!valEq(call.args[i], args[i])) {
          throw new Error(`as-bench deterministic: ${qualifiedName} arg[${i}] diverged at call ${this.cursor} — ${String(args[i])} vs recorded ${String(call.args[i])} (routine state not iteration-stable?)`);
        }
      }
      this.cursor++;
      applyDiffs(this.getMem(), call.diffs);
      return call.ret;
    };
  }

  /** Wrap every function import in a namespace; non-functions pass through. */
  wrapNamespace(ns: string, imports: WebAssembly.ModuleImports): WebAssembly.ModuleImports {
    const out: WebAssembly.ModuleImports = {};
    for (const name of Object.keys(imports)) {
      const v = imports[name];
      out[name] = typeof v === "function" ? (this.wrap(`${ns}.${name}`, v as (...args: never[]) => unknown, imports) as WebAssembly.ImportValue) : v;
    }
    return out;
  }
}
