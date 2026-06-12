const PAGE = 65536;
function valEq(a, b) {
    if (typeof a !== typeof b)
        return false;
    return typeof a === "bigint" ? a === b : Object.is(a, b);
}
function snapshot(mem) {
    return new Uint8Array(mem.buffer).slice();
}
function diff(mem, before) {
    const after = new Uint8Array(mem.buffer);
    const diffs = [];
    const pages = Math.ceil(after.length / PAGE);
    for (let p = 0; p < pages; p++) {
        const base = p * PAGE;
        const end = Math.min(base + PAGE, after.length);
        let first = -1;
        let last = -1;
        for (let i = base; i < end; i++) {
            const b = i < before.length ? before[i] : 0;
            if (after[i] !== b) {
                if (first < 0)
                    first = i;
                last = i;
            }
        }
        if (first >= 0)
            diffs.push({ offset: first, bytes: after.slice(first, last + 1) });
    }
    return diffs;
}
function applyDiffs(mem, diffs) {
    let need = 0;
    for (const d of diffs) {
        const end = d.offset + d.bytes.length;
        if (end > need)
            need = end;
    }
    const have = mem.buffer.byteLength;
    if (need > have)
        mem.grow(Math.ceil((need - have) / PAGE));
    const u8 = new Uint8Array(mem.buffer);
    for (const d of diffs)
        u8.set(d.bytes, d.offset);
}
export class DeterministicHarness {
    getMem;
    mode = "live";
    iterCount = 0;
    tape = [];
    cursor = 0;
    constructor(getMem) {
        this.getMem = getMem;
    }
    iter() {
        this.iterCount++;
        if (this.iterCount === 1) {
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
        if (this.cursor !== this.tape.length) {
            throw new Error(`as-bench deterministic: iteration consumed ${this.cursor}/${this.tape.length} recorded host calls — call pattern varies between iterations`);
        }
        this.cursor = 0;
    }
    reset() {
        this.mode = "live";
        this.iterCount = 0;
        this.tape = [];
        this.cursor = 0;
    }
    wrap(qualifiedName, real, thisArg) {
        return (...args) => {
            if (this.mode === "live") {
                return real.apply(thisArg, args);
            }
            if (this.mode === "record") {
                const before = snapshot(this.getMem());
                const ret = real.apply(thisArg, args);
                this.tape.push({ name: qualifiedName, args, ret, diffs: diff(this.getMem(), before) });
                return ret;
            }
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
    wrapNamespace(ns, imports) {
        const out = {};
        for (const name of Object.keys(imports)) {
            const v = imports[name];
            out[name] = typeof v === "function" ? this.wrap(`${ns}.${name}`, v, imports) : v;
        }
        return out;
    }
}
