// Folder → client → the one session the shell keeps open.
//
// The shell is an fsio client, exactly as `pewt` is: it opens a session of
// kind `pewt` and calls methods on it. Every operation an extension asks for
// goes down this session, so there is one place where the page's reach is
// visible and it is this file.
//
// The folder-grant lifecycle below is the third copy in the repo (acp's and
// actuator's are the other two, and
// [#160](https://github.com/dglazkov/fsio/issues/160) is open on where it
// should live). Copied rather than extracted: three consumers is a stronger
// signal than two, but answering it from inside a skeleton would settle a
// library's shape as a side effect of building something else.
import { FsioClient, RpcError, type FsioSession } from "@fsio/client";
import { folder, gate, host, pending, phase, pickError } from "./state";
import { log, reporter, step } from "./reporter";

let client: FsioClient | null = null;
let session: FsioSession | null = null;
let hostTimer: ReturnType<typeof setInterval> | undefined;
let hostWasAlive = false;
/** The granted folder. Kept because the shell reads through it directly —
 *  one grant, two uses: the transport rides it, and so does every extension
 *  bundle the host builds. */
let rootHandle: FileSystemDirectoryHandle | null = null;

export const root = (): FileSystemDirectoryHandle | null => rootHandle;

export function checkGates(): void {
  if (typeof showDirectoryPicker !== "function") {
    gate.set({
      msg: "Pewter needs Chrome (or a Chromium browser).",
      hint: "The shell talks to your machine through a folder you grant it, using the File System Access API. That API has not shipped elsewhere yet.",
    });
  }
}

/** What this page is doing, on `<body data-fsio-state>`.
 *
 *  A page attribute rather than only a signal, because it is read from
 *  outside: a driving script watches for `awaiting-grant` and then
 *  `connected`, which is how a run can be automated up to the one click that
 *  cannot be (F15). The workbench established the shape and the two values. */
function markState(value: "setup" | "awaiting-grant" | "connected"): void {
  document.body.dataset["fsioState"] = value;
}

/** A folder dropped onto the page.
 *
 *  A drop mints a real directory handle (F14) — the same kind the picker
 *  returns — but it arrives at `prompt` for writing, so the allow is a
 *  second gesture and gets its own button.
 *
 *  It takes the *promise*, not the item: `getAsFileSystemHandle()` must be
 *  called synchronously inside the drop handler, because DataTransfer items
 *  are neutered the moment that handler returns. The workbench learned this
 *  first (packages/workbench/src/app.ts) and it is the kind of thing that
 *  fails as silence rather than as an error. */
export async function acceptDrop(pendingHandle: Promise<FileSystemHandle | null>): Promise<void> {
  const handle = await pendingHandle.catch(() => null);
  if (!handle || handle.kind !== "directory") {
    pickError.set("That drop was not a folder. Drop the pewter itself — the directory with package.json in it.");
    step("a drop arrived that was not a folder");
    return;
  }
  pending.set(handle as FileSystemDirectoryHandle);
  pickError.set("");
  markState("awaiting-grant");
  step("a folder was dropped — waiting for the allow");
}

/** Allow the dropped folder. Must be called from a click: requesting write
 *  permission needs a user activation, and that gesture is the security
 *  model rather than an obstacle to it (F15). */
export async function grantPending(): Promise<void> {
  const handle = pending.get();
  if (!handle) return;
  const permission = await handle.requestPermission({ mode: "readwrite" });
  if (permission !== "granted") {
    pending.set(null);
    markState("setup");
    pickError.set("Writing was not allowed, so there is no channel. Drop the folder again to retry.");
    return;
  }
  pending.set(null);
  await connectTo(handle);
}

export async function pickFolder(): Promise<void> {
  pickError.set("");
  step("opening the folder picker");
  let picked: FileSystemDirectoryHandle;
  try {
    picked = await showDirectoryPicker({ mode: "readwrite" });
  } catch {
    return; // cancelled — not an error
  }
  await connectTo(picked);
}

