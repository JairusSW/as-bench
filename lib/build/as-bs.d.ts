export type RuntimeTarget = "bindings" | "wasi";
export declare function now(): number;
export declare function defaultImports(): WebAssembly.Imports;
export declare function instantiate(imports?: WebAssembly.Imports): Promise<WebAssembly.Instance>;
