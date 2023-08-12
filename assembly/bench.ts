import { formatIterations, formatTime } from "./util";

const warmup_duration = 3000;
const execute_duration = 5000;

const backSlashCode = 92;

export function bench(description: string, routine: () => void): void {
    console.log(`Benchmarking ${description}:`);
    warmup(description, routine, warmup_duration);
    execute(description, routine, execute_duration);
}

export function warmup(description: string, routine: () => void, ms: i32): void {
    console.log(` - Warming up for ${ms}ms`);
    const start_time = performance.now();
    const end_time = start_time + ms;
    while (true) {
        const current_time = performance.now();
        if (current_time >= end_time) break;
        routine();
    }
}

export function execute(description: string, routine: () => void, ms: i32): void {
    console.log(` - Running benchmark`);
    const start_time = performance.now();
    const end_time = start_time + ms;
    let iterations: i64 = 0;
    let total_time = 0.0;
    while (true) {
        const current_time = performance.now();
        if (current_time >= end_time) {
            total_time = current_time - start_time;
            break;
        }
        routine();
        iterations++;
    }
    console.log(`Completed ${iterations} iterations in ${formatTime(total_time)}. ${iterations/i64(total_time/1000)} operations in ${formatTime(total_time / 5)}`);
}

const blackboxArea = memory.data(128);
export function blackbox<T>(x: T): T {
    store<T>(blackboxArea, x);
    return load<T>(blackboxArea);
}

bench("Serialize String", () => {
    parseString('"st\\"ring\\" w\\"\\"ith quotes\\""');
});

bench("SNIP Integer Parsing", () => {
    snip_fast<u32>("12345");
});

bench("Zero time", () => { });

// @ts-ignore: Decorators are valid
@inline function unsafeCharCodeAt(data: string, pos: i32): i32 {
    return load<u16>(changetype<usize>(data) + ((<usize>pos) << 1));
}

function parseString(data: string): string {
    let result = "";
    let last = 1;
    for (let i = 1; i < data.length - 1; i++) {
        // \\"
        if (unsafeCharCodeAt(data, i) === backSlashCode) {
            const char = unsafeCharCodeAt(data, ++i);
            result += data.slice(last, i - 1);
            if (char === 34) {
                result += '"';
                last = i + 1;
            } else if (char >= 92 && char <= 117) {
                switch (char) {
                    case 92: {
                        result += "\\";
                        last = i + 1;
                        break;
                    }
                    case 98: {
                        result += "\b";
                        last = i + 1;
                        break;
                    }
                    case 102: {
                        result += "\f";
                        last = i + 1;
                        break;
                    }
                    case 110: {
                        result += "\n";
                        last = i + 1;
                        break;
                    }
                    case 114: {
                        result += "\r";
                        last = i + 1;
                        break;
                    }
                    case 116: {
                        result += "\t";
                        last = i + 1;
                        break;
                    }
                    default: {
                        if (
                            char === 117 &&
                            load<u64>(changetype<usize>(data) + <usize>((i + 1) << 1)) ===
                            27584753879220272
                        ) {
                            result += "\u000b";
                            i += 4;
                            last = i + 1;
                        }
                        break;
                    }
                }
            }
        }
    }
    result += data.slice(last, data.length - 1);
    return result;
}

