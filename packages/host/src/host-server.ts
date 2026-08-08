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
  OUT_LOG_RE,
  segName,
  b64urlDecode,
  RpcErrors,
  rpcResult,
  rpcError,
  PROTOCOL_VERSION,
  CAPABILITIES,
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
  type ServicesDoc,
  type ServiceKind,
  type ServiceWorkspace,
  type TranscriptMeta,
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
  /** hub deployment (D22): the workspace name the spec asked for, after
   *  the resolver accepted it. Absent in one-folder mode. */
  workspace?: string;
  /** shell kinds only: the exact command/args/cwd that would run. `cwd` is
   *  already resolved inside the workspace root when there is one. */
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

// ---- workspaces (D22): the hub's folders-as-resources hook. The library
// stays folder-agnostic — it knows how to *use* a resolved root and how to
// refuse, never where roots come from. fsiod supplies the registry (#71);
// a one-folder host passes no resolver and behaves exactly as before.

/** What the resolver says about a requested workspace name. `root` is an
 *  absolute path that never reaches the wire — the host uses it as the
 *  spawn's base directory and reports only the name. `error` is the
 *  client-visible text of the `1006`, so it must contain no path and must
 *  not enumerate workspaces the client did not name. */
export type WorkspaceResolution = { root: string; name?: string } | { error: string };

/** Resolves a spawn spec's `workspace` name (D22). Deliberately
 *  synchronous: a registry lookup is a map read, and the resolved root
 *  must be identical for the policy's `info` and for the actual spawn.
 *
 *  The resolver owns "which names exist", "which this client may see",
 *  and "is a name required here" (it knows how many entries the host
 *  serves); the host owns containment of `cwd` and the wire discipline.
 *  It MUST NOT substitute a default for an unresolvable name — the client
 *  would be told it ran somewhere it did not (D22). */
export type WorkspaceResolver = (name: string | undefined, info: SpawnRequestInfo) => WorkspaceResolution;

// ---- service directory (D24): what the embedder contributes to it. The
// library derives what it knows first-hand (protocol, kinds, whether shell
// and pty are servable) and transcribes the rest. Grants and consent are
// *embedder* concepts — the library has no notion of either (fsiod owns
// them, #71) — so it never infers `needsGrant`, it only reports it.

/** Hub-shaped additions to `services.json` (D24). Every field is a claim
 *  the embedder makes; none of it is discoverable by the library. */
export interface ServicesInput {
  /** capability names beyond the ones the host derives (D25). Unknown to
   *  a client means "not supported", never fatal — so only advertise a
   *  name once the facility behind it works. */
  capabilities?: string[];
  /** advertisable workspaces: **names only**, never paths (D22/D24). One
   *  file serves all tenants, so this is the subset the user marked
   *  advertisable, not the registry. */
  workspaces?: ServiceWorkspace[];
  /** kind names that require a D23 grant before the policy is consulted.
   *  Hub-confined kinds (`echo`, the transport diagnostic) are omitted —
   *  they may be served ungranted. */
  needsGrant?: string[];
  /** per-kind detail, keyed by kind name (D31): transcribed into that
   *  kind's `detail` and interpreted nowhere in this library. Names with no
   *  registered kind are dropped — the document advertises what the host
   *  serves, and detail without a kind is detail about nothing.
   *
   *  The privacy line of D24 applies and the library cannot enforce it:
   *  one file serves every granted origin, so an embedder putting paths or
   *  secrets in here has leaked them to all of them. */
  kindDetail?: Record<string, Record<string, unknown>>;
  /** the consent endpoint, published only while a host serves one. */
  consent?: { url: string };
}

/** Every time-based host behavior, injectable so tests can run them at
 *  short timescales (TESTING.md: "become testable when #17 makes the
 *  intervals injectable"). Defaults are the measured/spec'd values. */
