// A shell, as an extension holds one — and the one place `--repo site`
// becomes a working directory.
//
// Every other operation is a question with an answer. A shell is a
// conversation: bytes go in, bytes come out, and it ends in an exit code. So
// `pewt.shell()` hands back something live rather than a result, and the call
// it opened stays open for as long as the shell runs.
//
// **Why the translation happens here rather than on the host.** `run` is a
// session kind this project wrote, so `{script, repo}` could travel as-is and
// be resolved against the disk on the other side. A shell is @fsio/host's own
// kind — it has the pty, the resize plumbing and the flow control — and its
// spec is the library's: a working directory relative to the folder, and a
// size. That spec has to be built before it is sent, and it is built once,
// for `pewt shell --repo site` and `pewt.shell({ repo: "site" })` alike.
//
// Nothing here is a check. The host refuses a `cwd` that escapes the folder
// (D22 containment) and Pewter's spawn policy refuses one that is not a
// project; a client validating on the host's behalf would only be deciding
// what error message it prefers.

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
export function shellSpec(options: ShellOptions = {}): ShellSpec {
  return {
    ...(options.repo !== undefined ? { cwd: `repos/${options.repo}` } : {}),
    ...(options.cols !== undefined ? { cols: options.cols } : {}),
    ...(options.rows !== undefined ? { rows: options.rows } : {}),
  };
}

/** The project a spec's `cwd` names, or null for the pewter itself. Read
 *  back out for the sentence the host's question shows. */
export function repoOfCwd(cwd: string | undefined): string | null {
  if (!cwd) return null;
  const rest = cwd.startsWith("repos/") ? cwd.slice("repos/".length) : null;
  return rest && !rest.includes("/") ? rest : null;
}
