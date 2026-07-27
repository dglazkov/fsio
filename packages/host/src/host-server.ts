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
  type PingResult,
  type ResizeParams,
  type SignalParams,
  type AckParams,
} from "@fsio/common";

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------- options

export type HostLogger = (...args: unknown[]) => void;

/** What a spawn policy gets to judge, beyond the raw spec: identity plus
 *  the *resolved* command — what would actually run, not what was asked
 *  for (a shell spec with no `cmd` means $SHELL; the hook must see that). */
export interface SpawnRequestInfo {
  sessionId: string;
  /** kind after defaulting ("echo" when the spec names none). */
  kind: string;
  /** free-form client identification from the spec (diagnostics only —
   *  anything that can write the folder can claim anything; see #6). */
  client?: string | undefined;
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
  /** stale exited sessions older than this are GC'd on adoption (spec: Session lifecycle). */
  staleGraceMs?: number;
  /** delay before deleting a closed session dir (lets the client stop watchers). */
  closeDelayMs?: number;
  /** fast retry when an uplink chunk looks torn/empty (invariant 3, F11). */
  retryMs?: number;
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
  /** wipe .fsio on startup. Default false. */
  fresh?: boolean;
  /** use fs.watch wakeups. Default true. */
  watch?: boolean;
  /** hot-poll interval while sessions are active (default 5, 0 = off; F2). */
  hotPollMs?: number;
  /** unconditional poll loop interval (default 0 = off). */
  pollMs?: number;
  logger?: HostLogger;
  timings?: HostTimings;
  limits?: HostLimits;
}

const DEFAULT_TIMINGS: Required<HostTimings> = {
  heartbeatMs: 2000,
  safetyPollMs: 250,
  idleGcMs: 5 * 60_000,
  idleSweepMs: 30_000,
  staleGraceMs: 60_000,
  closeDelayMs: 500,
  retryMs: 5,
};

// A `find .` produced 60 MB of scrollback in one file with nothing telling
// the pty to slow down — hence segments + the ack window.
const DEFAULT_LIMITS: Required<HostLimits> = {
  segMax: 8 * 1024 * 1024,
  ackWindow: 4 * 1024 * 1024,
  ackResume: 2 * 1024 * 1024,
};

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
interface PtyProcess {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
}

interface PtyModule {
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
  inDir: string;
  spawn: SpawnParams | null = null; // params from the JSON-RPC request in spawn.json
  spawnId: RpcId | null = null; // request id to answer (null = legacy bare spec)
  spawnAnswered = false;
  started = false;
  approved = false; // spawn policy said yes (D12); gates incoming processing
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