export interface HostTimings {
  /** host.json heartbeat cadence (spec: liveness = mtime < 3 beats). */
  heartbeatMs?: number;
  /** slow safety poll backing up fs.watch. */
  safetyPollMs?: number;
  /** how long traffic keeps the hot poll armed (D4's gate, host-side —
   *  F22). The browser client's window is 2 s; matching it keeps the two
   *  sides' idle economics comparable. */
  hotWindowMs?: number;
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

/** How much of the past to keep (D26 rule 4). Both bounds are enforced
 *  when a transcript is archived and again at start, so lowering them takes
 *  effect on the next run rather than at the next rotation. The newest
 *  transcript is never swept: deleting the conversation the human just
 *  ended is the one outcome worse than keeping too much. */
export interface TranscriptRetention {
  /** how many ended sessions to keep, newest first. Default 10. */
  keep?: number;
  /** total bytes across kept transcripts. Default 32 MB — four full head
   *  segments (`segMax`), which is a lot of chat and not a lot of disk. */
  maxBytes?: number;
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
  /** workspace resolver (D22): turns a spec's `workspace` name into the
   *  root a process-spawning session runs in. Omitted = the one-folder
   *  case, a registry of one (see `workspaceName`). */
  workspaces?: WorkspaceResolver;
  /** the name a one-folder host answers to for its own shared directory
   *  (D22: "a registry of one"). Default: none — an omitted `workspace`
   *  means the shared dir, and any name gets `1006`, because a host that
   *  advertises no name can resolve none. Ignored when `workspaces` is
   *  provided. */
  workspaceName?: string;
  /** the embedder's half of the service directory (D24) — advertisable
   *  workspace names, extra capability names, the consent endpoint. May be
   *  replaced at runtime with `setServices()`. */
  services?: ServicesInput;
  /** wipe .fsio on startup. Default false. Refused while another host is
   *  live on the directory (#40) — takeover applies here too. Transcript
   *  retention, when on, survives it (D26 rule 4). */
  fresh?: boolean;
  /** keep ended sessions' out logs under `.fsio/transcripts/<id>/` instead
   *  of deleting them with the session dir (D26 rule 4, #119). Default off
   *  — an embedder whose sessions carry a *conversation* opts in, and by
   *  opting in accepts that the record outlives the host that wrote it. */
  transcripts?: boolean | TranscriptRetention;
  /** skip the live-host refusal (#40): seize a directory whose host.json
   *  still looks live — for a killed host whose last heartbeat hasn't gone
   *  stale yet. Default false. */
  takeover?: boolean;
  /** use fs.watch wakeups. Default true. */
  watch?: boolean;
  /** ensure `.fsio/` is git-ignored when the shared directory lies inside
   *  a git repository (#82: the out log is full scrollback and must never
   *  reach version control). Default true. */
  gitignore?: boolean;
  /** hot-poll interval while traffic is flowing (default 5, 0 = off; F2).
   *  Gated on recent traffic, not session liveness — see `timings.hotWindowMs`
   *  and markActive() (F22). */
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
  hotWindowMs: 2000,
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

const DEFAULT_TRANSCRIPTS: Required<TranscriptRetention> = {
  keep: 10,
  maxBytes: 32 * 1024 * 1024,
};

// Reporter dirs (#39): pages self-report under .fsio/client/<clientId>/, one
// dir per page load. Enough history for forensics; beyond this, stale dirs
// are swept (host owns .fsio cleanup — D6). The whole directory can outlive
// the host, at the embedder's request — see `cleanServiceDir` (#109).
const CLIENT_DIR = "client";
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

/** Everything in `services.json` except `rev`, in a canonical form: fixed
 *  key order, sorted arrays, known fields only. It is the change test (a
 *  rewrite that says the same thing must not ring the doorbell) and it runs
 *  over hostile input too — the hub is co-tenant-writable (D20), so a
 *  scribbled document must normalize to something, never throw. Unknown
 *  fields are dropped rather than rejected (D25). */
function canonServices(d: Partial<ServicesDoc>): Omit<ServicesDoc, "rev"> {
  const caps = (Array.isArray(d.capabilities) ? d.capabilities : []).filter((c): c is string => typeof c === "string");
  const kinds = (Array.isArray(d.kinds) ? d.kinds : [])
    .filter((k): k is ServiceKind => !!k && typeof k.name === "string")
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((k) => ({
      name: k.name,
      ...(k.needsGrant ? { needsGrant: true } : {}),
      // Transcribed, never interpreted (D31) — but it must be a JSON
      // object, or the document stops being one shape for every reader.
      ...(isPlainObject(k.detail) ? { detail: k.detail } : {}),
    }));
  const ws = (Array.isArray(d.workspaces) ? d.workspaces : [])
    .filter((w): w is ServiceWorkspace => !!w && typeof w.name === "string")
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((w) => (typeof w.label === "string" ? { name: w.name, label: w.label } : { name: w.name }));
  const url = d.consent && typeof d.consent.url === "string" ? d.consent.url : null;
  return {
    protocol: typeof d.protocol === "number" ? d.protocol : PROTOCOL_VERSION,
    capabilities: [...new Set(caps)].sort(),
    kinds,
    ...(Array.isArray(d.workspaces) ? { workspaces: ws } : {}),
    ...(url === null ? {} : { consent: { url } }),
  };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Client-chosen text that goes back out in an error (status.json is read
 *  by humans in terminals and by pages): bounded, no control characters. */
const echoSafe = (s: string): string => s.replace(/\p{C}/gu, "").slice(0, 64);

const within = (root: string, p: string): boolean => {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** Is `p` inside `root`? Lexically, and again after realpath when the path
 *  exists — a symlink planted in a workspace is otherwise a one-hop escape
 *  from the containment D22 requires. An absent `p` is judged lexically
 *  (there is nothing yet to point anywhere). */
function contains(root: string, p: string): boolean {
  if (!within(root, p)) return false;
  try {
    return within(fs.realpathSync(root), fs.realpathSync(p));
  } catch {
    return true;
  }
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
/** How much goes to a pty at once, and how often.
 *
 *  512 is comfortably under the ~1 KB the line discipline holds (see
 *  `toPty`), leaving room for whatever the child has already typed ahead.
 *  20 ms is a tick the child can drain in and is invisible to a person
 *  typing — and nothing a person types is ever big enough to be paced. */
const PTY_CHUNK = 512;
const PTY_CHUNK_MS = 20;

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
  // Input waiting to reach a pty, and the timer draining it. A terminal's
  // input queue is about a kilobyte and it discards what does not fit, so a
  // burst written in one call is silently truncated — see `toPty`.
  ptyPending = "";
  ptyTimer: ReturnType<typeof setTimeout> | null = null;
  // Base directory for a spawned child (D22): the resolved workspace root
  // in hub mode, the shared dir otherwise. Resolved once, before the
  // policy sees it, so the judged cwd and the executed cwd cannot drift.
  root: string | null = null;
  workspace: string | null = null; // its name — the only half that may travel
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
    return path.join(this.dir, segName(gen));
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
    // Input still on its way to a pty that is about to be killed. Dropped
    // rather than flushed: the process is going, and a timer holding a
    // reference to a dead session is how a host stops exiting.
    if (this.ptyTimer) {
      clearTimeout(this.ptyTimer);
      this.ptyTimer = null;
    }
    this.ptyPending = "";
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
  /** where ended sessions' out logs are kept when retention is on (#119). */
  readonly transcriptsDir: string;
  readonly allowShell: boolean;
  private readonly onSpawnRequest: SpawnPolicy | null;
  private readonly workspaces: WorkspaceResolver;
  readonly watchEnabled: boolean;
  readonly hotPollMs: number;
  readonly pollMs: number;
  readonly timings: Required<HostTimings>;
  readonly limits: Required<HostLimits>;
  readonly log: HostLogger;

  /** true once node-pty was found at start(). */
  ptyAvailable = false;

  private fresh: boolean;
  /** null = off, and off means an ended session leaves nothing behind. */
  private readonly transcripts: Required<TranscriptRetention> | null;
  private readonly takeover: boolean;
  private readonly gitignore: boolean;
  private readonly ptyOpt: PtyModule | false | undefined;
  private ptyMod: PtyModule | null = null;
  private sessions = new Map<string, Session>();
  // Kind registry (D13). echo is just the trivial entry; shell stays
  // native (pty + flow-control pause/resume have no kind-API hooks yet).
  private kinds = new Map<string, KindHandler>([["echo", () => ({})]]);
  private timers: ReturnType<typeof setInterval>[] = [];
  // The hot poll is a lifecycle of its own: armed by traffic, disarmed by
  // silence (markActive) — not one of the always-on `timers`.
  private hotTimer: ReturnType<typeof setInterval> | null = null;
  private lastTraffic = 0;
  private pendingCleanups = new Set<ReturnType<typeof setTimeout>>();
  private rootWatcher: fs.FSWatcher | null = null;
  private hbSeq = 0;
  private startedAt = 0;
  private running = false;
  // Service directory (D24): the embedder's contribution, the last body we
  // published (canonical JSON, rev excluded — the change test), and the rev
  // the heartbeat advertises.
  private servicesInput: ServicesInput;
  private servicesBody: string | null = null;
  private servicesRev = 0;
  private readonly namedWorkspaces: boolean;

  // fs.watch events are treated purely as wakeups; every wake runs a full,
  // idempotent scan. A slow safety poll catches anything watch misses.
  private scanning = false;
  private rescan = false;

  constructor(opts: HostServerOptions) {
    this.sharedDir = path.resolve(opts.root);
    this.fsioDir = path.join(this.sharedDir, ".fsio");
    this.sessionsDir = path.join(this.fsioDir, "sessions");
    this.transcriptsDir = path.join(this.fsioDir, "transcripts");
    this.allowShell = opts.allowShell ?? false;
    this.onSpawnRequest = opts.onSpawnRequest ?? null;
    // One-folder mode is a registry of one (D22), not an absence of one:
    // an omitted name means the shared directory, and a name this host
    // does not advertise is `1006` like anywhere else. Ignoring the field
    // would be the substitution the decision forbids — the client would be
    // told it ran in the workspace it named.
    const ownName = opts.workspaceName;
    // The `workspaces` capability is a claim that *names* resolve here —
    // true for a registry (hub) and for a one-folder host that answers to
    // its own name, false for the default resolver, which serves the shared
    // dir and `1006`s every name (D22).
    this.namedWorkspaces = !!opts.workspaces || !!ownName;
    this.servicesInput = opts.services ?? {};
    this.workspaces =
      opts.workspaces ??
      ((name) =>
        name === undefined || name === ownName
          ? { root: this.sharedDir, ...(name ? { name } : {}) }
          : { error: `unknown workspace: ${echoSafe(name)}` });
    this.fresh = opts.fresh ?? false;
    this.transcripts = opts.transcripts ? { ...DEFAULT_TRANSCRIPTS, ...(opts.transcripts === true ? {} : opts.transcripts) } : null;
    this.takeover = opts.takeover ?? false;
    this.gitignore = opts.gitignore ?? true;
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
    this.republish(); // a kind registered after start() still gets advertised (D24)
    return this;
  }

  // ------------------------------------------- service directory (D24/D25)

  /** Replace the embedder's half of the service directory and republish.
   *  Idempotent and cheap: the document is temp+renamed *only* when its
   *  content actually changes, and only then does `rev` move. fsiod calls
   *  this when the workspace registry changes — `fsio share` must reach a
   *  page without a daemon restart, the same "it bites at the next
   *  judgment" discipline D23 requires of revocation. */
  setServices(input: ServicesInput): this {
    this.servicesInput = input;
    this.republish();
    return this;
  }

  /** The document as this host would publish it right now (D24) — the
   *  introspection surface, and what the tests read. */
  services(): ServicesDoc {
    return { rev: this.servicesRev, ...this.buildServices() };
  }

  private buildServices(): Omit<ServicesDoc, "rev"> {
    // Mirrors the heartbeat's `allowShell`: with a policy hook the static
    // boolean is meaningless, so shells are advertised as askable and the
    // policy gives the real, coded answer per request (D12).
    const shellServable = this.onSpawnRequest ? true : this.allowShell;
    const needsGrant = new Set(this.servicesInput.needsGrant ?? []);
    const named = [...this.kinds.keys(), ...(shellServable ? ["shell"] : [])];
    return canonServices({
      protocol: PROTOCOL_VERSION,
      capabilities: [
        ...(shellServable ? [CAPABILITIES.SHELL] : []),
        ...(this.ptyAvailable ? [CAPABILITIES.PTY] : []),
        CAPABILITIES.ATTACH,
        ...(this.namedWorkspaces ? [CAPABILITIES.WORKSPACES] : []),
        ...(this.servicesInput.capabilities ?? []),
      ],
      kinds: named.map((name) => ({
        name,
        ...(needsGrant.has(name) ? { needsGrant: true } : {}),
        ...(this.servicesInput.kindDetail?.[name] !== undefined ? { detail: this.servicesInput.kindDetail[name] } : {}),
      })),
      ...(this.servicesInput.workspaces ? { workspaces: this.servicesInput.workspaces } : {}),
      ...(this.servicesInput.consent ? { consent: this.servicesInput.consent } : {}),
    });
  }

  /** Write `services.json` if — and only if — its content changed, and ring
   *  the doorbell (`servicesRev` in `host.json`) when it did. Returns true
   *  on a revision bump. */
  private publishServices(): boolean {
    const doc = this.buildServices();
    const body = JSON.stringify(doc);
    if (body === this.servicesBody) return false;

    // First publish of this process: adopt what is already on disk. If it
    // says the same thing, keep its revision and do not rewrite (a restart
    // must not invalidate every client's cached copy); if it differs — or a
    // co-tenant scribbled on it — carry the revision forward rather than
    // rewinding it, since clients compare revisions, not contents.
    let prev = this.servicesRev;
    if (this.servicesBody === null) {
      const onDisk = this.readServices();
      if (onDisk) {
        prev = Number.isFinite(onDisk.rev) && onDisk.rev > 0 ? Math.floor(onDisk.rev) : 0;
        const { rev: _rev, ...rest } = onDisk;
        if (JSON.stringify(canonServices(rest)) === body) {
          this.servicesBody = body;
          this.servicesRev = prev;
          return false;
        }
      }
    }
    this.servicesRev = prev + 1;
    this.servicesBody = body;
    writeJsonAtomic(path.join(this.fsioDir, "services.json"), { rev: this.servicesRev, ...doc });
    return true;
  }

  private readServices(): ServicesDoc | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(this.fsioDir, "services.json"), "utf8")) as ServicesDoc;
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  // Republish + beat immediately: the heartbeat is the doorbell, and a
  // client that just learned a workspace exists should not wait out a beat
  // to hear about it. Costs a write only when something actually changed.
  private republish(): void {
    if (this.running && this.publishServices()) this.heartbeat();
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
    // Advice only where it can be acted on: an embedder that said `pty:
    // false` serves no shell sessions at all, and telling *its* users to go
    // install node-pty is a first-contact instruction to fix nothing (the
    // acp-demo npx artifact bundles no node_modules, so it hit this line on
    // every run — #106).
    else if (this.ptyOpt === false) this.log.info("pty disabled by the embedder: shell sessions would fall back to pipes");
    else this.log.warn("no pty (node-pty not installed): shell sessions fall back to pipes. `npm i node-pty` for full terminal support.");

    // `fresh` is right about the plumbing — a stale .fsio whose sessions
    // all point at dead pids is its own bad experience — and was wrong
    // about the record (#119). It now wipes everything with a lifetime no
    // longer than the host's, and no more than that.
    if (this.fresh) this.cleanServiceDir();
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    this.sweepTranscripts();
    this.ensureGitignore();

    const manifest: FsioManifest = { protocol: PROTOCOL_VERSION };
    writeJsonAtomic(path.join(this.fsioDir, "fsio.json"), manifest);

    // Before the first heartbeat: the beat carries `servicesRev`, and a
    // doorbell must never point at a document that is not there yet (D24).
    this.publishServices();
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
    // The hot poll is armed by traffic, not by liveness — see markActive().

    this.scheduleScan();
    return this;
  }

  /** Traffic gate for the hot poll (D4, ported host-side — F22). fs.watch
   *  wakeups ride FSEvents at ~50 ms on macOS (F2), too slow for a live
   *  uplink, so traffic arms a fast scan loop; `hotWindowMs` of silence
   *  disarms it and the per-dir watchers plus the 250 ms safety scan carry
   *  the idle case (invariant 1). The old gate was session *liveness*
   *  (`started && !done`), which is not the same claim: N idle-but-running
   *  sessions kept the 5 ms × O(N) loop hot forever — F22 measured ~60% of
   *  a core at 32 idle sessions, against ~3% for the same machinery
   *  idle-gated (cells A vs B), and ~10% vs ~0.6% at one. Wake-from-idle
   *  costs a watch event (~50 ms) or a safety scan (≤250 ms); the first
   *  consumed chunk re-arms the loop. */
  private markActive(): void {
    this.lastTraffic = Date.now();
    if (this.hotTimer || this.hotPollMs <= 0 || !this.running) return;
    this.hotTimer = setInterval(() => {
      if (Date.now() - this.lastTraffic > this.timings.hotWindowMs) {
        clearInterval(this.hotTimer!);
        this.hotTimer = null;
        return;
      }
      this.scheduleScan();
    }, this.hotPollMs);
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
      // The child is dying; whatever it said is now history rather than a
      // stream, so the record moves out of the session dir before the
      // embedder sweeps the directory behind us (#119). Nothing further
      // will be appended: the only writer was the process we just killed.
      this.archiveTranscript(s, "host closed");
      if (proc) reaps.push(this.reapChild(s.id, proc, usesPty));
    }
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.hotTimer) clearInterval(this.hotTimer);
    this.hotTimer = null;
    for (const t of this.pendingCleanups) clearTimeout(t);
    this.pendingCleanups.clear();
    this.rootWatcher?.close();
    this.rootWatcher = null;
    try {
      // Only the heartbeat is retracted. `services.json` is cold state, and
      // absence of the beat already reads as host-gone; leaving it lets the
      // next start adopt its revision instead of rewinding the doorbell (D24).
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

  // Scrollback hygiene (#82, spec: Scrollback hygiene): the out log is full
  // scrollback — secrets typed or echoed included — and must never reach
  // version control. When the shared directory lies inside a git repository
  // (a .git dir or file anywhere above it — worktrees use a file), ensure
  // `.fsio/` is ignored by appending to the shared dir's OWN .gitignore:
  // git honors one at every level, so this is correct for nested dirs and
  // never touches files outside the directory the user handed us. Failure
  // warns loudly (the user must add the line themselves) and never blocks
  // start().
  private ensureGitignore(): void {
    if (!this.gitignore) return;
    let dir = this.sharedDir;
    for (;;) {
      if (fs.existsSync(path.join(dir, ".git"))) break;
      const up = path.dirname(dir);
      if (up === dir) return; // filesystem root: not a git repo
      dir = up;
    }
    const file = path.join(this.sharedDir, ".gitignore");
    try {
      let text = "";
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {}
      if (text.split("\n").some((l) => /^\/?\.fsio\/?$/.test(l.trim()))) return;
      const sep = text.length > 0 && !text.endsWith("\n") ? "\n" : "";
      fs.appendFileSync(file, `${sep}# fsio transport state — session scrollback lives here\n.fsio/\n`);
      this.log.info(`added .fsio/ to ${file} (scrollback must never be committed)`);
    } catch (e) {
      this.log.warn(`could not git-ignore .fsio/ (${errMsg(e)}) — add ".fsio/" to ${file} yourself: session scrollback, secrets included, lives inside it`);
    }
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
      // The hot pointer at the cold document (D24) — same split as out.sig
      // (D3). `allowShell`/`pty` stay for one-folder clients that predate
      // the service directory; hub clients read `capabilities`.
      servicesRev: this.servicesRev,
    };
    writeJsonAtomic(path.join(this.fsioDir, "host.json"), info);
  }

