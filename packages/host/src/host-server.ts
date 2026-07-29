// fsio host as a library: `HostServer` attaches to <dir>/.fsio and serves
// sessions created by clients. The CLI (fsio-host.ts) is a thin wrapper.
//
// Inversion rationale (#17): embedders need constructor options instead of
// argv, a logger instead of console, injectable timings instead of file-scope
// constants (which also makes time-based behaviors integration-testable at
// short timescales — see TESTING.md), and start()/close() instead of
// process lifetime.

import fs from "node:fs";
import path from "node:path";
import { spawn as cpSpawn, type ChildProcess } from "node:child_process";
import {
  FrameType,
  frameTypeName,
  encodeFrame,
  decodeJson,
  parseFrames,
  now,
  CHUNK_RE,
  DIR_CHUNK_RE,
  b64urlDecode,
  RpcErrors,
  rpcResult,
  rpcError,
  PROTOCOL_VERSION,
  type Frame,
  type RpcId,
  type RpcResponseMsg,
  type FsioManifest,
  type HostInfo,
  type OutSig,
  type SessionStatus,
  type ShellSpawn,
  type SpawnResult,
  type AttachParams,
  type AttachResult,
  type PingResult,
  type ResizeParams,
  type SignalParams,
  type AckParams,
} from "@fsio/common";

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------- options

/** Leveled line logger (D14). Lines are for humans — machine-readable
 *  state lives in the protocol files and `listSessions()`. Structurally
 *  satisfied by `console`, so `logger: console` just works. */
export interface HostLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const SILENT_LOGGER: HostLogger = { info() {}, warn() {}, error() {} };

/** Read-only session snapshot (D14): what an embedder can see. Aligned
 *  with `SpawnRequestInfo` where the fields overlap. */
export interface SessionInfo {
  id: string;
  /** null until spawn.json has been read. */
  kind: string | null;
  /** free-form client tag from the spec (diagnostics only). */
  client?: string | undefined;
  /** web origin reported by the client (D15) — advisory, display-only. */
  origin?: string | undefined;
  /** adopted → pending (spawn policy, D12) → running → exited | done. */
  phase: SessionPhase;
  /** shell child pid; host pid for in-process kinds. */
  pid?: number;
  /** shell sessions: whether a real pty is attached. */
  pty?: boolean;
  /** host → client bytes appended / acked (flow-control state, D9). */
  bytesOut: number;
  bytesAcked: number;
  /** ms epoch of last uplink activity. */
  lastActivityAt: number;
  /** D17: heartbeat-aware client silent past detachAfterMs — session alive,
   *  awaiting the client's return (or reattach, #3 phase 2). */
  detached: boolean;
  /** ms epoch of the last consumed uplink chunk (presence, D17). */
  lastClientSeenAt: number;
  /** writer epoch (D18): 0 = spawning client, bumped per attach grant. */
  epoch: number;
}

export type SessionPhase = "adopted" | "pending" | "running" | "exited" | "done";

/** What a spawn policy gets to judge, beyond the raw spec: identity plus
 *  the *resolved* command — what would actually run, not what was asked
 *  for (a shell spec with no `cmd` means $SHELL; the hook must see that). */
export interface SpawnRequestInfo {
  sessionId: string;
  /** kind after defaulting ("echo" when the spec names none). */
  kind: string;
  /** true when this is an ATTACH to a live session (D18), not a spawn:
   *  the command already runs; what's being judged is the new client
   *  taking control of it. client/origin are the attacher's. */
  attach?: boolean;
  /** free-form client identification from the spec (diagnostics only —
   *  anything that can write the folder can claim anything; see #6). */
  client?: string | undefined;
  /** web origin reported by the client (D15) — same caveat: advisory,
   *  display-only, never an authorization input. */
  origin?: string | undefined;
  /** shell kinds only: the exact command/args/cwd that would run. */
  cmd?: string;
  args?: string[];
  cwd?: string;
  /** whether a real pty would be used (node-pty present and not opted out). */
  pty?: boolean;
}

/** `true`/`false` allow/deny; the object form attaches a client-visible
 *  reason and (rarely) a custom JSON-RPC error code (default 1004). */
export type SpawnDecision = boolean | { allow: boolean; reason?: string; code?: number };

// ---- registered kinds (D13): a kind is a set of RPC methods plus a DATA
// sink/source — "stdio-shaped bridge over files, bring your own semantics".

/** What a kind handler gets to work with. */
export interface KindContext {
  readonly sessionId: string;
  /** the spawn request's params, as sent (the kind defines their meaning). */
  readonly spec: Readonly<Record<string, unknown>>;
  /** append DATA to the session's out stream (host → client). */
  write(data: Uint8Array | string): void;
  /** report the session as exited (status.json); delivery to the kind
   *  stops. The session dir survives until the client's `close` (D6). */
  exit(exitCode?: number | null): void;
  /** session-prefixed logger. */
  log: HostLogger;
}

/** A live kind session, as returned by its handler. */
export interface KindSession {
  /** extra fields merged into the spawn result the client's `ready` sees. */
  result?: Record<string, unknown>;
  /** client → host DATA frames. */
  onData?: (bytes: Uint8Array) => void;
  /** RPC methods (requests get the return value as the result; throw an
   *  object with `code`/`message` — e.g. common's RpcError — for coded
   *  errors). `ack` and `close` are host-reserved and never dispatched;
   *  an unhandled method falls back to the builtins (`ping`), then
   *  `-32601`. */
  methods?: Record<string, (params: unknown) => unknown | Promise<unknown>>;
  /** teardown: client close, host close(), or idle GC. Not called after
   *  the kind's own exit(). */
  onClose?: () => void;
}

/** Kind handler: runs per spawned session, after the spawn policy allowed
 *  it (D12). May be async; a throw/rejection fails the spawn (`1002`). */
export type KindHandler = (ctx: KindContext) => KindSession | Promise<KindSession>;

/** Spawn policy hook (D12): consulted for every spawn request, every kind.
 *  May return a promise — an async policy IS the confirmation mechanism
 *  (prompt a human, check an allow-list service…); the client just sees
 *  `ready` settle later. A throwing/rejecting policy denies (fail-safe).
 *  Replaces the `allowShell` boolean when provided. */
export type SpawnPolicy = (spec: Readonly<Record<string, unknown>>, info: SpawnRequestInfo) => SpawnDecision | Promise<SpawnDecision>;

/** Every time-based host behavior, injectable so tests can run them at
 *  short timescales (TESTING.md: "become testable when #17 makes the
 *  intervals injectable"). Defaults are the measured/spec'd values. */
export interface HostTimings {
  /** host.json heartbeat cadence (spec: liveness = mtime < 3 beats). */
  heartbeatMs?: number;
  /** slow safety poll backing up fs.watch. */
  safetyPollMs?: number;
  /** idle echo sessions are reaped after this long (workbench artifacts; #3). */
  idleGcMs?: number;
  /** how often the idle sweep runs. */
  idleSweepMs?: number;
  /** heartbeat-aware sessions whose client has been silent this long are
   *  detached (echo: reaped) — D17. Must exceed the browser's 1/min
   *  background timer clamp with margin (F16). */
  detachAfterMs?: number;
  /** stale exited sessions older than this are GC'd on adoption (spec: Session lifecycle). */
  staleGraceMs?: number;
  /** delay before deleting a closed session dir (lets the client stop watchers). */
  closeDelayMs?: number;
  /** fast retry when an uplink chunk looks torn/empty (invariant 3, F11). */
  retryMs?: number;
  /** close(): how long children get after SIGTERM before SIGKILL (D14). */
  killGraceMs?: number;
}

