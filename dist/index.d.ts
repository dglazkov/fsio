import { FrameType, jsonFrame, decodeJson, now, RpcError, RpcErrors, type Frame, type HostInfo, type SessionStatus, type SpawnResult, type SpawnSpec, type AttachResult, type PingResult, type ServicesDoc } from "@fsio/common";
import type { FsDirectory, FsFile, FsSnapshot, FsWritable } from "./fs.js";
export { FrameType, jsonFrame, decodeJson, now, RpcError, RpcErrors };
export type { Frame, HostInfo, SessionStatus, SpawnResult, SpawnSpec, AttachResult, PingResult };
export type { FsDirectory, FsFile, FsSnapshot, FsWritable };
export declare const hasObserver: boolean;
type DirLaneState = "on" | "slow" | "broken";
export declare function op<T>(label: string, fn: () => Promise<T>): Promise<T>;
export type NotifierMode = "auto" | "adaptive" | "hybrid" | "poll" | "observer";
export type UplinkMode = "auto" | "file" | "dirname";
export interface SessionOptions {
    mode?: NotifierMode;
    /** Hot-poll cadence. Default 15 (D16): p50 RTT ≈ pollMs, and 15 halves
     *  the streaming CPU burn vs 5 while staying under one display frame
     *  (F18). Latency-critical embedders can pass 5 — but note the wake
     *  loop self-saturates at pollMs ≈ wake duration (~4 ms on a fast
     *  machine), so lower values mostly buy CPU burn, not latency. */
    pollMs?: number;
    uplink?: UplinkMode;
    /** 0 disables the safety poll (measurement labs) */
    safetyMs?: number;
    /** Presence-beacon cadence (D17): a `heartbeat` notification every this
     *  many ms lets the host distinguish "client thinking" from "client
     *  gone" (detach marking / precise GC). Default 20s — background tabs
     *  clamp timers to 1/min (F16), and the host's detach window (3 min
     *  default) tolerates that. 0 disables (labs, legacy behavior). */
    heartbeatMs?: number;
    /** Dirname-lane probe tuning (#4) — injectable so tests run the latch
     *  logic at short timescales. Defaults are the shipped thresholds. */
    uplinkLane?: {
        slowMs?: number;
        reprobeMs?: number;
    };
    /** Bound on observer startup settling before the notifier downgrades to
     *  polling (F19: a stalled observe() must not gate `ready`). Default
     *  2000; injectable so tests run the guard at short timescales. */
    observeSettleMs?: number;
}
export interface SessionEventMap {
    /** Every delivered frame (including DATA). RPC responses are consumed by
     *  the control plane and do not appear here. */
    frame: [frame: Frame, at: number];
    /** Payload of each DATA frame — the one obvious way to consume output. */
    data: [bytes: Uint8Array];
    /** Scrollback replay boundaries (D18), emitted only when
     *  `attachSession(id, {replay: true})` asked for them. Every `frame`/`data`
     *  event between `"start"` and `"end"` is re-emitted history, not live
     *  traffic — a consumer that must not re-run side effects (an ACP client
     *  re-executing the agent's file writes, #113) can only tell the two apart
     *  here. `gen` names the out segment that was replayed: replay is
     *  head-segment-only (D26, #57), so a `gen` higher than the one a previous
     *  visit saw means older history was rotated away and the re-emission is a
     *  suffix, not the whole stream. The bracket is emitted even when there is
     *  nothing to replay, so the state machine stays symmetric. */
    replay: [phase: "start" | "end", gen: number];
    /** status.json changed (deep-compared). */
    status: [status: SessionStatus];
    /** Non-fatal observations, e.g. observer fallback to polling (D7). */
    note: [note: string];
    /** Async failures the library can't throw at you synchronously: uplink
     *  commit errors, throwing event listeners. With no error listener these
     *  are re-thrown on a fresh stack (uncaught, visible). */
    error: [error: Error];
}
export declare class FsioClient {
    readonly root: FsDirectory;
    fsioDir: FsDirectory;
    sessionsDir: FsDirectory;
    /** last-read service directory, refreshed when `servicesRev` moves (D24). */
    private servicesDoc;
    constructor(rootHandle: FsDirectory);
    connect(): Promise<{
        alive: boolean;
        ageMs: number;
        info: HostInfo | null;
    }>;
    /** Reads host.json; returns {alive, info, ageMs} */
    hostInfo(): Promise<{
        alive: boolean;
        ageMs: number;
        info: HostInfo | null;
    }>;
    /** Read the service directory (D24): what this host can do, which kinds
     *  it serves, and the workspace **names** it advertises (never paths).
     *
     *  The doorbell is `host.json`'s `servicesRev` (D3's hot-pointer/cold-state
     *  split): a client already statting the heartbeat passes that revision
     *  here and gets its cached copy back untouched unless the number moved.
     *  Feature-detect on `capabilities` names, not on `protocol` ranges, and
     *  treat an unknown name as "not supported", never as an error (D25). */
    services(rev?: number): Promise<ServicesDoc | null>;
    /** Sugar for the D25 handshake: is this capability name advertised? */
    hasCapability(name: string, rev?: number): Promise<boolean>;
    /** Synchronous by design (D11): the caller gets a listener-attachment
     *  window before any event can possibly fire. All async init failures
     *  (folder creation, spawn.json commit) reject `session.ready`. */
    createSession(spec: SpawnSpec, opts?: SessionOptions): FsioSession;
    /** Enumerate sessions in the shared dir (D18 discovery) — read-only, the
     *  reattach picker's data source. `status.detached` marks orphans;
     *  `status.writer` names the current uplink owner. */
    listSessions(): Promise<SessionSummary[]>;
    /** Attach to an existing session (D18). Semantics: TAKEOVER — the grant
     *  bumps the writer epoch, moves the uplink to `in.<epoch>/`, and fences
     *  the previous client (it observes `writer` in status.json and stops
     *  sending). `replay: true` re-emits the head segment's DATA frames
     *  (scrollback) before live output. `ready` resolves with the
     *  AttachResult (kind, pid, epoch, …) or rejects with a coded RpcError
     *  (1005 exited, 1001/1004 policy denial). */
    attachSession(sessionId: string, opts?: SessionOptions & {
        replay?: boolean;
        client?: string;
    }): FsioSession;
}
/** One row of `FsioClient.listSessions()` (D18 discovery). */
export interface SessionSummary {
    id: string;
    /** null when spawn.json was unreadable (session mid-creation or corrupt). */
    kind: string | null;
    client?: string | undefined;
    origin?: string | undefined;
    /** null before the host has recorded an outcome. */
    status: SessionStatus | null;
}
export declare class FsioSession {
    #private;
    readonly id: string;
    readonly pollMs: number;
    readonly uplink: UplinkMode;
    readonly safetyMs: number;
    readonly heartbeatMs: number;
    /** Resolves with the spawn result; rejects with RpcError on spawn failure
     *  (and with the underlying error on init failure). */
    readonly ready: Promise<SpawnResult>;
    stats: {
        chunksWritten: number;
        /** chunks that rode the dirname fast lane vs. file chunks (#4: the
         *  auto lane's fallback dynamics are a measured quantity) */
        dirChunks: number;
        fileChunks: number;
        bytesIn: number;
        bytesOut: number;
        wakeups: number;
        staleReads?: number;
        /** uplink commits that failed transiently and were retried (#37) */
        commitRetries?: number;
        /** #4 lane probe: commit-latency EWMAs (ms) per lane. File is seeded
         *  by the spawn.json/attach.json commit, so the baseline exists
         *  before the first chunk. */
        dirCommitMs?: number;
        fileCommitMs?: number;
        /** dirname lane health (auto mode): on | slow (re-probed) | broken */
        dirLane?: DirLaneState;
        /** dir-lane commits that had to re-land as file chunks (#4) */
        laneFallbacks?: number;
    };
    /** Effective notifier mode; may downgrade at init (observer refusal, D7). */
    get mode(): NotifierMode;
    get status(): SessionStatus | null;
    get closed(): boolean;
    /** Writer epoch this client owns (D18): 0 = spawning client; attachers
     *  get theirs from the grant. A higher epoch in status.json means this
     *  client has been superseded. */
    get epoch(): number;
    constructor(id: string, sessionsDir: FsDirectory, spec: SpawnSpec | null, opts?: SessionOptions, attach?: {
        replay: boolean;
        client?: string | undefined;
    });
    /** Subscribe; returns the unsubscribe function (disposal, D11). All
     *  listeners are dropped on close(). */
    on<K extends keyof SessionEventMap>(type: K, listener: (...args: SessionEventMap[K]) => void): () => void;
    /** Enqueue a frame; frames queued while a commit is in flight are batched
     *  into a single chunk file. Commits are strictly serialized. */
    send(type: number, payload: Uint8Array): void;
    sendJson(type: number, obj: unknown): void;
    sendData(text: string): void;
    /** JSON-RPC request to the host; resolves {result, rx}. */
    request<R = unknown>(method: string, params?: unknown, opts?: {
        timeoutMs?: number;
    }): Promise<import("@fsio/common").RpcReply<R>>;
    /** JSON-RPC notification (fire-and-forget: resize, ack, close…). */
    notify(method: string, params?: unknown): void;
    /** Uncommitted uplink chunks in this writer's in-dir (labs; #4). */
    uplinkBacklog(): Promise<number>;
    /** Resolve when status matches `pred`, reject after timeoutMs. */
    waitForStatus(pred: (status: SessionStatus) => boolean, timeoutMs?: number): Promise<SessionStatus>;
    close(): Promise<void>;
    /** Deliberate walk-away (D18): ask the host to mark the session detached
     *  NOW (no heartbeat-silence wait), then release local resources WITHOUT
     *  closing the session — the process keeps running for a later
     *  `attachSession()`. */
    detach(): Promise<void>;
}
//# sourceMappingURL=index.d.ts.map