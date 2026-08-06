/** What to ask for. Every field is optional: `pewt.shell()` is a shell in
 *  the pewter itself, at the pty's default size. */
export interface ShellOptions {
    /** a project under `repos/`. Omit it for the pewter itself. */
    repo?: string;
    cols?: number;
    rows?: number;
    /** what the shell printed. Bytes exactly as the pty produced them, escape
     *  sequences included — this is a terminal's output, not lines of text. */
    onData?: (chunk: string) => void;
}
/** The spec a shell session carries. @fsio/host's shape, not ours. A type
 *  rather than an interface so it can be handed straight to anything that
 *  takes a bag of session parameters. */
export type ShellSpec = {
    /** folder-relative. Absent means the pewter itself. */
    cwd?: string;
    cols?: number;
    rows?: number;
};
/** A shell that is running. `write` is a keystroke, not a line: a terminal
 *  has no notion of one, and the pty is what decides where a line ends. */
export interface Shell {
    write(data: string): void;
    resize(cols: number, rows: number): void;
    /** ask it to end. The host stops what it started (D6). */
    close(): void;
    /** its exit code, or null when it died on a signal or the host went away. */
    readonly exit: Promise<number | null>;
}
/** What a shell leaves behind — the answer to the call that opened it. */
export interface ShellResult {
    exitCode: number | null;
}
/** Options → the spec that goes on the wire. A `repo` that is not a plain
 *  directory name is passed through unchanged rather than cleaned up: the
 *  host refuses it, and a client that quietly rewrites a name would run
 *  somewhere other than where it was asked to. */
export declare function shellSpec(options?: ShellOptions): ShellSpec;
/** The project a spec's `cwd` names, or null for the pewter itself. Read
 *  back out for the sentence the host's question shows. */
export declare function repoOfCwd(cwd: string | undefined): string | null;
//# sourceMappingURL=shell.d.ts.map