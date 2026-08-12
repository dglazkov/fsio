export declare const RpcErrors: {
    readonly PARSE_ERROR: -32700;
    readonly INVALID_REQUEST: -32600;
    readonly METHOD_NOT_FOUND: -32601;
    readonly INVALID_PARAMS: -32602;
    readonly INTERNAL_ERROR: -32603;
    readonly SHELL_NOT_ALLOWED: 1001;
    readonly SPAWN_FAILED: 1002;
    readonly UNKNOWN_KIND: 1003;
    /** host spawn policy (onSpawnRequest hook) refused the session (D12). */
    readonly SPAWN_DENIED: 1004;
    /** attach refused: session exited or not attachable (D18). */
    readonly ATTACH_FAILED: 1005;
    /** hub deployment (D22): `workspace` names no entry this host can
     *  resolve, or none this client may see. Reserved here so the numbers
     *  stay stable — no shipped host emits 1006/1007 yet (#71). */
    readonly UNKNOWN_WORKSPACE: 1006;
    /** hub deployment (D23): no valid grant covers the request. Absent,
     *  expired, invalid, and revoked are deliberately one code — the
     *  client's next move (ask for consent) is the same for all four. */
    readonly GRANT_REQUIRED: 1007;
};
/** Conventional id for the spawn request carried by spawn.json. */
export declare const SPAWN_REQUEST_ID = 0;
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
export declare function rpcRequest(id: RpcId, method: string, params?: unknown): RpcRequestMsg;
export declare function rpcNotification(method: string, params?: unknown): RpcNotificationMsg;
export declare function rpcResult(id: RpcId, result: unknown): RpcResponseMsg;
export declare function rpcError(id: RpcId | null | undefined, code: number, message: string, data?: unknown): RpcResponseMsg;
export declare class RpcError extends Error {
    code: number;
    data: unknown;
    constructor(code: number, message: string, data?: unknown);
}
/** A settled response: the result plus its receive timestamp (for latency
 *  accounting — e.g. the bench's t3 leg). */
export interface RpcReply<R = unknown> {
    result: R;
    rx: number;
}
/** Request/response correlation over any frame transport. The caller
 *  supplies `send(msg)`; incoming RPC frames are fed to handleMessage().
 *  This replaces the seq/pending-map idiom previously hand-rolled in the
 *  web bench, the node bench, and the observer lab. */
export declare class RpcEndpoint {
    private _send;
    private _nextId;
    private _pending;
    constructor(send: (msg: RpcRequestMsg | RpcNotificationMsg) => void);
    /** Send a request. Resolves {result, rx}; rejects with RpcError on an
     *  error response, or Error on timeout. */
    request<R = unknown>(method: string, params?: unknown, { timeoutMs }?: {
        timeoutMs?: number | undefined;
    }): Promise<RpcReply<R>>;
    /** Await a response for a request sent out of band (e.g. the spawn
     *  request that rides spawn.json rather than a frame). */
    expect<R = unknown>(id: RpcId, { timeoutMs }?: {
        timeoutMs?: number | undefined;
    }): Promise<RpcReply<R>>;
    notify(method: string, params?: unknown): void;
    /** Feed one incoming JSON-RPC message. Returns true if it was a response
     *  and has been consumed (matched or ignored); false if it is a request
     *  or notification the caller should dispatch. */
    handleMessage(msg: unknown, rx?: number): boolean;
    /** Reject everything in flight (endpoint shutting down). */
    failAll(err?: Error): void;
    private _settle;
}
//# sourceMappingURL=rpc.d.ts.map