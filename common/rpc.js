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
};

// Conventional id for the spawn request carried by spawn.json.
export const SPAWN_REQUEST_ID = 0;

export function rpcRequest(id, method, params) {
  const msg = { jsonrpc: "2.0", id, method };
  if (params !== undefined) msg.params = params;
  return msg;
}

export function rpcNotification(method, params) {
  const msg = { jsonrpc: "2.0", method };
  if (params !== undefined) msg.params = params;
  return msg;
}

export function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error };
}

export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

// Request/response correlation over any frame transport. The caller
// supplies `send(msg)`; incoming RPC frames are fed to handleMessage().
// This replaces the seq/pending-map idiom previously hand-rolled in the
// web bench, the node bench, and the observer lab.
export class RpcEndpoint {
  /** @param {(msg: object) => void} send transmit one JSON-RPC message */
  constructor(send) {
    this._send = send;
    this._nextId = 1;
    this._pending = new Map(); // id -> {resolve, reject, timer}
  }

  /** Send a request. Resolves {result, rx} where rx is the receive
   *  timestamp passed to handleMessage (for latency accounting); rejects
   *  with RpcError on an error response, or Error on timeout. */
  request(method, params, { timeoutMs = 0 } = {}) {
    const id = this._nextId++;
    const promise = this.expect(id, { timeoutMs });
    try {
      this._send(rpcRequest(id, method, params));
    } catch (e) {
      this._settle(id)?.reject(e);
    }
    return promise;
  }

  /** Await a response for a request sent out of band (e.g. the spawn
   *  request that rides spawn.json rather than a frame). */
  expect(id, { timeoutMs = 0 } = {}) {
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this._settle(id)?.reject(new Error(`rpc timeout: no response for id ${id} in ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this._pending.set(id, entry);
    });
  }

  notify(method, params) {
    this._send(rpcNotification(method, params));
  }

  /** Feed one incoming JSON-RPC message. Returns true if it was a response
   *  and has been consumed (matched or ignored); false if it is a request
   *  or notification the caller should dispatch. */
  handleMessage(msg, rx = Date.now()) {
    if (!msg || typeof msg !== "object" || msg.method !== undefined) return false;
    const entry = this._settle(msg.id);
    if (!entry) return true; // duplicate/unknown response: ignore by design
    if (msg.error) entry.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
    else entry.resolve({ result: msg.result, rx });
    return true;
  }

  /** Reject everything in flight (endpoint shutting down). */
  failAll(err = new Error("rpc endpoint closed")) {
    for (const id of [...this._pending.keys()]) this._settle(id)?.reject(err);
  }

  _settle(id) {
    const entry = this._pending.get(id);
    if (!entry) return null;
    this._pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    return entry;
  }
}
