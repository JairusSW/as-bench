export class TermLine {
    public start: i32 = 0;
    public end: i32 = 0;
    constructor(start: i32 = 0, end: i32 = 0) {
        this.start = start;
        this.end = end;
    }
    edit(data: string): TermLine {
        let end = this.end;
        while (--end >= this.start) {
            term.clearLn(end);
        }
        writeRaw(data);
        term.resetCursor();
        return new TermLine(this.end);
    }
    clear(): void {
        term.clearLn(this.start);
    }
}

export namespace term {
    export let lines: i32 = 0;
    export function write(data: string): TermLine {
        const start = term.lines;
        for (let i = 0; i < data.length; i++) {
            const code = data.charCodeAt(i);
            if (code === 10) term.lines++;
        }
        writeRaw(data);
        return new TermLine(start, term.lines);
    }
    export function clearLn(line: i32): void {
        writeRaw(`\u001B[${term.lines - line}A`);
        writeRaw("\x1B[2K");
        writeRaw("\x1B[0G");
    }
    export function resetCursor(): void {
        writeRaw("\x1B[999B");
        writeRaw("\x1B[0G");
    }
}

export function writeRaw(data: string): void {
    process.stdout.write(data);
}