  private idleSweep(): void {
    for (const s of this.sessions.values()) {
      // Scrollback hygiene (#82, spec: Scrollback hygiene): a session in a
      // terminal state — exited, or done without cleanup (denied, errored,
      // adopted-as-exited) — keeps its dir only while the client may still
      // be reading. Client silence past staleGraceMs means crashed or gone;
      // the dir (scrollback included) must not outlive that window. Live
      // readers are safe: their acks ride uplink chunks, and any consumed
      // chunk refreshes lastClientSeen. Same window as the adoption-time GC.
      // Detached-but-running sessions are untouched (exited=false — the
      // D17/D18 reattach promise).
      if ((s.exited || s.done) && Date.now() - Math.max(s.lastActivity, s.lastClientSeen) > this.timings.staleGraceMs) {
        this.log.info(`session ${s.id}: terminal and client silent for ${Math.round(this.timings.staleGraceMs / 1000)}s, removing`);
        s.close();
        this.removeSessionDir(s, "terminal, client gone");
        continue;
      }
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
    const root = path.join(this.fsioDir, CLIENT_DIR);
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

  // ---- ended-session transcripts (D26 rule 4, #119)
  //
  // Two lifetimes were living in one directory. The plumbing — `in/`,
  // doorbells, status.json, the profile a session ran under — means
  // nothing once the host that wrote it is gone, and sweeping it is right.
  // The out log of a session that carried a *conversation* is the only
  // copy of that conversation, and the same sweep was taking it: a 572 KB
  // agent session, recovered by hand from that file, was unrecoverable
  // minutes later because the helper had been stopped.
  //
  // The record gets its own directory rather than a flag on the session's.
  // A flag would have to be understood by adoption, the idle sweep, the
  // stale GC, `fresh`, and every reattach picker reading `listSessions()`
  // — five places that would each have to learn that a directory can be
  // a corpse. Moving the bytes out means nothing in `sessions/` changes
  // lifetime at all, and the only code that knows about retention is the
  // wipe (`cleanServiceDir`).
  //
  // What is kept is what retention already had (D26 rule 1): the segments
  // still on disk. For a conversation shorter than one rotation that is
  // all of it; past that it is the tail, and `meta.json` carries `gen` and
  // `total` so a reader can say so (#57) instead of rendering a suffix as
  // if it were the whole thing.
  private archiveTranscript(s: Session, why: string): void {
    if (!this.transcripts) return;
    let logs: string[];
    try {
      logs = fs.readdirSync(s.dir).filter((n) => OUT_LOG_RE.test(n)).sort();
    } catch {
      return; // dir already gone
    }
    if (!logs.length) return; // nothing was ever said; keep no monument to it
    const dir = path.join(this.transcriptsDir, s.id);
    try {
      fs.mkdirSync(dir, { recursive: true });
      let bytes = 0;
      for (const name of logs) {
        const to = path.join(dir, name);
        fs.renameSync(path.join(s.dir, name), to);
        bytes += fs.statSync(to).size;
      }
      // spawn.json rides along verbatim: it is what the client asked for,
      // and it is where a reader finds which kind — and, for a kind that
      // has one, which agent — produced these bytes. Copied rather than
      // summarized, because summarizing it here would be a second schema
      // to keep true.
      try {
        fs.copyFileSync(path.join(s.dir, "spawn.json"), path.join(dir, "spawn.json"));
      } catch {}
      const st = readJson<SessionStatus>(path.join(s.dir, "status.json"));
      const first = OUT_LOG_RE.exec(logs[0]!);
      const meta: TranscriptMeta = {
        id: s.id,
        kind: s.spawn ? (s.spawn.kind ?? "echo") : null,
        ...(s.spawn?.client ? { client: s.spawn.client } : {}),
        ...(s.spawn?.origin ? { origin: s.spawn.origin } : {}),
        ended: now(),
        why,
        exitCode: st?.exitCode ?? null,
        gen: first ? Number(first[1]) : 0,
        total: s.outTotal,
        bytes,
      };
      writeJsonAtomic(path.join(dir, "meta.json"), meta);
      this.log.info(`session ${s.id}: transcript kept (${why}, ${bytes} B)`);
    } catch (e) {
      this.log.warn(`session ${s.id}: transcript not kept: ${errMsg(e)}`);
      return;
    }
    this.sweepTranscripts();
  }

  /** Enforce the retention bounds, newest first. Runs after every archive
   *  and once at start — a cap lowered between runs takes effect then,
   *  which is the only moment it can: nothing sweeps while no host runs. */
  private sweepTranscripts(): void {
    const cfg = this.transcripts;
    if (!cfg) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.transcriptsDir, { withFileTypes: true });
    } catch {
      return; // nothing archived yet
    }
    const kept: { name: string; ended: number; bytes: number }[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(this.transcriptsDir, e.name);
      let bytes = 0;
      let ended = 0;
      try {
        for (const f of fs.readdirSync(dir)) bytes += fs.statSync(path.join(dir, f)).size;
        // The stat is the fallback, not the record: a hand-copied
        // transcript keeps its meta and loses its mtime.
        ended = readJson<TranscriptMeta>(path.join(dir, "meta.json"))?.ended ?? fs.statSync(dir).mtimeMs;
      } catch {
        continue;
      }
      kept.push({ name: e.name, ended, bytes });
    }
    kept.sort((a, b) => b.ended - a.ended);
    let running = 0;
    for (let i = 0; i < kept.length; i++) {
      const t = kept[i]!;
      running += t.bytes;
      // i === 0 is never swept: deleting the conversation the human just
      // ended, because it is on its own bigger than the cap, would be the
      // failure mode the whole feature exists to prevent.
      const over = i >= cfg.keep ? `over the ${cfg.keep}-transcript cap` : i > 0 && running > cfg.maxBytes ? `over the ${cfg.maxBytes} B cap` : null;
      if (!over) continue;
      try {
        fs.rmSync(path.join(this.transcriptsDir, t.name), { recursive: true, force: true });
        this.log.info(`transcript ${t.name}: removed (${over})`);
      } catch {}
    }
  }

