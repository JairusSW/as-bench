// Runs the compiled playground wasm on the as-bench host (lib/as-bs.ts).
// Invoked by `npm run run:playground`; expects the .wasm path as the last arg.
import { instantiate, defaultImports } from "../lib/build/as-bs.js";

await instantiate(defaultImports());
