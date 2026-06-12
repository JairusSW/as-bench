const MAGIC = 0x48434241;
const HEADER_SIZE = 9;
const utf8 = new TextDecoder();
export class FrameParser {
    reporter;
    passthrough;
    buffer = new Uint8Array(0);
    suiteName = null;
    benchName = "";
    constructor(reporter, passthrough) {
        this.reporter = reporter;
        this.passthrough = passthrough;
    }
    key() {
        return this.suiteName !== null ? `${this.suiteName}/${this.benchName}` : this.benchName;
    }
    push(chunk) {
        if (this.buffer.length === 0) {
            this.buffer = chunk;
        }
        else {
            const merged = new Uint8Array(this.buffer.length + chunk.length);
            merged.set(this.buffer);
            merged.set(chunk, this.buffer.length);
            this.buffer = merged;
        }
        this.drain();
    }
    end() {
        if (this.buffer.length > 0) {
            this.passthrough(this.buffer);
            this.buffer = new Uint8Array(0);
        }
    }
    findMagic() {
        const b = this.buffer;
        for (let i = 0; i + 4 <= b.length; i++) {
            if (b[i] === 0x41 && b[i + 1] === 0x42 && b[i + 2] === 0x43 && b[i + 3] === 0x48)
                return i;
        }
        return -1;
    }
    drain() {
        for (;;) {
            const at = this.findMagic();
            if (at < 0) {
                const keep = Math.min(3, this.buffer.length);
                if (this.buffer.length > keep) {
                    this.passthrough(this.buffer.subarray(0, this.buffer.length - keep));
                    this.buffer = this.buffer.subarray(this.buffer.length - keep);
                }
                return;
            }
            if (at > 0) {
                this.passthrough(this.buffer.subarray(0, at));
                this.buffer = this.buffer.subarray(at);
            }
            if (this.buffer.length < HEADER_SIZE)
                return;
            const dv = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
            if (dv.getUint32(0, true) !== MAGIC) {
                this.passthrough(this.buffer.subarray(0, 1));
                this.buffer = this.buffer.subarray(1);
                continue;
            }
            const type = dv.getUint8(4);
            const len = dv.getUint32(5, true);
            if (this.buffer.length < HEADER_SIZE + len)
                return;
            this.dispatch(type, new DataView(this.buffer.buffer, this.buffer.byteOffset + HEADER_SIZE, len));
            this.buffer = this.buffer.subarray(HEADER_SIZE + len);
        }
    }
    dispatch(type, p) {
        const r = this.reporter;
        const str = () => {
            const n = p.getUint16(0, true);
            return utf8.decode(new Uint8Array(p.buffer, p.byteOffset + 2, n));
        };
        switch (type) {
            case 1: {
                this.benchName = str();
                r.benchStart?.(this.benchName);
                break;
            }
            case 2:
                r.warmupStarted?.(p.getFloat64(0, true));
                break;
            case 3:
                r.warmupEnded?.(p.getFloat64(0, true), p.getFloat64(8, true), p.getUint8(16) !== 0);
                break;
            case 4:
                r.measureStarted?.(p.getFloat64(0, true), p.getFloat64(8, true), p.getInt32(16, true));
                break;
            case 5:
                r.analyzing?.();
                break;
            case 6:
                r.estimate?.(p.getUint8(0), p.getFloat64(1, true), p.getFloat64(9, true), p.getFloat64(17, true));
                break;
            case 7:
                r.result?.(p.getFloat64(0, true), p.getFloat64(8, true), p.getFloat64(16, true));
                break;
            case 8:
                r.outliers?.(p.getInt32(0, true), p.getInt32(4, true), p.getInt32(8, true), p.getInt32(12, true));
                break;
            case 9:
                r.benchEnd?.();
                break;
            case 10: {
                this.suiteName = str();
                r.suiteStart?.(this.suiteName);
                break;
            }
            case 11:
                r.suiteChange?.(p.getFloat64(0, true), p.getFloat64(8, true), p.getFloat64(16, true), p.getFloat64(24, true));
                break;
            case 12:
                this.suiteName = null;
                r.suiteEnd?.();
                break;
            case 13: {
                const n = p.getInt32(0, true);
                const iters = new Float64Array(n);
                const times = new Float64Array(n);
                for (let i = 0; i < n; i++) {
                    iters[i] = p.getFloat64(4 + i * 8, true);
                    times[i] = p.getFloat64(4 + n * 8 + i * 8, true);
                }
                r.sampleDone?.(this.key(), iters, times);
                break;
            }
            case 14:
                r.faultyConfig?.(p.getUint8(0) !== 0, p.getFloat64(1, true), p.getFloat64(9, true));
                break;
            case 15:
                r.faultyBenchmark?.();
                break;
            default:
                break;
        }
    }
}