  /** Delete the service directory, keeping what outlives the host that
   *  wrote it. `fresh: true` runs this at start; an embedder runs it at
   *  Ctrl-C — the two moments that used to `rm -rf .fsio` and take the
   *  transcripts with it (#119). With retention off and `keepClient` false
   *  it is exactly that `rm -rf`; otherwise the survivors below stay, and a
   *  `.fsio` left holding nothing removes itself so a folder that hosted no
   *  conversation is still handed back pristine (D6).
   *
   *  `keepClient` spares `client/`, which is the one directory under
   *  `.fsio` the host does not own: pages write their own diagnostics there
   *  and nothing in the protocol reads them (spec layout, D6's amendment
   *  for [#109](https://github.com/dglazkov/fsio/issues/109)). Sweeping it
   *  is the host cleaning up after a party it was not at — and in a
   *  manually-driven cooperative run it destroys the verdicts *as the
   *  gesture that ends the run*, which is how #102's first run lost them.
   *
   *  It is a parameter rather than a constant because the two call sites
   *  want opposite answers. At shutdown the reports are the point. At
   *  `fresh` start they are the previous run's, and carrying them forward
   *  would make "read the newest dir under `client/`" — the whole
   *  cooperative-verification contract — quietly unreliable. */
  cleanServiceDir(keepClient = false): void {
    const keep = new Set<string>();
    if (this.transcripts) keep.add(path.basename(this.transcriptsDir));
    if (keepClient) keep.add(CLIENT_DIR);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.fsioDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (keep.has(e.name)) continue;
      try {
        fs.rmSync(path.join(this.fsioDir, e.name), { recursive: true, force: true });
      } catch {}
    }
    try {
      fs.rmdirSync(this.fsioDir); // succeeds only when empty
    } catch {}
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
    // A new session dir is traffic: spawn.json and the client's first chunks
    // are milliseconds behind it. (The client arms its own hot poll at
    // session start for the same reason — D4/D16.)
    this.markActive();
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
    };
    // Subject before policy (D22): a spawn whose workspace cannot be
    // resolved never reaches the hook — there is nothing coherent to judge,
    // and the one behavior forbidden here is picking a subject on the
    // client's behalf. A one-folder host resolves through the built-in
    // registry of one, so this path is not hub-only.
    if (kind === "shell") {
      const root = this.resolveWorkspace(s, info);
      if (root === null) return;
      s.root = root;
      Object.assign(info, this.resolveShell(s.spawn, root));
      // Containment (D22): `cwd` is workspace-relative and MUST NOT escape.
      if (!contains(root, info.cwd!)) {
        const error = "cwd escapes the workspace root";
        s.setStatus({ state: "error", error });
        s.spawnFail(RpcErrors.INVALID_PARAMS, error);
        s.done = true;
        return;
      }
    }
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

