export declare const PROTOCOL_VERSION = 0;
/** `.fsio/fsio.json` */
export interface FsioManifest {
    protocol: number;
}
/** `.fsio/host.json` — heartbeat, rewritten atomically every 2 s. */
export interface HostInfo {
    pid: number;
    protocol: number;
    allowShell: boolean;
    pty: boolean;
    startedAt: number;
    seq: number;
    t: number;
}
/** `sessions/<id>/out.sig` — doorbell + stream map (rename-committed). */
export interface OutSig {
    /** current segment number */
    gen: number;
    /** bytes in the current segment */
    size: number;
    /** final size of segment gen-1 (reader handoff point) */
    prevFinal: number;
    /** cumulative bytes ever appended (ack accounting) */
    total: number;
}
export type SessionState = "running" | "exited" | "error";
/** `sessions/<id>/status.json` — host-owned durable state record. */
export interface SessionStatus {
    t: number;
    state: SessionState;
    kind?: string;
    pid?: number;
    pty?: boolean;
    cmd?: string;
    exitCode?: number | null;
    error?: string;
    closedByClient?: boolean;
}
export interface EchoSpawn {
    kind: "echo";
    /** free-form client identification, diagnostics only */
    client?: string;
}
export interface ShellSpawn {
    kind: "shell";
    cols?: number;
    rows?: number;
    cmd?: string;
    args?: string[];
    cwd?: string;
    /** false forces the pipe fallback even when node-pty is available */
    pty?: boolean;
    client?: string;
}
export type SpawnSpec = EchoSpawn | ShellSpawn;
/** Result of a successful `spawn` request. */
export interface SpawnResult {
    kind: string;
    pid: number;
    pty?: boolean;
    cmd?: string;
}
export interface PingParams {
    t0: number;
    filler?: string;
}
/** Params echoed back plus host receive (t1) / append (t2) timestamps. */
export interface PingResult extends PingParams {
    t1: number;
    t2: number;
}
export interface ResizeParams {
    cols: number;
    rows: number;
}
export interface SignalParams {
    sig?: string;
}
export interface AckParams {
    total: number;
}
//# sourceMappingURL=protocol.d.ts.map