// @ts-ignore: Decorator
@inline export function snip_fast<T extends number>(str: string, len: u32 = 0, offset: u32 = 0): T {
    if (isSigned<T>()) {
        const firstChar: u32 = load<u16>(changetype<usize>(str));
        if (firstChar === 48) return 0 as T;
        const isNegative = firstChar === 45; // Check if the number is negative
        let val: T = 0 as T;
        if (len == 0) len = u32(str.length << 1);
        if (isNegative) {
            offset += 2;
            if (len >= 4) {
                // 32-bit route
                for (; offset < (len - 3); offset += 4) {
                    const ch = load<u32>(changetype<usize>(str) + <usize>offset);
                    const low = ch & 0xFFFF;
                    const high = ch >> 16;
                    // 9 is 57. The highest group of two numbers is 114, so if a e or an E is included, this will fire.
                    if (low > 57) {
                        // The first char (f) is E or e
                        // We push the offset up by two and apply the notation.
                        if (load<u16>(changetype<usize>(str) + <usize>offset + 2) == 45) {
                            return -(val / (10 ** (atoi_fast<u32>(str, offset + 6) - 1))) as T;
                        } else {
                            // Inlined this operation instead of using a loop
                            return -(val * (10 ** (atoi_fast<u32>(str, offset + 2) + 1))) as T;
                        }
                    } else if (high > 57) {
                        // The first char (f) is E or e
                        // We push the offset up by two and apply the notation.
                        if (load<u16>(changetype<usize>(str) + <usize>offset + 4) == 45) {
                            return -(val / (10 ** (atoi_fast<u32>(str, offset + 6) - 1))) as T;
                        } else {
                            // Inlined this operation instead of using a loop
                            return -(val * (10 ** (atoi_fast<u32>(str, offset + 4) + 1))) as T;
                        }
                    } else {
                        val = (val * 100 + ((low - 48) * 10) + (high - 48)) as T;
                    }
                }
            }
            // Finish up the remainder with 16 bits.
            for (; offset < len; offset += 2) {
                const ch = load<u16>(changetype<usize>(str) + <usize>offset);
                // 9 is 57. E and e are larger. Assumes valid JSON.
                if (ch > 57) {
                    // The first char (f) is E or e
                    // We push the offset up by two and apply the notation.
                    if (load<u16>(changetype<usize>(str) + <usize>offset + 2) == 45) {
                        return -(val / (10 ** (atoi_fast<u32>(str, offset + 6) - 1))) as T;
                    } else {
                        // Inlined this operation instead of using a loop
                        return -(val * (10 ** (atoi_fast<u32>(str, offset + 2) + 1))) as T;
                    }
                } else {
                    val = (val * 10) + (ch - 48) as T;
                }
            }
            return -val as T;
        } else {
            if (len >= 4) {
                // Duplet 16 bit lane load
                for (; offset < (len - 3); offset += 4) {
                    const ch = load<u32>(changetype<usize>(str) + <usize>offset);
                    const low = ch & 0xFFFF;
                    const high = ch >> 16;
                    // 9 is 57. The highest group of two numbers is 114, so if a e or an E is included, this will fire.
                    if (low > 57) {
                        // The first char (f) is E or e
                        // We push the offset up by two and apply the notation.
                        if (load<u16>(changetype<usize>(str) + <usize>offset + 2) == 45) {
                            return (val / (10 ** (atoi_fast<u32>(str, offset + 6) - 1))) as T;
                        } else {
                            // Inlined this operation instead of using a loop
                            return (val * (10 ** (atoi_fast<u32>(str, offset + 2) + 1))) as T;
                        }
                    } else if (high > 57) {
                        if (load<u16>(changetype<usize>(str) + <usize>offset + 4) == 45) {
                            return (val / (10 ** (atoi_fast<u32>(str, offset + 6) - 1))) as T;
                        } else {
                            // Inlined this operation instead of using a loop
                            return (val * (10 ** (atoi_fast<u32>(str, offset + 4) + 1))) as T;
                        }
                    } else {
                        // Optimized with multiplications and shifts.
                        val = (val * 100 + ((low - 48) * 10) + (high - 48)) as T;
                    }
                }
            }
            // Cover the remaining numbers with 16 bit loads.
            for (; offset < len; offset += 2) {
                const ch = load<u16>(changetype<usize>(str) + <usize>offset);
                // 0's char is 48 and 9 is 57. Anything above this range would signify an exponent (e or E).
                // e is 101 and E is 69.
                if (ch > 57) {
                    if (load<u16>(changetype<usize>(str) + <usize>offset + 2) == 45) {
                        val = (val / (10 ** (atoi_fast<u32>(str, offset + 6) - 1))) as T;
                    } else {
                        // Inlined this operation instead of using a loop
                        val = (val * (10 ** (atoi_fast<u32>(str, offset + 2) + 1))) as T;
                    }
                    return val as T;
                } else {
                    val = (val * 10) + (ch - 48) as T;
                }
            }
            return val as T;
        }
    } else {
        const firstChar: u32 = load<u16>(changetype<usize>(str));
        if (firstChar === 48) return 0 as T;
        let val: T = 0 as T;
        if (len == 0) len = u32(str.length << 1);
        if (len >= 4) {
            // Duplet 16 bit lane load
            for (; offset < (len - 3); offset += 4) {
                const ch = load<u32>(changetype<usize>(str) + <usize>offset);
                const low = ch & 0xFFFF;
                const high = ch >> 16;
                // 9 is 57. The highest group of two numbers is 114, so if a e or an E is included, this will fire.
                if (low > 57) {
                    // The first char (f) is E or e
                    // We push the offset up by two and apply the notation.
                    if (load<u16>(changetype<usize>(str) + <usize>offset + 2) == 45) {
                        return (val / (10 ** (atoi_fast<u32>(str, offset + 6) - 1))) as T;
                    } else {
                        // Inlined this operation instead of using a loop
                        return (val * (10 ** (atoi_fast<u32>(str, offset + 2) + 1))) as T;
                    }
                } else if (high > 57) {
                    if (load<u16>(changetype<usize>(str) + <usize>offset + 4) == 45) {
                        return (val / (10 ** (atoi_fast<u32>(str, offset + 6) - 1))) as T;
                    } else {
                        // Inlined this operation instead of using a loop
                        return (val * (10 ** (atoi_fast<u32>(str, offset + 4) + 1))) as T;
                    }
                } else {
                    // Optimized with multiplications and shifts.
                    val = (val * 100 + ((low - 48) * 10) + (high - 48)) as T;
                }
            }
        }
        // Cover the remaining numbers with 16 bit loads.
        for (; offset < len; offset += 2) {
            const ch = load<u16>(changetype<usize>(str) + <usize>offset);
            // 0's char is 48 and 9 is 57. Anything above this range would signify an exponent (e or E).
            // e is 101 and E is 69.
            if (ch > 57) {
                if (load<u16>(changetype<usize>(str) + <usize>offset + 2) == 45) {
                    return (val / (10 ** (atoi_fast<u32>(str, offset + 6) - 1))) as T;
                } else {
                    // Inlined this operation instead of using a loop
                    return (val * (10 ** (atoi_fast<u32>(str, offset + 2) + 1))) as T;
                }
            } else {
                val = (val * 10) + (ch - 48) as T;
            }
        }
        return val as T;
    }
}

/**
 * Implementation of ATOI. Can be much much faster with SIMD.
 */

// @ts-ignore
@inline export function atoi_fast<T extends number>(str: string, offset: u32 = 0): T {
    // @ts-ignore
    let val: T = 0;
    const len = u32(str.length << 1);
    if (isSigned<T>()) {
        // Negative path
        if (load<u16>(changetype<usize>(str) + <usize>offset) === 45) {
            offset += 2;
            for (; offset < len; offset += 2) {
                val = (val * 10) + (load<u16>(changetype<usize>(str) + <usize>offset) - 48) as T;
            }
            return -val as T;
        } else {
            for (; offset < len; offset += 2) {
                val = ((val * 10) + (load<u16>(changetype<usize>(str) + <usize>offset) - 48)) as T;
            }
            return val as T;
        }
    } else {
        for (; offset < len; offset += 2) {
            val = ((val * 10) + (load<u16>(changetype<usize>(str) + <usize>offset) - 48)) as T;
        }
        return val as T;
    }
}