  /** Hub deployment (D22): resolve the spec's `workspace` name to the root
   *  the child will run in, or refuse the session with `1006` and return
   *  null. `1006` covers unresolvable, may-not-see, and omitted-where-
   *  required alike — the client's next move (name a workspace it can
   *  have) is the same for all three. One-folder hosts have no resolver:
   *  the shared directory is the root, as it always was. */
  private resolveWorkspace(s: Session, info: SpawnRequestInfo): string | null {
    const asked = typeof s.spawn?.workspace === "string" ? s.spawn.workspace : undefined;
    const r = this.workspaces(asked, info);
    if ("error" in r) {
      this.log.info(`session ${s.id}: workspace refused (${r.error})`);
      s.setStatus({ state: "error", error: r.error });
      s.spawnFail(RpcErrors.UNKNOWN_WORKSPACE, r.error);
      s.done = true;
      return null;
    }
    const name = r.name ?? asked;
    if (name) info.workspace = s.workspace = name;
    return path.resolve(r.root);
  }

  /** The exact thing a shell spec would run — shared by the policy hook's
   *  info and startShell so the judged command can't drift from the
   *  executed one (#6: "display the exact spawn.json before honoring it").
   *  `root` is the resolved workspace root (D22), or the shared directory
   *  in one-folder mode. */
  private resolveShell(spec: SpawnParams, root: string): { cmd: string; args: string[]; cwd: string; pty: boolean } {
    return {
      cmd: spec.cmd || process.env.SHELL || "/bin/bash",
      args: spec.args ?? [],
      cwd: spec.cwd ? path.resolve(root, spec.cwd) : root,
      pty: !!this.ptyMod && spec.pty !== false,
    };
  }

