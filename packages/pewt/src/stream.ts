// A process, from a terminal, over the folder.
//
// `call.ts` is this file's twin: a call opens a session, asks one question and
// closes. A run opens a session, reads lines until the run ends, and closes. A
// shell opens one and talks to it in both directions until it exits. The
// difference is the shape of the conversation, not the plumbing — same folder,
// same client, same host.
//
// They are functions rather than inline in cli.ts so the end-to-end tests
// drive exactly what ships.
import { RpcError, type FsDirectory } from "@fsio/client";
import type { ShellSpec } from "pewter";
import { CallError, connect } from "./call.js";
import { asRunFrame } from "./run.js";

export interface RunOptions {
  /** one line of the script's output. `stream` is which of the child's two
   *  streams it came from, kept apart so a caller can keep them apart. */
  onLine?: (line: string, stream: "out" | "err") => void;
  /** the host has not answered the spawn yet. It is asking a human on its own
   *  terminal, and a command line that says nothing looks hung. */
  onWaiting?: () => void;
  /** what the host said it was about to start. */
  onStart?: (info: Record<string, unknown>) => void;
  pollMs?: number;
  /** how long to wait for the host's answer before giving up. Generous: the
   *  answer is a human typing in another window. */
  answerMs?: number;
}

export interface RunOutcome {
  /** the script's exit code, or null when the process died on a signal or
   *  the host went away mid-run. */
  exitCode: number | null;
  /** what ended the run, for a caller that has to explain itself. */
  ended: "exit" | "host_gone";
}

/** Waiting this long with no answer means a human is being asked. */
const WAITING_MS = 1200;

/** How long a seen-the-status-first reader waits for the run's last frames.
 *  Many poll intervals (15 ms, D16) and invisible when the frames are already
 *  there, which they normally are. */
const STATUS_GRACE_MS = 500;

export async function runOnHost(dir: FsDirectory, method: string, spec: Record<string, unknown>, opts: RunOptions = {}): Promise<RunOutcome> {
  const client = await connect(dir);
  const session = client.createSession({ kind: method, client: "pewt-cli", ...spec }, { pollMs: opts.pollMs ?? 15, heartbeatMs: 0 });

  // The spec's `kind` names both the session kind and the operation, because
  // for a process they are the same thing (ops.ts).
  let settle: ((outcome: RunOutcome) => void) | null = null;
  const finished = new Promise<RunOutcome>((resolve) => {
    settle = resolve;
  });

  session.on("data", (bytes) => {
    const frame = asRunFrame(bytes);
    // A frame this build cannot read is dropped rather than printed: a
    // half-understood line in the middle of a build's output is worse than a
    // missing one, and the run's end does not depend on it.
    if (!frame) return;
    if ("o" in frame) opts.onLine?.(frame.o, "out");
    else if ("e" in frame) opts.onLine?.(frame.e, "err");
    else settle?.({ exitCode: frame.end, ended: "exit" });
  });
  // The stream says when the run ended (run.ts: the final frame cannot
  // overtake the output it follows), so the status file is the *backstop*,
  // not the signal — the host stopping mid-run leaves a status and no `end`
  // frame. It is deliberately late: `status.json` and `out.log` are separate
  // files with no ordering between them, so a status seen first means the
  // last lines of output are still on their way. Settling on it immediately
  // would truncate exactly the output somebody is waiting to read.
  let backstop: ReturnType<typeof setTimeout> | undefined;
  session.on("status", (status) => {
    if (status.state !== "exited" && status.state !== "error") return;
    if (backstop) return;
    backstop = setTimeout(() => settle?.({ exitCode: status.exitCode ?? null, ended: "host_gone" }), STATUS_GRACE_MS);
    backstop.unref();
  });

  const waiting = setTimeout(() => opts.onWaiting?.(), WAITING_MS);
  try {
    const started = await Promise.race([
      session.ready,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new CallError("timeout", "the host never answered the request to start this run")), opts.answerMs ?? 10 * 60_000).unref()
      ),
    ]).catch((e: unknown) => {
      if (e instanceof CallError) throw e;
      if (e instanceof RpcError) {
        // Denied by the human at the host's terminal, or refused by the kind
        // (no such script, no such project). Both arrived, were understood,
        // and the answer was no.
        const data = (e.data ?? {}) as { code?: string; hint?: string };
        throw new CallError("refused", e.message, data.code, data.hint);
      }
      throw new CallError("transport", e instanceof Error ? e.message : String(e));
    });
    clearTimeout(waiting);
    opts.onStart?.(started as unknown as Record<string, unknown>);
    return await finished;
  } finally {
    clearTimeout(waiting);
    // The host owns the session directory (D6); close() only says we are done
    // — and for a run it is also what stops the child if we are leaving early.
    await session.close().catch(() => {});
  }
}