/** Flow control knobs (spec: segmented out log + ack window). */
export interface HostLimits {
  /** rotate out segment at this size. */
  segMax?: number;
  /** pause output when unacked bytes exceed this. */
  ackWindow?: number;
  /** resume when unacked drops below this. */
  ackResume?: number;
}

export interface HostServerOptions {
  /** the shared directory (the one the browser picks); `.fsio` lives inside. */
  root: string;
  /** permit `kind: "shell"` sessions (spawns processes!). Default false.
   *  Sugar for the static default policy; ignored when `onSpawnRequest`
   *  is provided. */
  allowShell?: boolean;
  /** spawn policy hook (D12); overrides `allowShell`. */
  onSpawnRequest?: SpawnPolicy;
  /** wipe .fsio on startup. Default false. Refused while another host is
   *  live on the directory (#40) — takeover applies here too. */
  fresh?: boolean;
  /** skip the live-host refusal (#40): seize a directory whose host.json
   *  still looks live — for a killed host whose last heartbeat hasn't gone
   *  stale yet. Default false. */
  takeover?: boolean;
  /** use fs.watch wakeups. Default true. */
  watch?: boolean;
  /** hot-poll interval while sessions are active (default 5, 0 = off; F2). */
  hotPollMs?: number;
  /** unconditional poll loop interval (default 0 = off). */
  pollMs?: number;
  logger?: HostLogger;
  /** pty provider (D14): a PtyModule to use, or `false` to force the pipe
   *  fallback. Default: auto-load node-pty if installed. */
  pty?: PtyModule | false;
  timings?: HostTimings;
  limits?: HostLimits;
}

const DEFAULT_TIMINGS: Required<HostTimings> = {
  heartbeatMs: 2000,
  safetyPollMs: 250,
  idleGcMs: 5 * 60_000,
  idleSweepMs: 30_000,
  detachAfterMs: 180_000,
  staleGraceMs: 60_000,
  closeDelayMs: 500,
  retryMs: 5,
  killGraceMs: 3000,
};

// A `find .` produced 60 MB of scrollback in one file with nothing telling
// the pty to slow down — hence segments + the ack window.
const DEFAULT_LIMITS: Required<HostLimits> = {
  segMax: 8 * 1024 * 1024,
  ackWindow: 4 * 1024 * 1024,
  ackResume: 2 * 1024 * 1024,
};

// Reporter dirs (#39): pages self-report under .fsio/client/<clientId>/, one
// dir per page load. Enough history for forensics; beyond this, stale dirs
// are swept (host owns .fsio cleanup — D6).
const CLIENT_DIR_CAP = 8;

// ---------------------------------------------------------------- helpers

