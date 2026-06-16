import type { BenchReporter } from "./host.js";
export declare class FrameParser {
    private reporter;
    private passthrough;
    private buffer;
    private suiteName;
    private benchName;
    constructor(reporter: BenchReporter, passthrough: (bytes: Uint8Array<ArrayBufferLike>) => void);
    private key;
    push(chunk: Uint8Array<ArrayBufferLike>): void;
    end(): void;
    private findMagic;
    private drain;
    private dispatch;
}