// ---- a shell: the same plumbing, talking back

export interface ShellOutcome {
  /** the shell's exit code, or null when it died on a signal or the host
   *  went away while it was running. */
  exitCode: number | null;
  ended: "exit" | "host_gone";
}

/** A shell that is running, as a terminal holds one. The same three verbs an
 *  extension gets (packages/pewter/src/shell.ts) — one operation, two front
 *  ends, and this is the terminal's end of it. */
export interface ShellAttachment {
  /** keystrokes. Not lines: the pty decides where a line ends. */
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** stop it. The host kills what it started (D6). */
  close(): Promise<void>;
  readonly exit: Promise<ShellOutcome>;
}

export interface ShellOptions {
  /** bytes the pty produced, exactly as it produced them. */
  onData: (chunk: string) => void;
  /** the host has not answered yet — it is asking a human on its own
   *  terminal, and a command line that says nothing looks hung. */
  onWaiting?: () => void;
  /** what the host said it started. */
  onStart?: (info: Record<string, unknown>) => void;
  pollMs?: number;
  answerMs?: number;
}

/** Open a shell on the host and hand back the live thing.
 *
 *  **Why the exit arrives on the status and not in the stream.** `run` puts
 *  its exit code in a final DATA frame, because `status.json` and `out.log`
 *  are separate files with no ordering between them and a client that
 *  finished on the status could cut off the last lines. A pty cannot do that:
 *  its DATA frames are the terminal's own bytes, and a JSON object among them
 *  is output rather than protocol. So a shell ends on its status, and the
 *  grace period below — belt-and-braces for a run — is load-bearing here. */
export async function shellOnHost(dir: FsDirectory, spec: ShellSpec, opts: ShellOptions): Promise<ShellAttachment> {
  const client = await connect(dir);
  const session = client.createSession({ kind: "shell", client: "pewt-cli", ...spec }, { pollMs: opts.pollMs ?? 15, heartbeatMs: 0 });

  let settle: ((outcome: ShellOutcome) => void) | null = null;
  const exit = new Promise<ShellOutcome>((resolve) => {
    settle = resolve;
  });

  const decoder = new TextDecoder();
  // `stream: true` because a pty writes bytes, not characters: a multi-byte
  // sequence can land across two frames, and decoding each frame alone would
  // put a replacement character in the middle of somebody's prompt.
  session.on("data", (bytes) => opts.onData(decoder.decode(bytes, { stream: true })));

  let grace: ReturnType<typeof setTimeout> | undefined;
  session.on("status", (status) => {
    if ((status.state !== "exited" && status.state !== "error") || grace) return;
    const outcome: ShellOutcome =
      status.state === "exited" ? { exitCode: status.exitCode ?? null, ended: "exit" } : { exitCode: null, ended: "host_gone" };
    // Late on purpose: the pty's last bytes and the status file are written
    // independently, so a status seen first means output is still on its way.
    grace = setTimeout(() => settle?.(outcome), STATUS_GRACE_MS);
    grace.unref();
  });

  const waiting = setTimeout(() => opts.onWaiting?.(), WAITING_MS);
  try {
    const started = await Promise.race([
      session.ready,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new CallError("timeout", "the host never answered the request to open this shell")), opts.answerMs ?? 10 * 60_000).unref()
      ),
    ]);
    opts.onStart?.(started as unknown as Record<string, unknown>);
  } catch (e) {
    await session.close().catch(() => {});
    if (e instanceof CallError) throw e;
    if (e instanceof RpcError) {
      // Denied at the host's terminal, or refused by the policy (no such
      // project). Both arrived, were understood, and the answer was no.
      const data = (e.data ?? {}) as { code?: string; hint?: string };
      throw new CallError("refused", e.message, data.code, data.hint);
    }
    throw new CallError("transport", e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(waiting);
  }

  return {
    write: (data) => session.sendData(data),
    resize: (cols, rows) => session.notify("resize", { cols, rows }),
    close: async () => {
      await session.close().catch(() => {});
      settle?.({ exitCode: null, ended: "exit" });
    },
    exit: exit.finally(() => void session.close().catch(() => {})),
  };
}