  constructor(
    private host: HostServer,
    id: string
  ) {
    this.id = id;
    this.dir = path.join(host.sessionsDir, id);
    this.inDir = path.join(this.dir, "in");
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
      this.host.log(`session ${this.id}: output paused (${(unacked / 1048576).toFixed(1)} MB unacked)`);
    } else if (this.paused && unacked <= ackResume) {
      this.paused = false;
      try {
        if (this.pty) this.pty.resume();
        else {
          this.child!.stdout!.resume();
          this.child!.stderr!.resume();
        }
      } catch {}
      this.host.log(`session ${this.id}: output resumed`);
    }
  }

  appendJson(type: number, obj: unknown): void {
    this.appendFrame(type, new TextEncoder().encode(JSON.stringify(obj)));
  }

  setStatus(obj: Omit<SessionStatus, "t">): void {
    writeJsonAtomic(path.join(this.dir, "status.json"), { t: now(), ...obj });
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
      this.host.log(`session ${this.id}: kind onClose threw: ${errMsg(e)}`);
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
    this.watchEnabled = opts.watch ?? true;
    this.hotPollMs = opts.hotPollMs ?? 5;
    this.pollMs = opts.pollMs ?? 0;
    this.timings = { ...DEFAULT_TIMINGS, ...opts.timings };
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.log = opts.logger ?? (() => {});
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
    this.running = true;
    this.startedAt = now();

    this.ptyMod = await loadPty();
    this.ptyAvailable = !!this.ptyMod;
    if (this.ptyMod) this.log("node-pty available: shell sessions get a real pty");
    else this.log("node-pty not installed: shell sessions fall back to pipes (no pty). `npm i node-pty` for full terminal support.");

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
   *  retract host.json (peers read absence/staleness as host-gone). */
  close(): void {
    if (!this.running) return;
    this.running = false;
    for (const s of this.sessions.values()) s.close();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const t of this.pendingCleanups) clearTimeout(t);
    this.pendingCleanups.clear();
    this.rootWatcher?.close();
    this.rootWatcher = null;
    try {
      fs.unlinkSync(path.join(this.fsioDir, "host.json"));
    } catch {}
  }

  // ------------------------------------------------------------- internals

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
        this.log(`session ${s.id}: idle for ${Math.round(this.timings.idleGcMs / 1000)}s, reaping`);
        s.close();
        this.removeSessionDir(s, "idle");
      }
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
        this.log("scan error:", errMsg(e));
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
    this.log(`session ${id}: adopted`);
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
      ...(kind === "shell" ? this.resolveShell(s.spawn) : {}),
    };
    this.log(`session ${s.id}: spawn request kind=${kind}${info.cmd ? ` cmd=${info.cmd}` : ""}`);
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

  // Consult the spawn policy (D12), then dispatch. Async on purpose: a
  // promise-returning hook is the confirmation mechanism — the session sits
  // unanswered (spawn request pending, no incoming processed) until the
  // policy settles. Sessions that closed while deciding are dropped.
  private async decideAndStart(s: Session, kind: string, info: SpawnRequestInfo): Promise<void> {
    let decision: SpawnDecision;
    try {
      decision = this.onSpawnRequest ? await this.onSpawnRequest(s.spawn as Readonly<Record<string, unknown>>, info) : this.defaultPolicy(info);
    } catch (e) {
      // Fail safe: a broken policy must never fail open.
      this.log(`session ${s.id}: spawn policy threw (${errMsg(e)}) — denying`);
      decision = { allow: false, reason: "spawn policy failed" };
    }
    if (!this.running || s.done) return; // host or session closed while deciding
    const d = typeof decision === "boolean" ? { allow: decision } : decision;
    if (!d.allow) {
      const error = d.reason ?? "spawn denied by host policy";
      this.log(`session ${s.id}: denied (${error})`);
      s.setStatus({ state: "error", error });
      s.spawnFail(d.code ?? RpcErrors.SPAWN_DENIED, error);
      s.done = true;
      return;
    }
    s.approved = true;
    this.log(`session ${s.id}: start kind=${kind}`);
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
        s.setStatus({ state: "exited", exitCode });
        this.log(`session ${s.id}: kind ${kind} exited (code ${exitCode})`);
      },
      log: (...args) => this.log(`session ${s.id}:`, ...args),
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
          this.log(`session ${s.id}: exited code=${exitCode}`);
          s.setStatus({ state: "exited", exitCode });
          s.proc = null;
        });
        s.setStatus({ state: "running", kind: "shell", pty: true, pid: p.pid, cmd });
        s.spawnOk({ kind: "shell", pty: true, pid: p.pid, cmd });
        return;
      } catch (e) {
        this.log(`session ${s.id}: pty spawn failed (${errMsg(e)}); falling back to pipes`);
      }
    }
    try {
      const p = cpSpawn(cmd, cmdArgs, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
      // ENOENT etc. arrive async; answer the spawn request only once the
      // outcome is known ('spawn' fires on success, 'error' instead of it).
      p.on("spawn", () => s.spawnOk({ kind: "shell", pty: false, pid: p.pid!, cmd }));
      p.on("error", (e) => {
        if (s.done) return; // late-callback guard (see pty branch)
        this.log(`session ${s.id}: spawn error: ${e.message}`);
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
        this.log(`session ${s.id}: exited code=${code}`);
        s.setStatus({ state: "exited", exitCode: code });
        s.proc = null;
      });
      s.setStatus({ state: "running", kind: "shell", pty: false, pid: p.pid, cmd });
    } catch (e) {
      this.log(`session ${s.id}: spawn failed: ${errMsg(e)}`);
      s.setStatus({ state: "error", error: `could not start ${cmd}: ${errMsg(e)}` });
      s.spawnFail(RpcErrors.SPAWN_FAILED, `could not start ${cmd}: ${errMsg(e)}`);
      s.done = true;
    }
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
            this.log(`session ${s.id}: kind onData threw: ${errMsg(e)}`);
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
        this.log(`session ${s.id}: ignoring frame type ${frameTypeName(frame.type)}`);
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
    // `ack`/`close` are host integrity and never dispatched; anything the
    // kind doesn't define falls through to the builtins (`ping` works on
    // every kind — it's the transport diagnostic), then -32601.
    if (s.kindSession?.methods && method !== "ack" && method !== "close") {
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
        this.log(`session ${s.id}: closed by client`);
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
        else this.log(`session ${s.id}: unknown notification ${method}`);
    }
  }

  private removeSessionDir(s: Session, why: string): void {
    try {
      fs.rmSync(s.dir, { recursive: true, force: true });
      this.log(`session ${s.id}: removed (${why})`);
    } catch (e) {
      this.log(`session ${s.id}: cleanup failed: ${errMsg(e)}`);
    }
  }
}
