// The thin wrapper (D30): ACP messages over a session's DATA frames.
//
// Thin is the whole claim. There is no buffer here, no line splitting, no
// "did we get half a message" state — because the host promised that one
// DATA frame is exactly one complete ACP message, in both directions. If
// that promise were made in the page instead, this file would own a
// reassembly buffer and every consumer of it would inherit the bug.
//
// So what is left is only what a JSON-RPC peer must do: correlate ids,
// answer requests, deliver notifications. Note that this is a *peer*, not a
// client — ACP is bidirectional, and the interesting direction is the one
// coming at us (`session/request_permission`, `fs/read_text_file`). fsio's
// own control plane is a different endpoint entirely, on RPC frames, in the
// library; nothing here can reach it, which is the point.
import type { FsioSession } from "@fsio/client";

export interface AcpError {
  code: number;
  message: string;
  data?: unknown;
}

export class AcpRequestError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(err: AcpError) {
    super(err.message);
    this.name = "AcpRequestError";
    this.code = err.code;
    this.data = err.data;
  }
}

type Params = Record<string, unknown> | undefined;
export type RequestHandler = (params: Params) => Promise<unknown> | unknown;
export type NotificationHandler = (params: Params) => void;

interface Incoming {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: AcpError;
}

export interface AcpConnectionOptions {
  /** every message, in either direction — the transcript/diagnostics feed. */
  onTraffic?: (dir: "in" | "out", msg: unknown) => void;
  /** an incoming request nobody registered a handler for. */
  onUnhandled?: (method: string, params: Params) => void;
}

export class AcpConnection {
  #session: FsioSession;
  #opts: AcpConnectionOptions;
  #nextId = 1;
  #pending = new Map<string | number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  #requests = new Map<string, RequestHandler>();
  #notifications = new Map<string, NotificationHandler>();
  #closed = false;

  constructor(session: FsioSession, opts: AcpConnectionOptions = {}) {
    this.#session = session;
    this.#opts = opts;
    session.on("data", (bytes) => this.#deliver(bytes));
    session.on("status", (st) => {
      if (st.state === "exited" || st.state === "error") this.#failAll(new Error(`agent ${st.state}`));
    });
  }

  /** client → agent request. */
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("connection closed"));
    const id = this.#nextId++;
    const msg = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#send(msg);
    });
  }

  /** client → agent notification (`session/cancel`, …). */
  notify(method: string, params?: Record<string, unknown>): void {
    this.#send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  /** Answer an agent → client request. This is where the demo lives:
   *  `session/request_permission` and `fs/*` land here. */
  onRequest(method: string, fn: RequestHandler): void {
    this.#requests.set(method, fn);
  }

  onNotification(method: string, fn: NotificationHandler): void {
    this.#notifications.set(method, fn);
  }

  close(): void {
    this.#closed = true;
    this.#failAll(new Error("connection closed"));
  }

  #send(msg: unknown): void {
    this.#opts.onTraffic?.("out", msg);
    // One message, one frame — `sendData` is a single DATA frame, and the
    // host refuses anything carrying more than one line.
    this.#session.sendData(JSON.stringify(msg));
  }

  #deliver(bytes: Uint8Array): void {
    const text = new TextDecoder().decode(bytes);
    let msg: Incoming;
    try {
      msg = JSON.parse(text) as Incoming;
    } catch {
      // Unreachable by contract (the host validated it), which is exactly
      // why it must be reported rather than swallowed: it would mean the
      // framing promise broke.
      this.#opts.onUnhandled?.("(unparseable frame)", { text } as Record<string, unknown>);
      return;
    }
    this.#opts.onTraffic?.("in", msg);

    if (msg.method !== undefined) {
      if (msg.id === undefined) {
        const fn = this.#notifications.get(msg.method);
        if (fn) fn(msg.params);
        else this.#opts.onUnhandled?.(msg.method, msg.params);
        return;
      }
      void this.#answer(msg.id, msg.method, msg.params);
      return;
    }

    if (msg.id === undefined) return;
    const waiter = this.#pending.get(msg.id);
    if (!waiter) return; // unknown id: legal to ignore, same as the control plane
    this.#pending.delete(msg.id);
    if (msg.error) waiter.reject(new AcpRequestError(msg.error));
    else waiter.resolve(msg.result);
  }

  async #answer(id: string | number, method: string, params: Params): Promise<void> {
    const fn = this.#requests.get(method);
    if (!fn) {
      this.#opts.onUnhandled?.(method, params);
      this.#send({ jsonrpc: "2.0", id, error: { code: -32601, message: `no handler in this client for ${method}` } });
      return;
    }
    try {
      const result = await fn(params);
      this.#send({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (e) {
      const err = e as { code?: number; message?: string };
      this.#send({
        jsonrpc: "2.0",
        id,
        error: { code: typeof err.code === "number" ? err.code : -32603, message: err.message ?? String(e) },
      });
    }
  }

  #failAll(e: Error): void {
    for (const [, w] of this.#pending) w.reject(e);
    this.#pending.clear();
  }
}