// ---- an agent: the same plumbing again, carrying somebody else's protocol

/** An agent that is running, as a client holds one.
 *
 *  `send` takes one complete ACP message. Not a string and not a chunk: the
 *  framing contract is that one DATA frame is exactly one message
 *  (framing.ts), and the way to keep a contract is to make the shape that
 *  breaks it unsayable. */
export interface AgentAttachment {
  send(message: unknown): void;
  close(): Promise<void>;
  /** stderr, counters, and whether it has exited — everything that is not
   *  ACP and therefore cannot ride DATA. */
  diagnostics(): Promise<AgentDiagnostics>;
  readonly exit: Promise<ShellOutcome>;
}

export interface AgentDiagnostics {
  messagesOut: number;
  messagesIn: number;
  junkLines: number;
  refusedIn: number;
  overflows: number;
  exited: boolean;
  /** the agent's own stderr, kept because it is where "I could not
   *  authenticate" arrives and it is not a message anybody can route. */
  stderr: string[];
}

export interface AgentOptions {
  /** one complete ACP message from the agent. */
  onMessage: (message: unknown) => void;
  onWaiting?: () => void;
  onStart?: (info: Record<string, unknown>) => void;
  pollMs?: number;
  answerMs?: number;
}

/** Open an agent on the host and hand back the live thing.
 *
 *  Nothing here is an ACP client. It moves messages, and whoever called it is
 *  the peer — a tab, or the program on the other side of `pewt agent`'s pipe.
 *
 *  The exit arrives on the status, as a shell's does and unlike a run's: a
 *  DATA frame here is one ACP message, so an end marker among them would be a
 *  message this build invented in somebody else's protocol. */
export async function agentOnHost(dir: FsDirectory, spec: Record<string, unknown>, opts: AgentOptions): Promise<AgentAttachment> {
  const client = await connect(dir);
  const session = client.createSession({ kind: "agent", client: "pewt-cli", ...spec }, { pollMs: opts.pollMs ?? 15, heartbeatMs: 0 });

  let settle: ((outcome: ShellOutcome) => void) | null = null;
  const exit = new Promise<ShellOutcome>((resolve) => {
    settle = resolve;
  });

  session.on("data", (bytes) => {
    // The host promised one frame is one whole message, so there is no buffer
    // here and no half-message state. A frame this build cannot parse is
    // dropped rather than guessed at — it would have to be a host bug, and
    // handing a client half a protocol is worse than handing it none.
    try {
      opts.onMessage(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      /* not a message; the host counts it in diagnostics */
    }
  });

  let grace: ReturnType<typeof setTimeout> | undefined;
  session.on("status", (status) => {
    if ((status.state !== "exited" && status.state !== "error") || grace) return;
    const outcome: ShellOutcome =
      status.state === "exited" ? { exitCode: status.exitCode ?? null, ended: "exit" } : { exitCode: null, ended: "host_gone" };
    grace = setTimeout(() => settle?.(outcome), STATUS_GRACE_MS);
    grace.unref();
  });

  const waiting = setTimeout(() => opts.onWaiting?.(), WAITING_MS);
  try {
    const started = await Promise.race([
      session.ready,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new CallError("timeout", "the host never answered the request to start this agent")), opts.answerMs ?? 10 * 60_000).unref()
      ),
    ]);
    opts.onStart?.(started as unknown as Record<string, unknown>);
  } catch (e) {
    await session.close().catch(() => {});
    if (e instanceof CallError) throw e;
    if (e instanceof RpcError) {
      const data = (e.data ?? {}) as { code?: string; hint?: string };
      throw new CallError("refused", e.message, data.code, data.hint);
    }
    throw new CallError("transport", e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(waiting);
  }

  return {
    send: (message) => session.sendData(JSON.stringify(message)),
    close: async () => {
      await session.close().catch(() => {});
      settle?.({ exitCode: null, ended: "exit" });
    },
    diagnostics: async () => {
      const { result } = await session.request("agent/diagnostics", {}, { timeoutMs: 5000 });
      return result as AgentDiagnostics;
    },
    // Unlike a shell's, this does not close the session when it settles: an
    // agent that died has just put the reason on stderr, and `diagnostics()`
    // is how anybody reads it. Closing here would reap the session the
    // question has to be asked on. The caller closes when it is done.
    exit,
  };
}