  /** Write to a pty without losing the end of it.
   *
   *  A terminal's input queue is a fixed buffer in the line discipline, and
   *  when it is full the kernel **discards** what does not fit rather than
   *  blocking the writer. Nothing reports that: `write` returns void, node-pty
   *  offers no drain, and the bytes are simply not there. An extension that
   *  wrote a script in one call got a shell that ran the first third of it and
   *  stopped, with no error anywhere (#210).
   *
   *  Measured on macOS, `/bin/sh` on a real pty, one `write` per burst:
   *
   *      1,070 bytes        60 of 60 lines
   *      1,160 bytes        61 of 65
   *      3,690 bytes        83 of 200   (child at a prompt)
   *      3,690 bytes        66 of 200   (child in `sleep 2`)
   *      15,090 bytes       78 of 800
   *
   *  The survivor count plateaus around 66 regardless of how much is written,
   *  which is the signature of a fixed queue rather than of a slow reader.
   *
   *  So: never hand the line discipline more than it holds. Chunks go out
   *  under the limit, one per tick, and the same burst then arrives whole —
   *  3,690 bytes measured at 200 of 200 with the child reading. A burst that
   *  arrives while the child reads nothing at all is still lost after the
   *  first chunk-full, and no amount of pacing changes that (measured: 65 of
   *  200 at every chunk size and delay tried). That residue is a property of
   *  driving a terminal programmatically, and the way out of it is an
   *  operation that runs a command and captures its output rather than a
   *  keyboard — which is #210's open question, not something this can fix.
   *
   *  Keystrokes are unaffected: anything that fits in one chunk is written
   *  immediately, on this tick, with no timer involved. */
  private toPty(s: Session, data: string): void {
    s.ptyPending += data;
    if (s.ptyTimer) return; // a drain is already running; order is the queue's
    // The common case, and the one that must not be delayed: a keystroke, a
    // pasted line, a resize's worth of nothing. Straight through.
    if (s.ptyPending.length <= PTY_CHUNK) {
      const all = s.ptyPending;
      s.ptyPending = "";
      s.pty?.write(all);
      return;
    }
    const pump = (): void => {
      s.ptyTimer = null;
      if (s.done || !s.pty) {
        s.ptyPending = "";
        return;
      }
      const piece = s.ptyPending.slice(0, PTY_CHUNK);
      s.ptyPending = s.ptyPending.slice(PTY_CHUNK);
      s.pty.write(piece);
      if (s.ptyPending) s.ptyTimer = setTimeout(pump, PTY_CHUNK_MS);
    };
    pump();
  }

