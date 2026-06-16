// WIPC-lite: a one-way framed event stream written to stdout, used when the
// module is built for pure-WASI runtimes (wasmtime, wasmer, wazero, ...) that
// can't supply the rich `__asbench` import namespace. The host CLI scans
// stdout for frames and passes everything else through (user console.log).
//
// Frame layout (little-endian):
//   magic  u32  "ABCH" (0x48434241)
//   type   u8   FrameType
//   len    u32  payload byte length
//   payload     type-specific
//
// Settings overrides flow the other way via environment variables
// (AS_BENCH_TUNE_<kind>) — see host.ts; request/reply features (baseline
// comparison, deterministic replay) are node-host-only.

export const enum FrameType {
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
  Throughput = 16,
  SuiteChart = 17,
}

const MAGIC: u32 = 0x48434241; // "ABCH" little-endian
const HEADER_SIZE = 9;

let frameBuf = new ArrayBuffer(0);
let frameView = new DataView(frameBuf);
let framePos = 0;

function begin(type: FrameType, payloadLen: i32): void {
  const size = HEADER_SIZE + payloadLen;
  if (frameBuf.byteLength < size) {
    frameBuf = new ArrayBuffer(size);
  }
  frameView = new DataView(frameBuf, 0, size);
  frameView.setUint32(0, MAGIC, true);
  frameView.setUint8(4, <u8>type);
  frameView.setUint32(5, payloadLen, true);
  framePos = HEADER_SIZE;
}

function putF64(v: f64): void {
  frameView.setFloat64(framePos, v, true);
  framePos += 8;
}

function putI32(v: i32): void {
  frameView.setInt32(framePos, v, true);
  framePos += 4;
}

function putU8(v: u8): void {
  frameView.setUint8(framePos, v);
  framePos += 1;
}

function putBytes(data: ArrayBuffer): void {
  memory.copy(changetype<usize>(frameBuf) + framePos, changetype<usize>(data), data.byteLength);
  framePos += data.byteLength;
}

function end(): void {
  // exact-size write: slice when the scratch buffer is oversized
  const out = frameBuf.byteLength == framePos ? frameBuf : frameBuf.slice(0, framePos);
  process.stdout.write(out);
}

function sendName(type: FrameType, name: string): void {
  const utf8 = String.UTF8.encode(name);
  begin(type, 2 + utf8.byteLength);
  frameView.setUint16(framePos, <u16>utf8.byteLength, true);
  framePos += 2;
  putBytes(utf8);
  end();
}

export function benchStart(name: string): void {
  sendName(FrameType.BenchStart, name);
}

export function suiteStart(name: string): void {
  sendName(FrameType.SuiteStart, name);
}

export function warmupStarted(durationMs: f64): void {
  begin(FrameType.WarmupStarted, 8);
  putF64(durationMs);
  end();
}

export function warmupEnded(elapsedMs: f64, met: f64, converged: i32): void {
  begin(FrameType.WarmupEnded, 17);
  putF64(elapsedMs);
  putF64(met);
  putU8(<u8>converged);
  end();
}

export function measureStarted(estimatedMs: f64, totalIters: f64, sampleCount: i32): void {
  begin(FrameType.MeasureStarted, 20);
  putF64(estimatedMs);
  putF64(totalIters);
  putI32(sampleCount);
  end();
}

export function analyzing(): void {
  begin(FrameType.Analyzing, 0);
  end();
}

export function estimate(kind: i32, lb: f64, point: f64, hb: f64): void {
  begin(FrameType.Estimate, 25);
  putU8(<u8>kind);
  putF64(lb);
  putF64(point);
  putF64(hb);
  end();
}

export function result(lb: f64, point: f64, hb: f64): void {
  begin(FrameType.Result, 24);
  putF64(lb);
  putF64(point);
  putF64(hb);
  end();
}

export function outliers(los: i32, lom: i32, him: i32, his: i32): void {
  begin(FrameType.Outliers, 16);
  putI32(los);
  putI32(lom);
  putI32(him);
  putI32(his);
  end();
}

export function benchEnd(): void {
  begin(FrameType.BenchEnd, 0);
  end();
}

export function suiteChange(lb: f64, point: f64, hb: f64, pValue: f64): void {
  begin(FrameType.SuiteChange, 32);
  putF64(lb);
  putF64(point);
  putF64(hb);
  putF64(pValue);
  end();
}

export function suiteEnd(): void {
  begin(FrameType.SuiteEnd, 0);
  end();
}

export function sampleDone(itersPtr: usize, timesPtr: usize, n: i32): void {
  begin(FrameType.SampleDone, 4 + n * 16);
  putI32(n);
  memory.copy(changetype<usize>(frameBuf) + framePos, itersPtr, n * 8);
  framePos += n * 8;
  memory.copy(changetype<usize>(frameBuf) + framePos, timesPtr, n * 8);
  framePos += n * 8;
  end();
}

export function faultyConfig(linear: i32, actualMs: f64, recommendedSamples: f64): void {
  begin(FrameType.FaultyConfig, 17);
  putU8(<u8>linear);
  putF64(actualMs);
  putF64(recommendedSamples);
  end();
}

export function faultyBenchmark(): void {
  begin(FrameType.FaultyBenchmark, 0);
  end();
}

export function throughput(lb: f64, point: f64, hb: f64): void {
  begin(FrameType.Throughput, 24);
  putF64(lb);
  putF64(point);
  putF64(hb);
  end();
}

export function suiteChart(name: string, chartType: string): void {
  const nameUtf8 = String.UTF8.encode(name);
  const typeUtf8 = String.UTF8.encode(chartType);
  begin(FrameType.SuiteChart, 4 + nameUtf8.byteLength + typeUtf8.byteLength);
  frameView.setUint16(framePos, <u16>nameUtf8.byteLength, true);
  framePos += 2;
  putBytes(nameUtf8);
  frameView.setUint16(framePos, <u16>typeUtf8.byteLength, true);
  framePos += 2;
  putBytes(typeUtf8);
  end();
}