async function connectTo(dir: FileSystemDirectoryHandle): Promise<void> {
  step(`connecting to ${dir.name}/`);
  pickError.set("");
  clearInterval(hostTimer);

  // Probe for `.fsio` WITHOUT creating it: connect() would create one in
  // whatever folder was picked, littering the wrong folder and hiding "no
  // host here" behind an empty success.
  let fsioDir: FileSystemDirectoryHandle;
  try {
    fsioDir = await dir.getDirectoryHandle(".fsio");
  } catch {
    client = null;
    host.set("none");
    // Back to `setup`, not left at `awaiting-grant`: the folder was allowed,
    // it just has no host in it. A page attribute that still says a grant is
    // outstanding would be wrong on screen and wrong to anything reading it.
    markState("setup");
    pickError.set(
      `No host in ${dir.name}/. Is this a pewter, with \`npm start\` running in it? A host creates a .fsio directory there and we do not see one — nothing was written to the folder you just picked.`
    );
    log(`no .fsio in ${dir.name}/ — no host running there`);
    return;
  }

  try {
    client = new FsioClient(dir);
    await client.connect();
    await reporter.attach(fsioDir);
    reporter.event("connected", { folder: dir.name });
  } catch (e) {
    client = null;
    markState("setup");
    pickError.set(`Could not open ${dir.name}/.fsio — ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  rootHandle = dir;
  folder.set(dir.name);
  hostWasAlive = false;
  await refreshHost();
  hostTimer = setInterval(() => void refreshHost(), 2000);
}

async function refreshHost(): Promise<void> {
  if (!client) return;
  const info = await client.hostInfo();
  if (!info.alive) {
    hostWasAlive = false;
    host.set("silent");
    return;
  }
  host.set("alive");
  if (!hostWasAlive) {
    hostWasAlive = true;
    await openSession();
  }
}

/** One session, opened once the host answers. Its whole job is to be the
 *  thing the API is called on. */
async function openSession(): Promise<void> {
  if (!client || session) return;
  step("opening a session");
  const s = client.createSession({ kind: "pewt", client: "pewter-shell" }, { pollMs: 15 });
  session = s;
  s.on("status", (status) => {
    if (status.state !== "running" && session === s) {
      session = null;
      log(`session ${s.id} ended (${status.state})`);
    }
  });
  s.on("error", (e) => log("session error:", e));
  try {
    const info = await s.ready;
    reporter.event("session", { id: s.id, operations: info["operations"] ?? null });
    log(`session ${s.id} open on ${String(info["pewter"] ?? "this pewter")}`);
    phase.set("live");
    markState("connected");
  } catch (e) {
    session = null;
    pickError.set(`The host refused the session: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** What went wrong with a call, in the extension's vocabulary. The host puts
 *  the operation's own code and hint in the error's `data`; this unwraps
 *  them so the shell never has to read a sentence to decide anything. */
export interface CallFailure {
  code: string;
  message: string;
  hint?: string;
}

export class ShellCallError extends Error implements CallFailure {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = "ShellCallError";
  }
}

/** Call one operation on the host. The only path out of this page, used by
 *  the shell itself and by every extension through the bridge. */
export async function callHost(method: string, params: unknown): Promise<unknown> {
  if (!session) throw new ShellCallError("no_session", "the shell is not connected to a host", "start one in the pewter: npm start");
  try {
    const { result } = await session.request(method, params, { timeoutMs: 30_000 });
    return result;
  } catch (e) {
    if (e instanceof RpcError) {
      const data = (e.data ?? {}) as { code?: string; hint?: string };
      throw new ShellCallError(data.code ?? "refused", e.message, data.hint);
    }
    throw new ShellCallError("transport", e instanceof Error ? e.message : String(e));
  }
}

/** Run a script on the host, streaming its output back as it arrives.
 *
 *  This is the second kind of session this page opens, and the first one that
 *  is not the API: a run is a process, so it gets a session of its own for as
 *  long as it lasts (packages/pewt/src/run.ts says why). The control session
 *  above stays exactly what it was.
 *
 *  The host asks a human at its own terminal before it starts anything, so
 *  `ready` here can take as long as somebody takes to answer, and a refusal
 *  is a normal outcome rather than a failure. */
export async function runOnHost(spec: Record<string, unknown>, onLine: (line: string, stream: "out" | "err") => void): Promise<{ exitCode: number | null }> {
  if (!client) throw new ShellCallError("no_session", "the shell is not connected to a host", "start one in the pewter: npm start");
  const run = client.createSession({ kind: "run", client: "pewter-shell", ...spec }, { pollMs: 15 });

  let settle: ((result: { exitCode: number | null }) => void) | null = null;
  const finished = new Promise<{ exitCode: number | null }>((resolve) => {
    settle = resolve;
  });
  run.on("data", (bytes) => {
    let frame: { o?: unknown; e?: unknown; end?: unknown };
    try {
      frame = JSON.parse(new TextDecoder().decode(bytes)) as typeof frame;
    } catch {
      return; // not a frame this build reads; dropping it beats guessing
    }
    if (typeof frame.o === "string") onLine(frame.o, "out");
    else if (typeof frame.e === "string") onLine(frame.e, "err");
    else if ("end" in frame) settle?.({ exitCode: typeof frame.end === "number" ? frame.end : null });
  });
  // The backstop, not the signal: `status.json` and `out.log` are separate
  // files with no ordering between them, so finishing on the status alone
  // would cut off the last lines of a build. Late on purpose.
  let backstop: ReturnType<typeof setTimeout> | undefined;
  run.on("status", (status) => {
    if ((status.state !== "exited" && status.state !== "error") || backstop) return;
    backstop = setTimeout(() => settle?.({ exitCode: status.exitCode ?? null }), 500);
  });

  try {
    await run.ready;
    return await finished;
  } catch (e) {
    if (e instanceof RpcError) {
      const data = (e.data ?? {}) as { code?: string; hint?: string };
      throw new ShellCallError(data.code ?? "refused", e.message, data.hint);
    }
    throw new ShellCallError("transport", e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(backstop);
    // Closing a live run is also how it is stopped: the host kills the
    // process group it started (D6 — the host owns cleanup).
    await run.close().catch(() => {});
  }
}

/** A shell that is running, as the bridge holds one. */
export interface ShellHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
  /** its exit code, once it has one. */
  readonly exit: Promise<{ exitCode: number | null }>;
}

/** Open a shell on the host.
 *
 *  The third kind of session this page opens, and the first one that talks
 *  back: a run listens, a shell converses. What rides the session is the
 *  terminal's own bytes in both directions — no framing, no lines, nothing
 *  this page interprets. Whatever renders it is an extension's business.
 *
 *  The exit arrives on the status rather than in the stream, unlike a run:
 *  a pty's DATA frames are the terminal's bytes, so there is nowhere to put
 *  an end marker that would not also be output. The grace period is what
 *  keeps the last bytes from being cut off. */
export async function shellOnHost(spec: Record<string, unknown>, onData: (chunk: string) => void): Promise<ShellHandle> {
  if (!client) throw new ShellCallError("no_session", "the shell is not connected to a host", "start one in the pewter: npm start");
  const session = client.createSession({ kind: "shell", client: "pewter-shell", ...spec }, { pollMs: 15 });

  let settle: ((result: { exitCode: number | null }) => void) | null = null;
  const exit = new Promise<{ exitCode: number | null }>((resolve) => {
    settle = resolve;
  });

  // `stream: true`: a pty writes bytes, and a multi-byte character can land
  // across two frames. Decoding each frame alone would put a replacement
  // character in the middle of somebody's prompt.
  const decoder = new TextDecoder();
  session.on("data", (bytes) => onData(decoder.decode(bytes, { stream: true })));
  let grace: ReturnType<typeof setTimeout> | undefined;
  session.on("status", (status) => {
    if ((status.state !== "exited" && status.state !== "error") || grace) return;
    grace = setTimeout(() => settle?.({ exitCode: status.exitCode ?? null }), 500);
  });

  try {
    await session.ready;
  } catch (e) {
    await session.close().catch(() => {});
    if (e instanceof RpcError) {
      const data = (e.data ?? {}) as { code?: string; hint?: string };
      throw new ShellCallError(data.code ?? "refused", e.message, data.hint);
    }
    throw new ShellCallError("transport", e instanceof Error ? e.message : String(e));
  }

  return {
    write: (data) => session.sendData(data),
    resize: (cols, rows) => session.notify("resize", { cols, rows }),
    // Closing a live shell is also how it is stopped: the host kills what it
    // started (D6 — the host owns cleanup).
    close: () => {
      void session.close().catch(() => {});
      settle?.({ exitCode: null });
    },
    exit: exit.finally(() => void session.close().catch(() => {})),
  };
}

/** Read a folder-relative path through the grant this page already holds.
 *
 *  This is how an extension's bundle reaches the shell: the host says where
 *  it put the file, and the page opens it itself. Nothing about the bytes
 *  rides a session — the same one grant that carries the transport carries
 *  this, which is why opening a tab costs no frames. */
export async function readAt(path: string): Promise<string | null> {
  const dir = rootHandle;
  if (!dir) return null;
  const parts = path.split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p === "..") || parts.length === 0) return null;
  const name = parts.pop()!;
  let at: FileSystemDirectoryHandle = dir;
  try {
    for (const part of parts) at = await at.getDirectoryHandle(part);
    const file = await (await at.getFileHandle(name)).getFile();
    return await file.text();
  } catch {
    // Missing, or a torn read while the host was writing it (F11): both are
    // normal, and both mean "ask again" rather than "broken".
    return null;
  }
}

/** Leaving: close the session so the host reaps its directory (D6). */
export function closeOnPagehide(): void {
  session?.close().catch(() => {});
  session = null;
}