  private startShell(s: Session): void {
    const spec = s.spawn!;
    const { cmd, args: cmdArgs, cwd, pty: usePty } = this.resolveShell(spec, s.root ?? this.sharedDir);
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
      // An attach bootstrap is traffic too: the new writer starts committing
      // to in.<epoch>/ as soon as it hears the grant (D18).
      this.markActive();
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
      // The workspace was resolved at spawn (D22) — an attach inherits the
      // subject it is taking over, it never re-picks one.
      ...(s.workspace ? { workspace: s.workspace } : {}),
      ...(kind === "shell" ? this.resolveShell(s.spawn!, s.root ?? this.sharedDir) : {}),
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
      ...(kind === "shell" ? { pty: s.usesPty, cmd: this.resolveShell(s.spawn!, s.root ?? this.sharedDir).cmd } : {}),
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
      this.markActive(); // uplink traffic: arm/extend the hot poll (D4/F22)
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
        if (s.pty) this.toPty(s, Buffer.from(frame.payload).toString("utf8"));
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
            // `data` travels with the code. A kind's refusals are its own
            // vocabulary — "no such extension", and what to do instead — and
            // the numbered codes are the protocol's, not a kind's to mint
            // (1001–1007 are spoken for). Dropping `data` left a kind with
            // nowhere to put its answer, so every refusal arrived as prose a
            // caller had to pattern-match.
            const data = (e as { data?: unknown })?.data;
            s.appendJson(FrameType.RPC, rpcError(id, code, errMsg(e), data));
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
      this.archiveTranscript(s, why); // the record leaves before the plumbing dies (#119)
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
