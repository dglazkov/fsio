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
//
// Sticky sessions (#113/D32) add one thing here, and only one: this peer now
// knows whether the message it is delivering is *live* or *replayed
// scrollback*. It does not know what that ought to mean — that judgement is
// agent.ts's, because it is about permission cards and file writes, not
// about JSON-RPC. What this file owes the layer above is the three facts it
// cannot recover on its own: which direction in time a message came from,
// where it sits in the stream, and whose id space it belongs to.
import type { FsioSession } from "@fsio/client";
import { firstIdForEpoch } from "../src/resume.js";

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

/** Where in time (and in the stream) an incoming message came from. Every
 *  handler gets one; a connection that never replayed anything reports
 *  `replayed: false` forever, which is exactly what a fresh spawn wants. */
export interface Origin {
  /** true while re-emitting the session's history (D18 scrollback). */
  replayed: boolean;
  /** position of this message in the out stream, counted in DATA frames
   *  from the start of the replayed segment. The anchor prompts are woven
   *  back against (resume.ts). */
  index: number;
  /** the request's JSON-RPC id, for handlers that must remember whether
   *  they answered it. Undefined for notifications. */
  id?: string | number;
}

/** A request handler's way of saying "rendered, but say nothing on the
 *  wire" — the replayed permission card that was already answered before
 *  the page left. Sending a second response would be harmless (the agent
 *  ignores unknown ids) but it would also be a lie about what this page
 *  knows, and the next reader of this code deserves the honest version. */
export const NO_RESPONSE = Symbol("no-response");

export type RequestHandler = (params: Params, origin: Origin) => Promise<unknown> | unknown;
export type NotificationHandler = (params: Params, origin: Origin) => void;

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
  /** called once per incoming DATA frame, BEFORE it is dispatched — the
   *  hook a rebuild uses to slot the human's turns between the agent's
   *  (resume.ts). `index` is that frame's position in the stream. */
  onFrame?: (index: number, replayed: boolean) => void;
  /** replay bracket (D18): `true` when the library starts re-emitting the
   *  session's history, `false` when it is back to live traffic. */
  onReplay?: (replaying: boolean, gen: number) => void;
}

export class AcpConnection {
  /** null = no wire (#119): a transcript being read back from the folder.
   *  Nothing is sent, because there is nobody to send it to — the agent
   *  that spoke these words exited before this page loaded. */
  #session: FsioSession | null;
  #opts: AcpConnectionOptions;
  #nextId = 1;
  #pending = new Map<string | number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  #requests = new Map<string, RequestHandler>();
  #notifications = new Map<string, NotificationHandler>();
  #closed = false;
  #replaying = false;
  /** ids inherited from the connection this one replaced (#113): a
   *  `session/prompt` the previous page sent and never heard back about.
   *  These are the ONLY ids a replayed response is allowed to settle. */
  #adopted = new Set<string | number>();
  #frames = 0;

  constructor(session: FsioSession | null, opts: AcpConnectionOptions = {}) {
    this.#session = session;
    this.#opts = opts;
    // A stored transcript (#119): every frame is history by construction —
    // there is no live phase to switch into — and they arrive through
    // `feed()` rather than from a session that is streaming them.
    if (!session) {
      this.#replaying = true;
      return;
    }
    session.on("data", (bytes) => this.#deliver(bytes));
    session.on("replay", (phase, gen) => {
      this.#replaying = phase === "start";
      this.#opts.onReplay?.(this.#replaying, gen);
    });
    session.on("status", (st) => {
      if (st.state === "exited" || st.state === "error") this.#failAll(new Error(`agent ${st.state}`));
    });
  }

  /** DATA frames delivered so far — the page's position in the out stream,
   *  and the anchor stamped on every prompt it sends. */
  get frameIndex(): number {
    return this.#frames;
  }

  /** Push one recorded DATA frame through the same dispatch live traffic
   *  takes (#119). Deliberately the same path and not a parallel one: a
   *  second interpretation of the same bytes would drift from this one, and
   *  the day it did, the version people read after the fact would be the
   *  wrong version. */
  feed(bytes: Uint8Array): void {
    this.#deliver(bytes);
  }

  /** Partition this connection's id space by the host's writer epoch (D18),
   *  so a response to the *previous* page's request can never be mistaken
   *  for an answer to one of ours. Call before the first `request()`. */
  seedIds(epoch: number): void {
    this.#nextId = firstIdForEpoch(epoch);
  }

  /** Take over a request the previous connection left in flight. The agent
   *  is still working on it and will answer to that id — on this
   *  connection, because there is only one stream. Without this the reply is
   *  an unknown id and the turn it belongs to never ends. */
  adopt<T = unknown>(id: number): Promise<T> {
    this.#adopted.add(id);
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
  }

  /** client → agent request. */
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.requestTracked<T>(method, params).result;
  }

