// fsio control plane: JSON-RPC 2.0 messages riding RPC frames.
// (Adopted in spec/DECISIONS.md D10; wire rules in spec/PROTOCOL.md
// "Control plane".)
//
// Rules:
//   - one JSON-RPC message per RPC frame; no batch arrays (the chunk layer
//     already batches frames)
//   - requests get responses; notifications are fire-and-forget
//   - responses with unknown ids are ignored (they can legitimately be
//     duplicated, e.g. a restarted host re-answering spawn)
//
// Envelope cost (measured): ping 81 B framed, ack 65 B, resize 72 B,
// close 39 B — all within the 180 B dirname-lane budget (F10) with room
// to spare. DATA stays raw bytes in DATA frames; only control is JSON.

export const RpcErrors = {
  // JSON-RPC 2.0 predefined
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // fsio application errors (spec/PROTOCOL.md "Control plane")
  SHELL_NOT_ALLOWED: 1001,
  SPAWN_FAILED: 1002,
  UNKNOWN_KIND: 1003,
  /** host spawn policy (onSpawnRequest hook) refused the session (D12). */
  SPAWN_DENIED: 1004,
} as const;

/** Conventional id for the spawn request carried by spawn.json. */
export const SPAWN_REQUEST_ID = 0;

export type RpcId = number | string;

export interface RpcRequestMsg {
  jsonrpc: "2.0";
  id: RpcId;
  method: string;
  params?: unknown;
}

export interface RpcNotificationMsg {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface RpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcResponseMsg {
  jsonrpc: "2.0";
  id: RpcId | null;
  result?: unknown;
  error?: RpcErrorObject;
}

export type RpcMessage = RpcRequestMsg | RpcNotificationMsg | RpcResponseMsg;

export function rpcRequest(id: RpcId, method: string, params?: unknown): RpcRequestMsg {
  const msg: RpcRequestMsg = { jsonrpc: "2.0", id, method };
  if (params !== undefined) msg.params = params;
  return msg;
}

export function rpcNotification(method: string, params?: unknown): RpcNotificationMsg {
  const msg: RpcNotificationMsg = { jsonrpc: "2.0", method };
  if (params !== undefined) msg.params = params;
  return msg;
}

export function rpcResult(id: RpcId, result: unknown): RpcResponseMsg {
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(id: RpcId | null | undefined, code: number, message: string, data?: unknown): RpcResponseMsg {
  const error: RpcErrorObject = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error };
}

export class RpcError extends Error {
  code: number;
  data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

/** A settled response: the result plus its receive timestamp (for latency
 *  accounting — e.g. the bench's t3 leg). */
export interface RpcReply<R = unknown> {
  result: R;
  rx: number;
}

interface Pending {
  resolve: (reply: RpcReply) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Request/response correlation over any frame transport. The caller
 *  supplies `send(msg)`; incoming RPC frames are fed to handleMessage().
 *  This replaces the seq/pending-map idiom previously hand-rolled in the
 *  web bench, the node bench, and the observer lab. */
export class RpcEndpoint {
  private _send: (msg: RpcRequestMsg | RpcNotificationMsg) => void;
  private _nextId = 1;
  private _pending = new Map<RpcId, Pending>();

  constructor(send: (msg: RpcRequestMsg | RpcNotificationMsg) => void) {
    this._send = send;
  }

  /** Send a request. Resolves {result, rx}; rejects with RpcError on an
   *  error response, or Error on timeout. */
  request<R = unknown>(method: string, params?: unknown, { timeoutMs = 0 } = {}): Promise<RpcReply<R>> {
    const id = this._nextId++;
    const promise = this.expect<R>(id, { timeoutMs });
    try {
      this._send(rpcRequest(id, method, params));
    } catch (e) {
      this._settle(id)?.reject(e instanceof Error ? e : new Error(String(e)));
    }
    return promise;
  }

  /** Await a response for a request sent out of band (e.g. the spawn
   *  request that rides spawn.json rather than a frame). */
  expect<R = unknown>(id: RpcId, { timeoutMs = 0 } = {}): Promise<RpcReply<R>> {
    return new Promise<RpcReply>((resolve, reject) => {
      const entry: Pending = { resolve, reject, timer: null };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this._settle(id)?.reject(new Error(`rpc timeout: no response for id ${id} in ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this._pending.set(id, entry);
    }) as Promise<RpcReply<R>>;
  }

  notify(method: string, params?: unknown): void {
    this._send(rpcNotification(method, params));
  }

  /** Feed one incoming JSON-RPC message. Returns true if it was a response
   *  and has been consumed (matched or ignored); false if it is a request
   *  or notification the caller should dispatch. */
  handleMessage(msg: unknown, rx: number = Date.now()): boolean {
    if (!msg || typeof msg !== "object") return false;
    const m = msg as Partial<RpcResponseMsg> & { method?: string };
    if (m.method !== undefined) return false;
    if (m.id === undefined || m.id === null) return true; // malformed/unroutable response: drop
    const entry = this._settle(m.id);
    if (!entry) return true; // duplicate/unknown response: ignore by design
    if (m.error) entry.reject(new RpcError(m.error.code, m.error.message, m.error.data));
    else entry.resolve({ result: m.result, rx });
    return true;
  }

  /** Reject everything in flight (endpoint shutting down). */
  failAll(err: Error = new Error("rpc endpoint closed")): void {
    for (const id of [...this._pending.keys()]) this._settle(id)?.reject(err);
  }

  private _settle(id: RpcId): Pending | null {
    const entry = this._pending.get(id);
    if (!entry) return null;
    this._pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    return entry;
  }
}
