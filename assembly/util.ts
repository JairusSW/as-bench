export function computeGrowthFactor(len: u64): u64 {
    return len * (1 << (2 - ((log2(len - 8) - 8) >>> 4)));
}

export function log2(value: u64): u64 {
    if (value == 0) return 0;
    return 63 - clz<u64>(value);
}

export function formatTime(ms: f64): string {
    if (ms < 10e-6) {
        return short<f64>(ms * 1e9).toString() + "ps";
    } else if (ms < 10e-3) {
        return short<f64>(ms * 1e6).toString() + "ns";
    } else if (ms < 10) {
        return short<f64>(ms * 1e3).toString() + "us";
    } else if (ms < 10e3) {
        return short<f64>(ms).toString() + "ms";
    } else {
        return short<f64>(ms * 1e-3).toString() + "s";
    }
}

function short<T extends number>(n: T): T {
    if (isInteger<T>()) {
        if (n < 10) {
            return (~~(n * 10000) / 10000) as T;
        } else if (n < 100) {
            return (~~(n * 1000) / 1000) as T;
        } else if (n < 1000) {
            return (~~(n * 100) / 100) as T;
        } else if (n < 10000) {
            return (~~(n * 10) / 10) as T;
        } else {
            return (~~n) as T;
        }
    } else {
        if (n < 10) {
            return (Math.round(n * 10000.0) / 10000.0) as T;
        } else if (n < 100) {
            return (Math.round(n * 1000.0) / 1000.0) as T;
        } else if (n < 1000) {
            return (Math.round(n * 100.0) / 100.0) as T;
        } else if (n < 10000) {
            return (Math.round(n * 10.0) / 10.0) as T;
        } else {
            return Math.round(n) as T;
        }
    }
}