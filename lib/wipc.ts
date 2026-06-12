// Host-side decoder for the WIPC-lite frame stream (assembly/util/wipc.ts).
// Feed raw stdout chunks from an external runtime (wasmtime, wasmer, ...);
// frames dispatch onto a BenchReporter, everything between frames passes
// through (user console.log output).

import type { BenchReporter } from "./as-bs.js";

const MAGIC = 0x48434241; // "ABCH" little-endian
const HEADER_SIZE = 9;

const enum FrameType {
  BenchStart = 1,
  WarmupStarted = 2,
  WarmupEnded = 3,
  MeasureStarted = 4,
  Analyzing = 5,
  Estimate = 6,
  Result = 7,
  Outliers = 8,
  BenchEnd = 9,
  SuiteStart = 10,
  SuiteChange = 11,
  SuiteEnd = 12,
  SampleDone = 13,
  FaultyConfig = 14,
  FaultyBenchmark = 15,
}

const utf8 = new TextDecoder();

export class FrameParser {
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private suiteName: string | null = null;
  private benchName = "";

  constructor(
    private reporter: BenchReporter,
    private passthrough: (bytes: Uint8Array<ArrayBufferLike>) => void,
  ) {}

  private key(): string {
    return this.suiteName !== null ? `${this.suiteName}/${this.benchName}` : this.benchName;
  }

  push(chunk: Uint8Array<ArrayBufferLike>): void {
    if (this.buffer.length === 0) {
      this.buffer = chunk;
    } else {
      const merged = new Uint8Array(this.buffer.length + chunk.length);
      merged.set(this.buffer);
      merged.set(chunk, this.buffer.length);
      this.buffer = merged;
    }
    this.drain();
  }

  /** Flush trailing non-frame bytes (call once the stream has ended). */
  end(): void {
    if (this.buffer.length > 0) {
      this.passthrough(this.buffer);
      this.buffer = new Uint8Array(0);
    }
  }

  private findMagic(): number {
    const b = this.buffer;
    for (let i = 0; i + 4 <= b.length; i++) {
      if (b[i] === 0x41 && b[i + 1] === 0x42 && b[i + 2] === 0x43 && b[i + 3] === 0x48) return i;
    }
    return -1;
  }

  private drain(): void {
    for (;;) {
      const at = this.findMagic();
      if (at < 0) {
        // no magic: emit all but the last 3 bytes (could be a magic prefix)
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
      if (this.buffer.length < HEADER_SIZE) return;
      const dv = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
      if (dv.getUint32(0, true) !== MAGIC) {
        // shouldn't happen (findMagic matched) — emit one byte and rescan
        this.passthrough(this.buffer.subarray(0, 1));
        this.buffer = this.buffer.subarray(1);
        continue;
      }
      const type = dv.getUint8(4);
      const len = dv.getUint32(5, true);
      if (this.buffer.length < HEADER_SIZE + len) return; // incomplete frame
      this.dispatch(type, new DataView(this.buffer.buffer, this.buffer.byteOffset + HEADER_SIZE, len));
      this.buffer = this.buffer.subarray(HEADER_SIZE + len);
    }
  }

  private dispatch(type: number, p: DataView): void {
    const r = this.reporter;
    const str = (): string => {
      const n = p.getUint16(0, true);
      return utf8.decode(new Uint8Array(p.buffer, p.byteOffset + 2, n));
    };
    switch (type) {
      case FrameType.BenchStart: {
        this.benchName = str();
        r.benchStart?.(this.benchName);
        break;
      }
      case FrameType.WarmupStarted:
        r.warmupStarted?.(p.getFloat64(0, true));
        break;
      case FrameType.WarmupEnded:
        r.warmupEnded?.(p.getFloat64(0, true), p.getFloat64(8, true), p.getUint8(16) !== 0);
        break;
      case FrameType.MeasureStarted:
        r.measureStarted?.(p.getFloat64(0, true), p.getFloat64(8, true), p.getInt32(16, true));
        break;
      case FrameType.Analyzing:
        r.analyzing?.();
        break;
      case FrameType.Estimate:
        r.estimate?.(p.getUint8(0), p.getFloat64(1, true), p.getFloat64(9, true), p.getFloat64(17, true));
        break;
      case FrameType.Result:
        r.result?.(p.getFloat64(0, true), p.getFloat64(8, true), p.getFloat64(16, true));
        break;
      case FrameType.Outliers:
        r.outliers?.(p.getInt32(0, true), p.getInt32(4, true), p.getInt32(8, true), p.getInt32(12, true));
        break;
      case FrameType.BenchEnd:
        r.benchEnd?.();
        break;
      case FrameType.SuiteStart: {
        this.suiteName = str();
        r.suiteStart?.(this.suiteName);
        break;
      }
      case FrameType.SuiteChange:
        r.suiteChange?.(p.getFloat64(0, true), p.getFloat64(8, true), p.getFloat64(16, true), p.getFloat64(24, true));
        break;
      case FrameType.SuiteEnd:
        this.suiteName = null;
        r.suiteEnd?.();
        break;
      case FrameType.SampleDone: {
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
      case FrameType.FaultyConfig:
        r.faultyConfig?.(p.getUint8(0) !== 0, p.getFloat64(1, true), p.getFloat64(9, true));
        break;
      case FrameType.FaultyBenchmark:
        r.faultyBenchmark?.();
        break;
      default:
        // unknown frame: skip silently (forward compatibility)
        break;
    }
  }
}
