// This terminal, attached to a shell the host started.
//
// `pewt shell` in a window that already has a shell in it looks redundant
// until you notice which machine each one is on: this one runs where the host
// runs, in the project you named, on the record, and a page can open the same
// thing. It is the terminal's half of one operation, not a convenience
// wrapper around `cd`.
//
// Everything here is about handing a real terminal over and giving it back.
// Raw mode is the whole trick: the pty on the other side is what interprets
// keys, so this side must not — no line editing, no signal handling, no echo.
// The restore is in a `finally` for the obvious reason (a terminal left in raw
// mode after a crash is a shell that appears to have stopped working).
import type { FsDirectory } from "@fsio/client";
import type { ShellSpec } from "pewter";
import { shellOnHost, type ShellOutcome } from "./stream.js";

/** The streams this attaches to. Named rather than reached for, so a test can
 *  hand over something that is not a terminal. */
export interface Streams {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}

/** The size to ask for. A terminal knows its own; anything else takes the
 *  pty's default, which is what `cols`/`rows` being absent means. */
export function sizeOf(output: NodeJS.WriteStream): { cols?: number; rows?: number } {
  return output.isTTY ? { cols: output.columns, rows: output.rows } : {};
}

/** Attach `streams` to a shell on the host and return when it exits.
 *
 *  Resolves with the shell's own outcome; throws what `shellOnHost` throws
 *  when it never started — before anything has been done to the terminal, so
 *  a refusal leaves it exactly as it was found. */
export async function attachTerminal(dir: FsDirectory, spec: ShellSpec, streams: Streams, opts: { onWaiting?: () => void } = {}): Promise<ShellOutcome> {
  const { input, output } = streams;
  const shell = await shellOnHost(dir, spec, {
    onData: (chunk) => output.write(chunk),
    ...(opts.onWaiting ? { onWaiting: opts.onWaiting } : {}),
  });

  const raw = input.isTTY;
  const onInput = (data: string): void => shell.write(data);
  const onResize = (): void => {
    if (output.isTTY) shell.resize(output.columns, output.rows);
  };
  // stdin ending is the pipe case: `echo pwd | pewt shell`. The shell sees
  // end-of-input and exits on its own, so this only stops sending.
  const onEnd = (): void => void shell.close();

  try {
    if (raw) input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    input.on("data", onInput);
    input.on("end", onEnd);
    if (output.isTTY) process.on("SIGWINCH", onResize);
    return await shell.exit;
  } finally {
    input.off("data", onInput);
    input.off("end", onEnd);
    process.off("SIGWINCH", onResize);
    if (raw) input.setRawMode(false);
    // Without this the process stays alive on a resumed stdin, and `pewt
    // shell` would hang after its shell had already gone.
    input.pause();
  }
}