function writeFileAtomic(file: string, data: string | Uint8Array): void {
  const tmp = path.join(path.dirname(file), `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function writeJsonAtomic(file: string, obj: unknown): void {
  writeFileAtomic(file, JSON.stringify(obj, null, 2));
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- node-pty (optional)

// Local minimal surface instead of node-pty's own types: the dependency is
// *optional*, and a missing optional dep must never break `npm run build`.
// (Hence also the variable specifier: keeps tsc from resolving the module.)
/** Minimal pty surface. Injectable via `HostServerOptions.pty` (D14):
 *  bring your own module (or a test fake — `onData`/`onExit` must accept
 *  multiple listeners). */
export interface PtyProcess {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
}

export interface PtyModule {
  spawn(
    file: string,
    args: string[],
    opts: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }
  ): PtyProcess;
}

let ptyModCache: PtyModule | null | undefined;

async function loadPty(): Promise<PtyModule | null> {
  if (ptyModCache !== undefined) return ptyModCache;
  try {
    const specifier = "node-pty";
    ptyModCache = (await import(specifier)) as PtyModule;
  } catch {
    ptyModCache = null;
  }
  return ptyModCache;
}

// ---------------------------------------------------------------- session

/** Spawn params as read from spawn.json — legacy bare specs mean we cannot
 *  trust the shape until `kind` is inspected. */
type SpawnParams = Partial<Omit<ShellSpawn, "kind">> & { kind?: string };

type RpcInbound = { id?: RpcId; method?: string; params?: unknown };

class Session {
  id: string;
  dir: string;
  spawn: SpawnParams | null = null; // params from the JSON-RPC request in spawn.json
  spawnId: RpcId | null = null; // request id to answer (null = legacy bare spec)
  spawnAnswered = false;
  started = false;
  approved = false; // spawn policy said yes (D12); gates incoming processing
  exited = false; // process/kind reported exit (session dir still readable, D6)
  done = false;
  nextInSeq: number | null = null; // discovered from the smallest chunk present
  // Output stream state: segmented log + cumulative byte accounting.
  outGen = 0; // current segment number
  segBytes = 0; // bytes in current segment
  prevFinal = 0; // final size of segment outGen-1 (for reader handoff)
  outTotal = 0; // cumulative bytes ever appended
  ackTotal = 0; // cumulative bytes the client has confirmed consuming
  paused = false; // output paused waiting for acks
  doneSegs: { gen: number; endTotal: number }[] = []; // finished segments
  proc: PtyProcess | ChildProcess | null = null;
  usesPty = false;
  kindSession: KindSession | null = null; // registered kinds (D13)
  watchers: (fs.FSWatcher | null)[] = [];
  retryTimer: ReturnType<typeof setTimeout> | null = null;
  lastActivity = Date.now();
  // Client-presence accounting (D17): any consumed uplink chunk counts as
  // "seen"; only clients that ever sent a heartbeat are judged by it —
  // legacy clients keep the pre-heartbeat behavior (blunt idle GC only).
  lastClientSeen = Date.now();
  heartbeatAware = false;
  detached = false;
  // Writer epoch (D18): 0 = the spawning client, uplink `in/`. Each attach
  // grant bumps it and moves the uplink to `in.<epoch>/` — the fence that
  // keeps one-writer-per-file true across takeovers (F8/D6).
  epoch = 0;
  private statusBase: Omit<SessionStatus, "t" | "detached"> | null = null;

  constructor(
    private host: HostServer,
    id: string
  ) {
    this.id = id;
    this.dir = path.join(host.sessionsDir, id);
  }

  /** Current writer's uplink dir (D18): `in/` for epoch 0, `in.<epoch>/`
   *  after an attach takeover. Only this dir is ever consumed. */
  get inDir(): string {
    return path.join(this.dir, this.epoch === 0 ? "in" : `in.${this.epoch}`);
  }

  get pty(): PtyProcess | null {
    return this.usesPty ? (this.proc as PtyProcess) : null;
  }

  get child(): ChildProcess | null {
    return this.usesPty || !this.proc ? null : (this.proc as ChildProcess);
  }

  segPath(gen: number): string {
    return path.join(this.dir, `out.${String(gen).padStart(8, "0")}.log`);
  }

  // Append with open/write/close per call, then bump a rename-committed
  // doorbell file. Rationale (measured, spec/FINDINGS.md F1): on macOS,
  // appends through a long-held fd are nearly invisible to FSEvents-backed
  // watchers — events fire on close() and renames, not on in-place writes.
  // Segments always rotate on frame boundaries (rotation happens between
  // appends), so every segment is independently parseable.
  appendFrame(type: number, payload: Uint8Array): void {
    const bytes = encodeFrame(type, payload);
    const fd = fs.openSync(this.segPath(this.outGen), "a");
    fs.writeSync(fd, bytes);
    fs.closeSync(fd);
    this.segBytes += bytes.length;
    this.outTotal += bytes.length;
    if (this.segBytes >= this.host.limits.segMax) {
      this.doneSegs.push({ gen: this.outGen, endTotal: this.outTotal });
      this.prevFinal = this.segBytes;
      this.outGen++;
      this.segBytes = 0;
      this.gcSegments();
    }
    // Doorbell doubles as the reader's map: current segment, its size, the
    // final size of the previous segment, and the cumulative total.
    const sig: OutSig = { gen: this.outGen, size: this.segBytes, prevFinal: this.prevFinal, total: this.outTotal };
    writeFileAtomic(path.join(this.dir, "out.sig"), JSON.stringify(sig));
    this.checkWindow();
  }

  ack(total: number): void {
    this.ackTotal = Math.max(this.ackTotal, total);
    this.gcSegments();
    this.checkWindow();
  }

  gcSegments(): void {
    while (this.doneSegs.length > 0 && this.ackTotal >= this.doneSegs[0]!.endTotal) {
      const seg = this.doneSegs.shift()!;
      try {
        fs.unlinkSync(this.segPath(seg.gen));
      } catch {}
    }
  }

  checkWindow(): void {
    if (!this.proc) return;
    const { ackWindow, ackResume } = this.host.limits;
    const unacked = this.outTotal - this.ackTotal;
    if (!this.paused && unacked > ackWindow) {
      this.paused = true;
      try {
        if (this.pty) this.pty.pause();
        else {
          this.child!.stdout!.pause();
          this.child!.stderr!.pause();
        }
      } catch {}
      this.host.log.info(`session ${this.id}: output paused (${(unacked / 1048576).toFixed(1)} MB unacked)`);
    } else if (this.paused && unacked <= ackResume) {
      this.paused = false;
      try {
        if (this.pty) this.pty.resume();
        else {
          this.child!.stdout!.resume();
          this.child!.stderr!.resume();
        }
      } catch {}
      this.host.log.info(`session ${this.id}: output resumed`);
    }
  }

  appendJson(type: number, obj: unknown): void {
    this.appendFrame(type, new TextEncoder().encode(JSON.stringify(obj)));
  }

  setStatus(obj: Omit<SessionStatus, "t">): void {
    // Remember the base record so the detached marker (D17) can be layered
    // on and off without re-deriving state/pid/cmd at toggle time.
    const { detached: _, ...base } = obj;
    this.statusBase = base;
    writeJsonAtomic(path.join(this.dir, "status.json"), { t: now(), ...obj });
  }

  /** Toggle the D17 detached marker in status.json (no-op until the first
   *  setStatus, and when already in the requested state). */
  setDetached(detached: boolean): void {
    if (this.detached === detached || !this.statusBase) return;
    this.detached = detached;
    this.setStatus(detached ? { ...this.statusBase, detached: true } : this.statusBase);
  }

  /** Whether a durable status record exists yet (attach needs one: there
   *  is nothing to attach to before the spawn outcome is known). */
  get hasStatus(): boolean {
    return this.statusBase !== null;
  }

  /** Merge fields into the durable status record and rewrite it,
   *  preserving the detached marker layer (D18: attach folds `writer` in). */
  patchStatus(patch: Partial<Omit<SessionStatus, "t" | "detached">>): void {
    if (!this.statusBase) return;
    const base = { ...this.statusBase, ...patch };
    this.setStatus(this.detached ? { ...base, detached: true } : base);
  }

  // Answer the spawn request (once) on the out stream. Errors get real
  // JSON-RPC error objects instead of a status.json state the client must
  // poll for and interpret. Duplicated answers (host restart re-adopting a
  // session) are fine: clients ignore responses with unknown ids.
  answerSpawn(make: (id: RpcId) => RpcResponseMsg): void {
    if (this.spawnId === null || this.spawnAnswered) return;
    this.spawnAnswered = true;
    this.appendJson(FrameType.RPC, make(this.spawnId));
  }

  spawnOk(result: SpawnResult): void {
    this.answerSpawn((id) => rpcResult(id, result));
  }

  spawnFail(code: number, message: string): void {
    this.answerSpawn((id) => rpcError(id, code, message));
  }

  scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.host.scheduleScan();
    }, this.host.timings.retryMs);
  }

  close(): void {
    this.done = true;
    try {
      this.kindSession?.onClose?.();
    } catch (e) {
      this.host.log.warn(`session ${this.id}: kind onClose threw: ${errMsg(e)}`);
    }
    this.kindSession = null;
    for (const w of this.watchers) w?.close();
    this.watchers = [];
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.proc) {
      try {
        if (this.pty) this.pty.kill();
        else this.child!.kill("SIGTERM");
      } catch {}
      this.proc = null;
    }
  }
}

// ---------------------------------------------------------------- server

export class HostServer {
  readonly sharedDir: string;
  readonly fsioDir: string;
  readonly sessionsDir: string;
  readonly allowShell: boolean;
  private readonly onSpawnRequest: SpawnPolicy | null;
  readonly watchEnabled: boolean;
  readonly hotPollMs: number;
  readonly pollMs: number;
  readonly timings: Required<HostTimings>;
  readonly limits: Required<HostLimits>;
  readonly log: HostLogger;

  /** true once node-pty was found at start(). */
  ptyAvailable = false;

  private fresh: boolean;
  private readonly takeover: boolean;
  private readonly ptyOpt: PtyModule | false | undefined;
  private ptyMod: PtyModule | null = null;
  private sessions = new Map<string, Session>();
  // Kind registry (D13). echo is just the trivial entry; shell stays
  // native (pty + flow-control pause/resume have no kind-API hooks yet).
  private kinds = new Map<string, KindHandler>([["echo", () => ({})]]);
  private timers: ReturnType<typeof setInterval>[] = [];
  private pendingCleanups = new Set<ReturnType<typeof setTimeout>>();
  private rootWatcher: fs.FSWatcher | null = null;
  private hbSeq = 0;
  private startedAt = 0;
  private running = false;

  // fs.watch events are treated purely as wakeups; every wake runs a full,
  // idempotent scan. A slow safety poll catches anything watch misses.
  private scanning = false;
  private rescan = false;

  constructor(opts: HostServerOptions) {
    this.sharedDir = path.resolve(opts.root);
    this.fsioDir = path.join(this.sharedDir, ".fsio");
    this.sessionsDir = path.join(this.fsioDir, "sessions");
    this.allowShell = opts.allowShell ?? false;
    this.onSpawnRequest = opts.onSpawnRequest ?? null;
    this.fresh = opts.fresh ?? false;
    this.takeover = opts.takeover ?? false;
    this.watchEnabled = opts.watch ?? true;
    this.hotPollMs = opts.hotPollMs ?? 5;
    this.pollMs = opts.pollMs ?? 0;
    this.timings = { ...DEFAULT_TIMINGS, ...opts.timings };
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.log = opts.logger ?? SILENT_LOGGER;
    this.ptyOpt = opts.pty;
  }

  /** Read-only view of the sessions this host is serving (D14): the
   *  introspection surface for confirmation UIs (#16) and reattach (#3).
   *  Snapshots — mutating them changes nothing. */
  listSessions(): SessionInfo[] {
    const infos: SessionInfo[] = [];
    for (const s of this.sessions.values()) {
      const phase: SessionPhase = s.done
        ? "done"
        : s.exited
          ? "exited"
          : s.approved
            ? "running"
            : s.started
              ? "pending"
              : "adopted";
      const info: SessionInfo = {
        id: s.id,
        kind: s.spawn ? (s.spawn.kind ?? "echo") : null,
        client: s.spawn?.client,
        origin: s.spawn?.origin,
        phase,
        bytesOut: s.outTotal,
        bytesAcked: s.ackTotal,
        lastActivityAt: s.lastActivity,
        detached: s.detached,
        lastClientSeenAt: s.lastClientSeen,
        epoch: s.epoch,
      };
      if (phase === "running") {
        info.pid = s.proc ? ((s.proc as { pid?: number }).pid ?? process.pid) : process.pid;
        if (s.proc) info.pty = s.usesPty;
      }
      infos.push(info);
    }
    return infos;
  }

  /** Register a session kind (D13): `handler` runs per allowed spawn of
   *  this kind and returns the session's behavior (DATA sink, RPC methods,
   *  teardown). Register before clients spawn; names are first-come. */
  registerKind(kind: string, handler: KindHandler): this {
    if (kind === "shell" || this.kinds.has(kind)) throw new Error(`kind already registered: ${kind}`);
    this.kinds.set(kind, handler);
    return this;
  }

  /** Attach to the shared dir and begin serving. Resolves after the first
   *  heartbeat is on disk (host.json presence = readiness, per spec). */
  async start(): Promise<this> {
    if (this.running) throw new Error("HostServer already started");
    this.refuseLiveHost(); // before ANY .fsio mutation — fresh included (#40)
    this.running = true;
    this.startedAt = now();

    this.ptyMod = this.ptyOpt === false ? null : (this.ptyOpt ?? (await loadPty()));
    this.ptyAvailable = !!this.ptyMod;
    if (this.ptyMod) this.log.info("pty available: shell sessions get a real pty");
    else this.log.warn("no pty (node-pty not installed, or pty: false): shell sessions fall back to pipes. `npm i node-pty` for full terminal support.");

    if (this.fresh) fs.rmSync(this.fsioDir, { recursive: true, force: true });
    fs.mkdirSync(this.sessionsDir, { recursive: true });

    const manifest: FsioManifest = { protocol: PROTOCOL_VERSION };
    writeJsonAtomic(path.join(this.fsioDir, "fsio.json"), manifest);

    this.heartbeat();
    this.timers.push(setInterval(() => this.heartbeat(), this.timings.heartbeatMs));

    // GC: clients that vanish without close (crashed tab, hard refresh) leave
    // "running" sessions behind forever. Echo sessions are workbench
    // artifacts — reap them after idle timeout. Shell sessions are left
    // alone (they may hold real user processes). (#3 will refine this.)
    this.timers.push(setInterval(() => this.idleSweep(), this.timings.idleSweepMs));

    this.rootWatcher = this.watchDir(this.sessionsDir, () => this.scheduleScan());
    this.timers.push(setInterval(() => this.scheduleScan(), this.timings.safetyPollMs));
    if (this.pollMs > 0) this.timers.push(setInterval(() => this.scheduleScan(), this.pollMs));
    // Hot poll: fs.watch wakeups ride FSEvents with ~50ms latency on macOS
    // (measured; spec/FINDINGS.md F2). While a session is live, poll fast so
    // the uplink isn't notification-bound. Idle cost is zero.
    if (this.hotPollMs > 0) {
      this.timers.push(
        setInterval(() => {
          for (const s of this.sessions.values()) {
            if (s.started && !s.done) {
              this.scheduleScan();
              return;
            }
          }
        }, this.hotPollMs)
      );
    }

    this.scheduleScan();
    return this;
  }

  /** Stop serving: kill session processes, release watchers and timers,
   *  retract host.json (peers read absence/staleness as host-gone). All of
   *  that happens synchronously — un-awaited calls still fully tear down.
   *  The returned promise resolves once every child has actually exited
   *  (SIGTERM, then SIGKILL after `timings.killGraceMs` — D14), so
   *  embedders can `await host.close()` for a clean process exit. */
  close(): Promise<void> {
    if (!this.running) return Promise.resolve();
    this.running = false;
    const reaps: Promise<void>[] = [];
    for (const s of this.sessions.values()) {
      const proc = s.proc;
      const usesPty = s.usesPty;
      s.close(); // delivers SIGTERM (and nulls s.proc)
      if (proc) reaps.push(this.reapChild(s.id, proc, usesPty));
    }
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const t of this.pendingCleanups) clearTimeout(t);
    this.pendingCleanups.clear();
    this.rootWatcher?.close();
    this.rootWatcher = null;
    try {
      fs.unlinkSync(path.join(this.fsioDir, "host.json"));
    } catch {}
    return Promise.all(reaps).then(() => {});
  }

  // Wait for a killed child to actually exit; escalate to SIGKILL after the
  // grace period. Timers are unref'd and capped — close() can never hang a
  // process that wants to exit.
  private reapChild(id: string, proc: PtyProcess | ChildProcess, usesPty: boolean): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(escalate);
        clearTimeout(cap);
        resolve();
      };
      if (usesPty) (proc as PtyProcess).onExit(done);
      else if ((proc as ChildProcess).exitCode !== null || (proc as ChildProcess).signalCode !== null) return done();
      else (proc as ChildProcess).once("exit", done);
      const grace = this.timings.killGraceMs;
      const escalate = setTimeout(() => {
        this.log.warn(`session ${id}: child ignored SIGTERM for ${grace}ms — SIGKILL`);
        try {
          if (usesPty) (proc as PtyProcess).kill("SIGKILL");
          else (proc as ChildProcess).kill("SIGKILL");
        } catch {}
      }, grace);
      const cap = setTimeout(done, grace * 2 + 1000); // absolute ceiling
      escalate.unref?.();
      cap.unref?.();
    });
  }

  // ------------------------------------------------------------- internals

  // Mutual exclusion (#40): two live hosts on one .fsio would each spawn
  // every adopted session (double execution), both append out segments and
  // rewrite host-owned files (F8/D6: one writer per file), each consume
  // uplink chunks the other then sees as gaps — and both grant attach
  // requests (D18: dueling epoch bumps). Liveness is the same rule clients
  // use (spec: host.json mtime < 3 beats). A seatbelt, not a lock: two
  // hosts starting within one heartbeat can still collide (spec: Session
  // lifecycle), and `takeover` skips the refusal for a killed host whose
  // last beat hasn't gone stale yet.
  private refuseLiveHost(): void {
    const hostJson = path.join(this.fsioDir, "host.json");
    let ageMs: number;
    try {
      ageMs = Date.now() - fs.statSync(hostJson).mtimeMs;
    } catch {
      return; // no host.json — no incumbent
    }
    if (ageMs >= 3 * this.timings.heartbeatMs) return; // stale corpse; adoptable
    const pid = readJson<HostInfo>(hostJson)?.pid ?? "unknown";
    if (this.takeover) {
      this.log.warn(`taking over ${this.fsioDir} from a live-looking host (pid ${pid}, last heartbeat ${Math.round(ageMs)}ms ago)`);
      return;
    }
    throw new Error(
      `another fsio host looks live on ${this.fsioDir} (pid ${pid}, last heartbeat ${Math.round(ageMs)}ms ago). ` +
        `Stop it first, or pass takeover (--takeover) if it is a stale corpse.`
    );
  }

  private watchDir(p: string, cb: () => void): fs.FSWatcher | null {
    if (!this.watchEnabled) return null;
    try {
      const w = fs.watch(p, cb);
      w.on("error", () => {});
      return w;
    } catch {
      return null;
    }
  }

  private heartbeat(): void {
    const info: HostInfo = {
      pid: process.pid,
      protocol: PROTOCOL_VERSION,
      // With a policy hook the static boolean is meaningless; advertise
      // shells as askable so clients try and get the policy's real answer
      // (a coded 1004 with a reason) instead of self-censoring.
      allowShell: this.onSpawnRequest ? true : this.allowShell,
      pty: this.ptyAvailable,
      startedAt: this.startedAt,
      seq: this.hbSeq++,
      t: now(),
    };
    writeJsonAtomic(path.join(this.fsioDir, "host.json"), info);
  }

  private idleSweep(): void {
    for (const s of this.sessions.values()) {
      if (s.started && !s.done && s.spawn?.kind === "echo" && Date.now() - s.lastActivity > this.timings.idleGcMs) {
        this.log.info(`session ${s.id}: idle for ${Math.round(this.timings.idleGcMs / 1000)}s, reaping`);
        s.close();
        this.removeSessionDir(s, "idle");
        continue;
      }
      // Vanished-client policy (D17): judged only for heartbeat-aware
      // clients, and only once approved (a pending policy decision gets no
      // uplink service, so silence there means nothing). Echo sessions are
      // stateless workbench artifacts — reap precisely. Anything stateful
      // (shell, registered kinds) is marked detached, never killed: a
      // backgrounded tab's beats clamp to 1/min (F16), a frozen tab to
      // zero, and both users will return.
      if (s.approved && !s.done && !s.exited && s.heartbeatAware && Date.now() - s.lastClientSeen > this.timings.detachAfterMs) {
        if (s.spawn?.kind === "echo") {
          this.log.info(`session ${s.id}: client vanished (no heartbeat for ${Math.round(this.timings.detachAfterMs / 1000)}s), reaping`);
          s.close();
          this.removeSessionDir(s, "client vanished");
        } else if (!s.detached) {
          this.log.info(`session ${s.id}: client vanished (no heartbeat for ${Math.round(this.timings.detachAfterMs / 1000)}s), marking detached`);
          s.setDetached(true);
        }
      }
    }
    this.sweepClientDirs();
  }

  // Per-page reporter dirs (#39) accumulate one per page load in a
  // long-lived shared dir; the host owns .fsio cleanup (D6). Keep the
  // newest CLIENT_DIR_CAP; beyond that, remove only dirs untouched for
  // staleGraceMs — a live reporter flushes at least every 5 s, so a live
  // page's dir never looks stale.
  private sweepClientDirs(): void {
    const root = path.join(this.fsioDir, "client");
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return; // no reporter has attached yet
    }
    const dirs: { name: string; mtime: number }[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        const p = path.join(root, e.name);
        // Recency = the dir or its report, whichever moved last (the swap-
        // file commit bumps the dir too, but don't depend on that detail).
        let mtime = fs.statSync(p).mtimeMs;
        try {
          mtime = Math.max(mtime, fs.statSync(path.join(p, "report.json")).mtimeMs);
        } catch {}
        dirs.push({ name: e.name, mtime });
      } catch {}
    }
    if (dirs.length <= CLIENT_DIR_CAP) return;
    dirs.sort((a, b) => b.mtime - a.mtime);
    for (const d of dirs.slice(CLIENT_DIR_CAP)) {
      if (Date.now() - d.mtime < this.timings.staleGraceMs) continue;
      try {
        fs.rmSync(path.join(root, d.name), { recursive: true, force: true });
        this.log.info(`client dir ${d.name}: over cap (${CLIENT_DIR_CAP}) and stale, removed`);
      } catch {}
    }
  }

  scheduleScan(): void {
    if (!this.running) return;
    if (this.scanning) {
      this.rescan = true;
      return;
    }
    this.runScan();
  }

  private runScan(): void {
    this.scanning = true;
    do {
      this.rescan = false;
      try {
        this.scanOnce();
      } catch (e) {
        this.log.error("scan error:", errMsg(e));
      }
    } while (this.rescan);
    this.scanning = false;
  }

  private scanOnce(): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!this.sessions.has(e.name)) this.adoptSession(e.name);
    }
    for (const s of this.sessions.values()) {
      if (s.done) continue;
      if (!s.started) this.tryStart(s);
      // No uplink service before the policy verdict: a pending-confirmation
      // session must not answer pings or accept DATA (D12). Chunks queue in
      // in/ and drain on approval.
      if (s.approved) this.processIncoming(s);
      // Attach requests (D18) park until the spawn outcome is known — an
      // attacher asking during a pending policy decision waits, like
      // everything else about a pending session.
      if (s.approved || s.exited) this.processAttach(s);
    }
  }

  private adoptSession(id: string): void {
    const s = new Session(this, id);
    this.sessions.set(id, s);
    const status = readJson<SessionStatus>(path.join(s.dir, "status.json"));
    if (status && status.state === "exited") {
      s.done = true;
      // Stale leftover (e.g. host restarted before cleanup): GC after a grace
      // period so a client can still read the final out.log.
      if (now() - (status.t ?? 0) > this.timings.staleGraceMs) this.removeSessionDir(s, "stale");
      return;
    }
    s.watchers.push(this.watchDir(s.dir, () => this.scheduleScan()));
    this.log.info(`session ${id}: adopted`);
  }

  private tryStart(s: Session): void {
    const raw = readJson<RpcInbound & { jsonrpc?: string } & SpawnParams>(path.join(s.dir, "spawn.json"));
    if (!raw) return; // not written yet; a watch event will re-trigger
    // spawn.json carries a JSON-RPC "spawn" request (the file is the bootstrap
    // transport; the response rides the out stream). Legacy bare specs are
    // tolerated: no id, no response, status.json only.
    if (raw.jsonrpc === "2.0" && raw.method === "spawn") {
      s.spawn = (raw.params ?? {}) as SpawnParams;
      s.spawnId = raw.id ?? null;
    } else {
      s.spawn = raw;
    }
    // Restart adoption (D18): the writer epoch is durable in status.json —
    // resume consuming the current writer's uplink, not epoch 0's.
    const prior = readJson<SessionStatus>(path.join(s.dir, "status.json"));
    if (prior?.writer) s.epoch = prior.writer.epoch;
    s.started = true;
    s.watchers.push(this.watchDir(s.inDir, () => this.scheduleScan()));
    const kind = s.spawn.kind ?? "echo";
    // Validity precedes policy: an unknown kind cannot be allowed into
    // existence, and the hook shouldn't have to know the kind registry.
    if (kind !== "shell" && !this.kinds.has(kind)) {
      const error = `unknown kind: ${kind}`;
      s.setStatus({ state: "error", error });
      s.spawnFail(RpcErrors.UNKNOWN_KIND, error);
      s.done = true;
      return;
    }
    const info: SpawnRequestInfo = {
      sessionId: s.id,
      kind,
      client: s.spawn.client,
      origin: s.spawn.origin,
      ...(kind === "shell" ? this.resolveShell(s.spawn) : {}),
    };
    this.log.info(
      `session ${s.id}: spawn request kind=${kind}${info.origin ? ` origin=${info.origin}` : ""}${info.cmd ? ` cmd=${info.cmd}` : ""}`
    );
    void this.decideAndStart(s, kind, info);
  }

  // The default (static) policy — exactly the historical behavior: echo is
  // free, shell rides the allowShell boolean with the legacy 1001 code.
  private defaultPolicy(info: SpawnRequestInfo): SpawnDecision {
    if (info.kind !== "shell" || this.allowShell) return true;
    return {
      allow: false,
      code: RpcErrors.SHELL_NOT_ALLOWED,
      reason: "shell sessions not allowed; start host with --allow-shell",
    };
  }

  // Consult the policy hook (or the static default), fail-safe. Shared by
  // spawn (D12) and attach (D18) — an attach is judged like a spawn of the
  // same kind, with the attacher's identity and `attach: true` in the info.
  private async consultPolicy(s: Session, spec: Readonly<Record<string, unknown>>, info: SpawnRequestInfo): Promise<{ allow: boolean; reason?: string; code?: number }> {
    let decision: SpawnDecision;
    try {
      decision = this.onSpawnRequest ? await this.onSpawnRequest(spec, info) : this.defaultPolicy(info);
    } catch (e) {
      // Fail safe: a broken policy must never fail open.
      this.log.error(`session ${s.id}: ${info.attach ? "attach" : "spawn"} policy threw (${errMsg(e)}) — denying`);
      decision = { allow: false, reason: `${info.attach ? "attach" : "spawn"} policy failed` };
    }
    return typeof decision === "boolean" ? { allow: decision } : decision;
  }

  // Consult the spawn policy (D12), then dispatch. Async on purpose: a
  // promise-returning hook is the confirmation mechanism — the session sits
  // unanswered (spawn request pending, no incoming processed) until the
  // policy settles. Sessions that closed while deciding are dropped.
  private async decideAndStart(s: Session, kind: string, info: SpawnRequestInfo): Promise<void> {
    const d = await this.consultPolicy(s, s.spawn as Readonly<Record<string, unknown>>, info);
    if (!this.running || s.done) return; // host or session closed while deciding
    if (!d.allow) {
      const error = d.reason ?? "spawn denied by host policy";
      this.log.info(`session ${s.id}: denied (${error})`);
      s.setStatus({ state: "error", error });
      s.spawnFail(d.code ?? RpcErrors.SPAWN_DENIED, error);
      s.done = true;
      return;
    }
    s.approved = true;
    this.log.info(`session ${s.id}: start kind=${kind}`);
    if (kind === "shell") this.startShell(s);
    else this.startKind(s, kind);
    this.scheduleScan(); // drain anything queued while the decision was pending
  }

  // Start a registered kind (D13): run the handler (possibly async), then
  // answer the spawn request. Echo rides this path too — its handler is
  // the trivial `() => ({})`, so the registry mechanism is exercised on
  // every workbench bench run, not just by exotic embedders.
  private startKind(s: Session, kind: string): void {
    const handler = this.kinds.get(kind)!;
    const ctx: KindContext = {
      sessionId: s.id,
      spec: (s.spawn ?? {}) as Readonly<Record<string, unknown>>,
      write: (data) => {
        if (s.done || !s.kindSession) return;
        s.appendFrame(FrameType.DATA, typeof data === "string" ? new TextEncoder().encode(data) : data);
      },
      exit: (exitCode = null) => {
        if (s.done || !s.kindSession) return;
        s.kindSession = null; // delivery stops; close notification still drains
        s.exited = true;
        s.setStatus({ state: "exited", exitCode });
        this.log.info(`session ${s.id}: kind ${kind} exited (code ${exitCode})`);
      },
      log: {
        info: (...args) => this.log.info(`session ${s.id}:`, ...args),
        warn: (...args) => this.log.warn(`session ${s.id}:`, ...args),
        error: (...args) => this.log.error(`session ${s.id}:`, ...args),
      },
    };
    Promise.resolve()
      .then(() => handler(ctx))
      .then((ks) => {
        if (s.done) {
          // closed while the handler was setting up — give it its teardown
          try {
            ks.onClose?.();
          } catch {}
          return;
        }
        s.kindSession = ks;
        s.setStatus({ state: "running", kind, pid: process.pid });
        s.spawnOk({ kind, pid: process.pid, ...ks.result });
        this.scheduleScan();
      })
      .catch((e: unknown) => {
        if (s.done) return;
        const error = `kind ${kind} failed to start: ${errMsg(e)}`;
        s.setStatus({ state: "error", error });
        s.spawnFail(RpcErrors.SPAWN_FAILED, error);
        s.done = true;
      });
  }

  /** The exact thing a shell spec would run — shared by the policy hook's
   *  info and startShell so the judged command can't drift from the
   *  executed one (#6: "display the exact spawn.json before honoring it"). */
  private resolveShell(spec: SpawnParams): { cmd: string; args: string[]; cwd: string; pty: boolean } {
    return {
      cmd: spec.cmd || process.env.SHELL || "/bin/bash",
      args: spec.args ?? [],
      cwd: spec.cwd ? path.resolve(this.sharedDir, spec.cwd) : this.sharedDir,
      pty: !!this.ptyMod && spec.pty !== false,
    };
  }

  private startShell(s: Session): void {
    const spec = s.spawn!;
    const { cmd, args: cmdArgs, cwd, pty: usePty } = this.resolveShell(spec);
    const cols = spec.cols ?? 80;
    const rows = spec.rows ?? 24;

    // A spawn failure must never be silent: the client is awaiting the spawn
    // response and will otherwise stare at an empty terminal forever.
    if (usePty) {
      try {
        // usePty (from resolveShell) is only true when ptyMod loaded
        const p = this.ptyMod!.spawn(cmd, cmdArgs, {
          name: "xterm-256color",
          cols,
          rows,
          cwd,
          env: process.env,
        });
        s.proc = p;
        s.usesPty = true;
        // Late-callback guard: after Session.close() (client close, idle GC,
        // host close) the kill()'s own exit event still fires — writing
        // status into a removed session dir would throw. done means closed.
        p.onData((d) => {
          if (!s.done) s.appendFrame(FrameType.DATA, Buffer.from(d));
        });
        p.onExit(({ exitCode }) => {
          if (s.done) return;
          this.log.info(`session ${s.id}: exited code=${exitCode}`);
          s.exited = true;
          s.setStatus({ state: "exited", exitCode });
          s.proc = null;
        });
        s.setStatus({ state: "running", kind: "shell", pty: true, pid: p.pid, cmd });
        s.spawnOk({ kind: "shell", pty: true, pid: p.pid, cmd });
        return;
      } catch (e) {
        this.log.warn(`session ${s.id}: pty spawn failed (${errMsg(e)}); falling back to pipes`);
      }
    }
    try {
      const p = cpSpawn(cmd, cmdArgs, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
      // ENOENT etc. arrive async; answer the spawn request only once the
      // outcome is known ('spawn' fires on success, 'error' instead of it).
      p.on("spawn", () => s.spawnOk({ kind: "shell", pty: false, pid: p.pid!, cmd }));
      p.on("error", (e) => {
        if (s.done) return; // late-callback guard (see pty branch)
        this.log.warn(`session ${s.id}: spawn error: ${e.message}`);
        s.setStatus({ state: "error", error: `could not start ${cmd}: ${e.message}` });
        s.spawnFail(RpcErrors.SPAWN_FAILED, `could not start ${cmd}: ${e.message}`);
        s.proc = null;
      });
      s.proc = p;
      s.usesPty = false;
      p.stdout!.on("data", (d: Buffer) => {
        if (!s.done) s.appendFrame(FrameType.DATA, d);
      });
      p.stderr!.on("data", (d: Buffer) => {
        if (!s.done) s.appendFrame(FrameType.DATA, d);
      });
      p.on("exit", (code) => {
        if (s.done) return; // late-callback guard (see pty branch)
        this.log.info(`session ${s.id}: exited code=${code}`);
        s.exited = true;
        s.setStatus({ state: "exited", exitCode: code });
        s.proc = null;
      });
      s.setStatus({ state: "running", kind: "shell", pty: false, pid: p.pid, cmd });
    } catch (e) {
      this.log.warn(`session ${s.id}: spawn failed: ${errMsg(e)}`);
      s.setStatus({ state: "error", error: `could not start ${cmd}: ${errMsg(e)}` });
      s.spawnFail(RpcErrors.SPAWN_FAILED, `could not start ${cmd}: ${errMsg(e)}`);
      s.done = true;
    }
  }

  // Attach requests (D18): `attach.<aid>.json` in the session dir is the
  // bootstrap transport (like spawn.json — a would-be writer cannot ask on
  // an uplink it doesn't own yet). Deleting the file is the consumption
  // ack, done BEFORE deciding: a crash between delete and answer just
  // times the attacher out, and it retries with a fresh aid.
  private processAttach(s: Session): void {
    let names: string[];
    try {
      names = fs.readdirSync(s.dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (!/^attach\.[A-Za-z0-9_-]+\.json$/.test(name)) continue;
      const p = path.join(s.dir, name);
      const raw = readJson<RpcInbound>(p);
      try {
        fs.unlinkSync(p);
      } catch {
        continue; // lost a delete race (host restart overlap?) — not ours
      }
      if (!raw) {
        // Commits are atomic (rename / swap-file), so unreadable = garbage,
        // not torn — drop it rather than rescan it forever.
        this.log.warn(`session ${s.id}: discarding unparseable ${name}`);
        continue;
      }
      void this.decideAttach(s, raw);
    }
  }

  private async decideAttach(s: Session, msg: RpcInbound): Promise<void> {
    const id = msg.id ?? null;
    const answer = (resp: RpcResponseMsg) => {
      if (id !== null && !s.done) s.appendJson(FrameType.RPC, resp);
    };
    const params = (msg.params ?? {}) as Partial<AttachParams>;
    const aid = typeof params.aid === "string" && params.aid.length > 0 ? params.aid : null;
    // A request id is mandatory: an attacher that can't hear the grant can
    // never know which epoch (= which uplink dir) it owns.
    if (msg.method !== "attach" || !aid || id === null) {
      answer(rpcError(id, RpcErrors.INVALID_REQUEST, "malformed attach request"));
      return;
    }
    if (s.done || s.exited || !s.hasStatus) {
      answer(rpcError(id, RpcErrors.ATTACH_FAILED, s.exited ? "session exited" : "session not attachable"));
      return;
    }
    const kind = s.spawn?.kind ?? "echo";
    const info: SpawnRequestInfo = {
      sessionId: s.id,
      kind,
      attach: true,
      client: params.client,
      origin: params.origin,
      ...(kind === "shell" ? this.resolveShell(s.spawn!) : {}),
    };
    this.log.info(`session ${s.id}: attach request from ${aid}${info.origin ? ` origin=${info.origin}` : ""}`);
    const d = await this.consultPolicy(s, (s.spawn ?? {}) as Readonly<Record<string, unknown>>, info);
    if (!this.running || s.done) return;
    if (!d.allow) {
      const reason = d.reason ?? "attach denied by host policy";
      this.log.info(`session ${s.id}: attach denied (${reason})`);
      answer(rpcError(id, d.code ?? RpcErrors.SPAWN_DENIED, reason));
      return;
    }
    if (s.exited) {
      // exited while the policy was deciding
      answer(rpcError(id, RpcErrors.ATTACH_FAILED, "session exited"));
      return;
    }
    // Grant: bump the writer epoch, open the new uplink lane, record the
    // writer in status.json — that record is both the durable epoch (host
    // restarts resume the right lane) and the fence the superseded client
    // reads. Concurrent attachers serialize here; the last grant's status
    // write wins and everyone below it fences off.
    s.epoch += 1;
    s.nextInSeq = null; // fresh sequence space, rediscovered from the new dir
    try {
      fs.mkdirSync(s.inDir, { recursive: true });
    } catch {}
    s.watchers.push(this.watchDir(s.inDir, () => this.scheduleScan()));
    s.lastClientSeen = Date.now();
    s.detached = false; // an attached client is present by definition
    s.patchStatus({ writer: { epoch: s.epoch, aid } });
    const pid = s.proc ? ((s.proc as { pid?: number }).pid ?? process.pid) : process.pid;
    const result: AttachResult = {
      kind,
      pid,
      epoch: s.epoch,
      ...(kind === "shell" ? { pty: s.usesPty, cmd: this.resolveShell(s.spawn!).cmd } : {}),
    };
    this.log.info(`session ${s.id}: attach granted to ${aid} (epoch ${s.epoch})`);
    answer(rpcResult(id, result));
    this.scheduleScan(); // consume anything already committed to the new lane
  }

  // Consume in/ chunks strictly in sequence order. Two kinds share one
  // sequence space: NNNNNNNN.f files (payload = content) and
  // NNNNNNNN-<b64url> directories (payload = name; fast lane, F10).
  private processIncoming(s: Session): void {
    let names: string[];
    try {
      names = fs.readdirSync(s.inDir);
    } catch {
      return; // in/ not created yet
    }
    const chunks = new Map<number, { name: string; data?: string }>();
    for (const n of names) {
      let m;
      if ((m = CHUNK_RE.exec(n))) chunks.set(Number(m[1]), { name: n });
      else if ((m = DIR_CHUNK_RE.exec(n))) chunks.set(Number(m[1]), { name: n, data: m[2]! });
    }
    if (chunks.size === 0) return;
    if (s.nextInSeq === null) s.nextInSeq = Math.min(...chunks.keys());

    while (chunks.has(s.nextInSeq)) {
      const chunk = chunks.get(s.nextInSeq)!;
      const p = path.join(s.inDir, chunk.name);
      let bytes: Uint8Array;
      if (chunk.data !== undefined) {
        bytes = b64urlDecode(chunk.data); // dirname chunk: payload is the name
      } else {
        try {
          bytes = fs.readFileSync(p);
        } catch {
          return;
        }
        if (bytes.length === 0) {
          // Browser created the file but hasn't committed content yet (crswap
          // not swapped in). Wait; retry shortly in case the swap didn't
          // generate a watch event.
          s.scheduleRetry();
          return;
        }
      }
      const t1 = now(); // host receive timestamp for latency probes
      const { frames, consumed } = parseFrames(bytes);
      if (consumed < bytes.length || frames.length === 0) {
        s.scheduleRetry(); // torn write; wait for completion
        return;
      }
      s.lastActivity = Date.now();
      s.lastClientSeen = Date.now();
      s.setDetached(false); // any uplink traffic means the client is back (D17)
      for (const f of frames) this.handleFrame(s, f, t1);
      if (chunk.data !== undefined) fs.rmdirSync(p); // consumption ack
      else fs.unlinkSync(p);
      s.nextInSeq++;
    }
  }

  private handleFrame(s: Session, frame: Frame, t1: number): void {
    switch (frame.type) {
      case FrameType.DATA: {
        if (s.kindSession?.onData) {
          try {
            s.kindSession.onData(frame.payload);
          } catch (e) {
            this.log.warn(`session ${s.id}: kind onData threw: ${errMsg(e)}`);
          }
          break;
        }
        if (!s.proc) break;
        if (s.pty) s.pty.write(Buffer.from(frame.payload).toString("utf8"));
        else s.child!.stdin!.write(Buffer.from(frame.payload));
        break;
      }
      case FrameType.RPC: {
        let msg: RpcInbound;
        try {
          msg = decodeJson<RpcInbound>(frame.payload);
        } catch (e) {
          s.appendJson(FrameType.RPC, rpcError(null, RpcErrors.PARSE_ERROR, `unparseable RPC frame: ${errMsg(e)}`));
          break;
        }
        this.handleRpc(s, msg, t1);
        break;
      }
      default:
        this.log.warn(`session ${s.id}: ignoring frame type ${frameTypeName(frame.type)}`);
    }
  }

  // Control plane: JSON-RPC 2.0, one message per RPC frame (spec D10).
  // Requests get responses on the out stream; notifications are
  // fire-and-forget; responses from the client are not expected (the host
  // never sends requests in v0) and are ignored.
  private handleRpc(s: Session, msg: RpcInbound, t1: number): void {
    const { id, method, params = {} } = msg;
    if (method === undefined) return; // a response; host has no pending requests
    const isRequest = id !== undefined;
    // Registered kinds get first crack at non-reserved methods (D13):
    // `ack`/`close`/`heartbeat`/`detach` are host integrity and never
    // dispatched; anything the kind doesn't define falls through to the
    // builtins (`ping` works on every kind — it's the transport
    // diagnostic), then -32601.
    if (s.kindSession?.methods && method !== "ack" && method !== "close" && method !== "heartbeat" && method !== "detach") {
      const fn = s.kindSession.methods[method];
      if (fn) {
        Promise.resolve()
          .then(() => fn(params))
          .then((result) => {
            if (isRequest && !s.done) s.appendJson(FrameType.RPC, rpcResult(id, result ?? null));
          })
          .catch((e: unknown) => {
            if (!isRequest || s.done) return;
            const code = typeof (e as { code?: unknown })?.code === "number" ? (e as { code: number }).code : RpcErrors.INTERNAL_ERROR;
            s.appendJson(FrameType.RPC, rpcError(id, code, errMsg(e)));
          });
        return;
      }
    }
    switch (method) {
      case "ping": {
        // Result echoes params (filler exercises the downlink under payload
        // tests) plus host receive/append timestamps for leg attribution.
        const result: PingResult = { t0: 0, ...(params as object), t1, t2: now() };
        if (isRequest) s.appendJson(FrameType.RPC, rpcResult(id, result));
        break;
      }
      case "resize": {
        const { cols, rows } = params as ResizeParams;
        s.pty?.resize(cols, rows);
        break;
      }
      case "ack":
        s.ack((params as AckParams).total);
        break;
      case "heartbeat":
        // Presence beacon (D17). The chunk's arrival already refreshed
        // lastClientSeen; the method's own meaning is "this client speaks
        // heartbeats" — which opts the session into vanished-client
        // policy. Legacy clients never send it and are never judged.
        s.heartbeatAware = true;
        break;
      case "detach":
        // Deliberate walk-away (D18): mark detached NOW instead of making
        // the session wait out the heartbeat-silence window. The process
        // keeps running; a later attach (or the same client's return
        // traffic) clears the marker.
        this.log.info(`session ${s.id}: detached by client`);
        s.setDetached(true);
        break;
      case "signal": {
        const { sig } = params as SignalParams;
        if (s.proc) {
          try {
            if (s.pty) s.pty.kill(sig);
            else s.child!.kill((sig ?? "SIGTERM") as NodeJS.Signals);
          } catch {}
        }
        break;
      }
      case "eof":
        s.child?.stdin?.end();
        break;
      case "close":
        this.log.info(`session ${s.id}: closed by client`);
        s.setStatus({ state: "exited", exitCode: null, closedByClient: true });
        s.close();
        // Cleanup is host-owned (browser-side deletes race with our writes).
        // Small delay lets the client stop its watchers first.
        {
          const t = setTimeout(() => {
            this.pendingCleanups.delete(t);
            this.removeSessionDir(s, "closed");
          }, this.timings.closeDelayMs);
          this.pendingCleanups.add(t);
        }
        break;
      default:
        if (isRequest) s.appendJson(FrameType.RPC, rpcError(id, RpcErrors.METHOD_NOT_FOUND, `unknown method: ${method}`));
        else this.log.warn(`session ${s.id}: unknown notification ${method}`);
    }
  }

  private removeSessionDir(s: Session, why: string): void {
    try {
      fs.rmSync(s.dir, { recursive: true, force: true });
      // The in-memory entry goes with the dir — before listSessions() (D14)
      // this map only ever grew for the life of the host.
      this.sessions.delete(s.id);
      this.log.info(`session ${s.id}: removed (${why})`);
    } catch (e) {
      this.log.warn(`session ${s.id}: cleanup failed: ${errMsg(e)}`);
    }
  }
}