  /** `request`, plus the id it used. A caller that may have to *reclaim*
   *  this request after a refresh (the prompt whose turn outlives the page)
   *  has to be able to write that id down. */
  requestTracked<T = unknown>(method: string, params?: Record<string, unknown>): { id: number; result: Promise<T> } {
    const id = this.#nextId++;
    if (this.#closed) return { id, result: Promise.reject(new Error("connection closed")) };
    const msg = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
    const result = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#send(msg);
    });
    return { id, result };
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
    // No wire, no send. Reading a transcript must not be able to write one
    // byte anywhere, and the enforcement is here rather than in every
    // handler that might forget (#119).
    if (!this.#session) return;
    this.#opts.onTraffic?.("out", msg);
    // One message, one frame — `sendData` is a single DATA frame, and the
    // host refuses anything carrying more than one line.
    this.#session.sendData(JSON.stringify(msg));
  }

  #deliver(bytes: Uint8Array): void {
    // Counted before anything can go wrong with it: the index is a position
    // in the stream, not a count of messages we understood, or a refused
    // frame would shift every anchor after it.
    const index = this.#frames++;
    const replayed = this.#replaying;
    this.#opts.onFrame?.(index, replayed);
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

    const origin: Origin = { replayed, index, ...(msg.id === undefined ? {} : { id: msg.id }) };

    if (msg.method !== undefined) {
      if (msg.id === undefined) {
        const fn = this.#notifications.get(msg.method);
        if (fn) fn(msg.params, origin);
        else this.#opts.onUnhandled?.(msg.method, msg.params);
        return;
      }
      void this.#answer(msg.id, msg.method, msg.params, origin);
      return;
    }

    if (msg.id === undefined) return;
    // A replayed response belongs to the connection that sent the request,
    // and that connection is gone. Settling one of ours against it would be
    // an id collision with a plausible-looking payload — the exact hazard
    // D18 cites for never re-correlating replayed RPC frames. The one
    // exception is an id this connection deliberately inherited (`adopt`),
    // where the mismatch is the point.
    if (replayed && !this.#adopted.has(msg.id)) return;
    const waiter = this.#pending.get(msg.id);
    if (!waiter) return; // unknown id: legal to ignore, same as the control plane
    this.#pending.delete(msg.id);
    this.#adopted.delete(msg.id);
    if (msg.error) waiter.reject(new AcpRequestError(msg.error));
    else waiter.resolve(msg.result);
  }

  async #answer(id: string | number, method: string, params: Params, origin: Origin): Promise<void> {
    const fn = this.#requests.get(method);
    if (!fn) {
      this.#opts.onUnhandled?.(method, params);
      // Silence on replay: the previous connection already refused this, and
      // the agent has long since read that refusal.
      if (!origin.replayed) this.#send({ jsonrpc: "2.0", id, error: { code: -32601, message: `no handler in this client for ${method}` } });
      return;
    }
    try {
      const result = await fn(params, origin);
      if (result === NO_RESPONSE) return;
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
