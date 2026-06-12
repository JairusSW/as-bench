export declare class DeterministicHarness {
    private getMem;
    private mode;
    private iterCount;
    private tape;
    private cursor;
    constructor(getMem: () => WebAssembly.Memory);
    iter(): void;
    reset(): void;
    wrap(qualifiedName: string, real: (...args: never[]) => unknown, thisArg: unknown): (...args: (number | bigint)[]) => unknown;
    wrapNamespace(ns: string, imports: WebAssembly.ModuleImports): WebAssembly.ModuleImports;
}
