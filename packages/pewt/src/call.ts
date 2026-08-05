// One call, from a terminal, over the folder.
//
// The command line is an fsio client in its own right: per invocation it
// opens a session, calls one method, reads the answer, and closes. There is
// no socket, no port, and no state of its own.
//
// It is a function rather than inline in cli.ts so the end-to-end test calls
// exactly what ships (the actuator demo learned this first — its
// `actuate()` has the same shape and the same reason).
import { FsioClient, RpcError, type FsDirectory } from "@fsio/client";

/** What went wrong, in the two categories that need different fixes.
 *
 *  `no_host` is the narrative's exit 3. Exit 4 — no page open — belongs to
 *  the operations only a page can answer, and this skeleton has none of
 *  those yet (https://github.com/dglazkov/fsio/issues/165). */
export class CallError extends Error {
  constructor(
    readonly reason: "no_host" | "refused" | "timeout" | "transport",
    message: string,
    readonly code?: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = "CallError";
  }
}

export interface CallOptions {
  timeoutMs?: number;
  pollMs?: number;
}

/** A client on a folder with a live host in it, or the reason there is none.
 *
 *  Shared by the two things a command can be: a call that has one answer
 *  (below) and a run that has a stream (stream.ts). Both start the same way,
 *  and "no host is running" has to read identically whichever one asked. */
export async function connect(dir: FsDirectory): Promise<FsioClient> {
  const client = new FsioClient(dir);

  // Probe for `.fsio` WITHOUT creating it: connect() would create one in
  // whatever directory was named, so a pewter with no host running would be
  // told "no answer" while quietly acquiring the plumbing of one.
  await dir.getDirectoryHandle(".fsio").catch(() => {
    throw new CallError("no_host", "no host is running in this pewter", undefined, "start one: npm start");
  });

  const host = await client.connect().catch((e: unknown) => {
    throw new CallError("transport", `cannot read the folder: ${e instanceof Error ? e.message : String(e)}`);
  });
  if (!host.alive) {
    throw new CallError(
      "no_host",
      host.info ? `the host stopped (last heartbeat ${Math.round(host.ageMs / 1000)}s ago)` : "no host is running in this pewter",
      undefined,
      "start one: npm start"
    );
  }
  return client;
}

export async function call(dir: FsDirectory, method: string, params: unknown, opts: CallOptions = {}): Promise<unknown> {
  const client = await connect(dir);
  const session = client.createSession({ kind: "pewt", client: "pewt-cli" }, { pollMs: opts.pollMs ?? 15, heartbeatMs: 0 });
  try {
    await session.ready.catch((e: unknown) => {
      throw new CallError("transport", e instanceof Error ? e.message : String(e));
    });
    const { result } = await session.request(method, params, { timeoutMs: opts.timeoutMs ?? 30_000 });
    return result;
  } catch (e) {
    if (e instanceof CallError) throw e;
    if (e instanceof RpcError) {
      // The operation's own code and hint ride in `data` — the JSON-RPC code
      // says only which kind of wrong it is (kind.ts).
      const data = (e.data ?? {}) as { code?: string; hint?: string };
      throw new CallError("refused", e.message, data.code, data.hint);
    }
    throw new CallError("timeout", e instanceof Error ? e.message : String(e));
  } finally {
    // The host owns the session directory (D6); close() only says we are done.
    await session.close().catch(() => {});
  }
}
