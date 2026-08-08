#!/usr/bin/env node
// fsio acp-demo helper — generated bundle; source: packages/acp-demo (github.com/dglazkov/fsio)

// dist/helper.js
import fs6 from "node:fs";
import os3 from "node:os";
import path6 from "node:path";

// ../host/dist/host-server.js
import fs from "node:fs";
import path from "node:path";
import { spawn as cpSpawn } from "node:child_process";

// ../common/dist/frames.js
var HEADER_SIZE = 5;
var FrameType = {
  DATA: 1,
  // raw stdio/pty bytes
  // 2–4 reserved: early-v0 PING/PONG/CTL, retired when the control plane
  // moved to JSON-RPC (spec/DECISIONS.md D10). Never reuse.
  RPC: 5
  // one JSON-RPC 2.0 message (rpc.ts)
};
var frameTypeNames = new Map(Object.entries(FrameType).map(([k, v]) => [v, k]));
function frameTypeName(type) {
  return frameTypeNames.get(type) ?? `0x${type.toString(16)}`;
}
function encodeFrame(type, payload) {
  const buf = new Uint8Array(HEADER_SIZE + payload.length);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, payload.length, true);
  buf[4] = type;
  buf.set(payload, HEADER_SIZE);
  return buf;
}
function decodeJson(payload) {
  return JSON.parse(new TextDecoder().decode(payload));
}
function parseFrames(bytes) {
  const frames = [];
  let off = 0;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (off + HEADER_SIZE <= bytes.length) {
    const len = dv.getUint32(off, true);
    if (off + HEADER_SIZE + len > bytes.length)
      break;
    frames.push({
      type: bytes[off + 4],
      payload: bytes.subarray(off + HEADER_SIZE, off + HEADER_SIZE + len)
    });
    off += HEADER_SIZE + len;
  }
  return { frames, consumed: off };
}
function now() {
  return performance.timeOrigin + performance.now();
}
var CHUNK_RE = /^(\d{8})\.f$/;
function segName(gen) {
  return `out.${String(gen).padStart(8, "0")}.log`;
}
var OUT_LOG_RE = /^out\.(\d{8})\.log$/;
var DIR_CHUNK_RE = /^(\d{8})-([A-Za-z0-9_-]+)$/;
function b64urlDecode(str) {
  const bin = atob(str.replaceAll("-", "+").replaceAll("_", "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++)
    out[i] = bin.charCodeAt(i);
  return out;
}

// ../common/dist/rpc.js
var RpcErrors = {
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
  /** attach refused: session exited or not attachable (D18). */
  ATTACH_FAILED: 1005,
  /** hub deployment (D22): `workspace` names no entry this host can
   *  resolve, or none this client may see. Reserved here so the numbers
   *  stay stable — no shipped host emits 1006/1007 yet (#71). */
  UNKNOWN_WORKSPACE: 1006,
  /** hub deployment (D23): no valid grant covers the request. Absent,
   *  expired, invalid, and revoked are deliberately one code — the
   *  client's next move (ask for consent) is the same for all four. */
  GRANT_REQUIRED: 1007
};
function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== void 0)
    error.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error };
}

// ../common/dist/protocol.js
var PROTOCOL_VERSION = 0;
var CAPABILITIES = {
  /** `kind: "shell"` may be requested (the D12 policy still judges each). */
  SHELL: "shell",
  /** shell sessions get a real pty rather than the pipe fallback (D14). */
  PTY: "pty",
  /** `attach` is served: takeover with writer epochs and replay (D18). */
  ATTACH: "attach",
  /** `workspace` names resolve to roots this host serves (D22). */
  WORKSPACES: "workspaces"
};

// ../host/dist/host-server.js
var errMsg = (e) => e instanceof Error ? e.message : String(e);
var SILENT_LOGGER = { info() {
}, warn() {
}, error() {
} };
var DEFAULT_TIMINGS = {
  heartbeatMs: 2e3,
  safetyPollMs: 250,
  hotWindowMs: 2e3,
  idleGcMs: 5 * 6e4,
  idleSweepMs: 3e4,
  detachAfterMs: 18e4,
  staleGraceMs: 6e4,
  closeDelayMs: 500,
  retryMs: 5,
  killGraceMs: 3e3
};
var DEFAULT_LIMITS = {
  segMax: 8 * 1024 * 1024,
  ackWindow: 4 * 1024 * 1024,
  ackResume: 2 * 1024 * 1024
};
var DEFAULT_TRANSCRIPTS = {
  keep: 10,
  maxBytes: 32 * 1024 * 1024
};
var CLIENT_DIR = "client";
var CLIENT_DIR_CAP = 8;
function writeFileAtomic(file, data) {
  const tmp = path.join(path.dirname(file), `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
function writeJsonAtomic(file, obj) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2));
}
function canonServices(d) {
  const caps = (Array.isArray(d.capabilities) ? d.capabilities : []).filter((c) => typeof c === "string");
  const kinds = (Array.isArray(d.kinds) ? d.kinds : []).filter((k) => !!k && typeof k.name === "string").sort((a, b) => a.name.localeCompare(b.name)).map((k) => ({
    name: k.name,
    ...k.needsGrant ? { needsGrant: true } : {},
    // Transcribed, never interpreted (D31) — but it must be a JSON
    // object, or the document stops being one shape for every reader.
    ...isPlainObject(k.detail) ? { detail: k.detail } : {}
  }));
  const ws = (Array.isArray(d.workspaces) ? d.workspaces : []).filter((w) => !!w && typeof w.name === "string").sort((a, b) => a.name.localeCompare(b.name)).map((w) => typeof w.label === "string" ? { name: w.name, label: w.label } : { name: w.name });
  const url = d.consent && typeof d.consent.url === "string" ? d.consent.url : null;
  return {
    protocol: typeof d.protocol === "number" ? d.protocol : PROTOCOL_VERSION,
    capabilities: [...new Set(caps)].sort(),
    kinds,
    ...Array.isArray(d.workspaces) ? { workspaces: ws } : {},
    ...url === null ? {} : { consent: { url } }
  };
}
var isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
var echoSafe = (s) => s.replace(new RegExp("\\p{C}", "gu"), "").slice(0, 64);
var within = (root2, p) => {
  const rel = path.relative(root2, p);
  return rel === "" || !rel.startsWith("..") && !path.isAbsolute(rel);
};
function contains(root2, p) {
  if (!within(root2, p))
    return false;
  try {
    return within(fs.realpathSync(root2), fs.realpathSync(p));
  } catch {
    return true;
  }
}
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
var PTY_CHUNK = 512;
var PTY_CHUNK_MS = 20;
var ptyModCache;
async function loadPty() {
  if (ptyModCache !== void 0)
    return ptyModCache;
  try {
    const specifier = "node-pty";
    ptyModCache = await import(specifier);
  } catch {
    ptyModCache = null;
  }
  return ptyModCache;
}
var Session = class {
  host;
  id;
  dir;
  spawn = null;
  // params from the JSON-RPC request in spawn.json
  spawnId = null;
  // request id to answer (null = legacy bare spec)
  spawnAnswered = false;
  started = false;
  approved = false;
  // spawn policy said yes (D12); gates incoming processing
  exited = false;
  // process/kind reported exit (session dir still readable, D6)
  done = false;
  nextInSeq = null;
  // discovered from the smallest chunk present
  // Output stream state: segmented log + cumulative byte accounting.
  outGen = 0;
  // current segment number
  segBytes = 0;
  // bytes in current segment
  prevFinal = 0;
  // final size of segment outGen-1 (for reader handoff)
  outTotal = 0;
  // cumulative bytes ever appended
  ackTotal = 0;
  // cumulative bytes the client has confirmed consuming
  paused = false;
  // output paused waiting for acks
  doneSegs = [];
  // finished segments
  proc = null;
  usesPty = false;
  // Input waiting to reach a pty, and the timer draining it. A terminal's
  // input queue is about a kilobyte and it discards what does not fit, so a
  // burst written in one call is silently truncated — see `toPty`.
  ptyPending = "";
  ptyTimer = null;
  // Base directory for a spawned child (D22): the resolved workspace root
  // in hub mode, the shared dir otherwise. Resolved once, before the
  // policy sees it, so the judged cwd and the executed cwd cannot drift.
  root = null;
  workspace = null;
  // its name — the only half that may travel
  kindSession = null;
  // registered kinds (D13)
  watchers = [];
  retryTimer = null;
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
  statusBase = null;
  constructor(host, id) {
    this.host = host;
    this.id = id;
    this.dir = path.join(host.sessionsDir, id);
  }
  /** Current writer's uplink dir (D18): `in/` for epoch 0, `in.<epoch>/`
   *  after an attach takeover. Only this dir is ever consumed. */
  get inDir() {
    return path.join(this.dir, this.epoch === 0 ? "in" : `in.${this.epoch}`);
  }
  get pty() {
    return this.usesPty ? this.proc : null;
  }
  get child() {
    return this.usesPty || !this.proc ? null : this.proc;
  }
  segPath(gen) {
    return path.join(this.dir, segName(gen));
  }
  // Append with open/write/close per call, then bump a rename-committed
  // doorbell file. Rationale (measured, spec/FINDINGS.md F1): on macOS,
  // appends through a long-held fd are nearly invisible to FSEvents-backed
  // watchers — events fire on close() and renames, not on in-place writes.
  // Segments always rotate on frame boundaries (rotation happens between
  // appends), so every segment is independently parseable.
  appendFrame(type, payload) {
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
    const sig = { gen: this.outGen, size: this.segBytes, prevFinal: this.prevFinal, total: this.outTotal };
    writeFileAtomic(path.join(this.dir, "out.sig"), JSON.stringify(sig));
    this.checkWindow();
  }
  ack(total) {
    this.ackTotal = Math.max(this.ackTotal, total);
    this.gcSegments();
    this.checkWindow();
  }
  gcSegments() {
    while (this.doneSegs.length > 0 && this.ackTotal >= this.doneSegs[0].endTotal) {
      const seg = this.doneSegs.shift();
      try {
        fs.unlinkSync(this.segPath(seg.gen));
      } catch {
      }
    }
  }
  checkWindow() {
    if (!this.proc)
      return;
    const { ackWindow, ackResume } = this.host.limits;
    const unacked = this.outTotal - this.ackTotal;
    if (!this.paused && unacked > ackWindow) {
      this.paused = true;
      try {
        if (this.pty)
          this.pty.pause();
        else {
          this.child.stdout.pause();
          this.child.stderr.pause();
        }
      } catch {
      }
      this.host.log.info(`session ${this.id}: output paused (${(unacked / 1048576).toFixed(1)} MB unacked)`);
    } else if (this.paused && unacked <= ackResume) {
      this.paused = false;
      try {
        if (this.pty)
          this.pty.resume();
        else {
          this.child.stdout.resume();
          this.child.stderr.resume();
        }
      } catch {
      }
      this.host.log.info(`session ${this.id}: output resumed`);
    }
  }
  appendJson(type, obj) {
    this.appendFrame(type, new TextEncoder().encode(JSON.stringify(obj)));
  }
  setStatus(obj) {
    const { detached: _, ...base } = obj;
    this.statusBase = base;
    writeJsonAtomic(path.join(this.dir, "status.json"), { t: now(), ...obj });
  }
  /** Toggle the D17 detached marker in status.json (no-op until the first
   *  setStatus, and when already in the requested state). */
  setDetached(detached) {
    if (this.detached === detached || !this.statusBase)
      return;
    this.detached = detached;
    this.setStatus(detached ? { ...this.statusBase, detached: true } : this.statusBase);
  }
  /** Whether a durable status record exists yet (attach needs one: there
   *  is nothing to attach to before the spawn outcome is known). */
  get hasStatus() {
    return this.statusBase !== null;
  }
  /** Merge fields into the durable status record and rewrite it,
   *  preserving the detached marker layer (D18: attach folds `writer` in). */
  patchStatus(patch) {
    if (!this.statusBase)
      return;
    const base = { ...this.statusBase, ...patch };
    this.setStatus(this.detached ? { ...base, detached: true } : base);
  }
  // Answer the spawn request (once) on the out stream. Errors get real
  // JSON-RPC error objects instead of a status.json state the client must
  // poll for and interpret. Duplicated answers (host restart re-adopting a
  // session) are fine: clients ignore responses with unknown ids.
  answerSpawn(make) {
    if (this.spawnId === null || this.spawnAnswered)
      return;
    this.spawnAnswered = true;
    this.appendJson(FrameType.RPC, make(this.spawnId));
  }
  spawnOk(result) {
    this.answerSpawn((id) => rpcResult(id, result));
  }
  spawnFail(code, message) {
    this.answerSpawn((id) => rpcError(id, code, message));
  }
  scheduleRetry() {
    if (this.retryTimer)
      return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.host.scheduleScan();
    }, this.host.timings.retryMs);
  }
  close() {
    this.done = true;
    try {
      this.kindSession?.onClose?.();
    } catch (e) {
      this.host.log.warn(`session ${this.id}: kind onClose threw: ${errMsg(e)}`);
    }
    this.kindSession = null;
    for (const w of this.watchers)
      w?.close();
    this.watchers = [];
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.ptyTimer) {
      clearTimeout(this.ptyTimer);
      this.ptyTimer = null;
    }
    this.ptyPending = "";
    if (this.proc) {
      try {
        if (this.pty)
          this.pty.kill();
        else
          this.child.kill("SIGTERM");
      } catch {
      }
      this.proc = null;
    }
  }
};
var HostServer = class {
  sharedDir;
  fsioDir;
  sessionsDir;
  /** where ended sessions' out logs are kept when retention is on (#119). */
  transcriptsDir;
  allowShell;
  onSpawnRequest;
  workspaces;
  watchEnabled;
  hotPollMs;
  pollMs;
  timings;
  limits;
  log;
  /** true once node-pty was found at start(). */
  ptyAvailable = false;
  fresh;
  /** null = off, and off means an ended session leaves nothing behind. */
  transcripts;
  takeover;
  gitignore;
  ptyOpt;
  ptyMod = null;
  sessions = /* @__PURE__ */ new Map();
  // Kind registry (D13). echo is just the trivial entry; shell stays
  // native (pty + flow-control pause/resume have no kind-API hooks yet).
  kinds = /* @__PURE__ */ new Map([["echo", () => ({})]]);
  timers = [];
  // The hot poll is a lifecycle of its own: armed by traffic, disarmed by
  // silence (markActive) — not one of the always-on `timers`.
  hotTimer = null;
  lastTraffic = 0;
  pendingCleanups = /* @__PURE__ */ new Set();
  rootWatcher = null;
  hbSeq = 0;
  startedAt = 0;
  running = false;
  // Service directory (D24): the embedder's contribution, the last body we
  // published (canonical JSON, rev excluded — the change test), and the rev
  // the heartbeat advertises.
  servicesInput;
  servicesBody = null;
  servicesRev = 0;
  namedWorkspaces;
  // fs.watch events are treated purely as wakeups; every wake runs a full,
  // idempotent scan. A slow safety poll catches anything watch misses.
  scanning = false;
  rescan = false;
  constructor(opts) {
    this.sharedDir = path.resolve(opts.root);
    this.fsioDir = path.join(this.sharedDir, ".fsio");
    this.sessionsDir = path.join(this.fsioDir, "sessions");
    this.transcriptsDir = path.join(this.fsioDir, "transcripts");
    this.allowShell = opts.allowShell ?? false;
    this.onSpawnRequest = opts.onSpawnRequest ?? null;
    const ownName = opts.workspaceName;
    this.namedWorkspaces = !!opts.workspaces || !!ownName;
    this.servicesInput = opts.services ?? {};
    this.workspaces = opts.workspaces ?? ((name) => name === void 0 || name === ownName ? { root: this.sharedDir, ...name ? { name } : {} } : { error: `unknown workspace: ${echoSafe(name)}` });
    this.fresh = opts.fresh ?? false;
    this.transcripts = opts.transcripts ? { ...DEFAULT_TRANSCRIPTS, ...opts.transcripts === true ? {} : opts.transcripts } : null;
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
  listSessions() {
    const infos = [];
    for (const s of this.sessions.values()) {
      const phase = s.done ? "done" : s.exited ? "exited" : s.approved ? "running" : s.started ? "pending" : "adopted";
      const info = {
        id: s.id,
        kind: s.spawn ? s.spawn.kind ?? "echo" : null,
        client: s.spawn?.client,
        origin: s.spawn?.origin,
        phase,
        bytesOut: s.outTotal,
        bytesAcked: s.ackTotal,
        lastActivityAt: s.lastActivity,
        detached: s.detached,
        lastClientSeenAt: s.lastClientSeen,
        epoch: s.epoch
      };
      if (phase === "running") {
        info.pid = s.proc ? s.proc.pid ?? process.pid : process.pid;
        if (s.proc)
          info.pty = s.usesPty;
      }
      infos.push(info);
    }
    return infos;
  }
  /** Register a session kind (D13): `handler` runs per allowed spawn of
   *  this kind and returns the session's behavior (DATA sink, RPC methods,
   *  teardown). Register before clients spawn; names are first-come. */
  registerKind(kind, handler) {
    if (kind === "shell" || this.kinds.has(kind))
      throw new Error(`kind already registered: ${kind}`);
    this.kinds.set(kind, handler);
    this.republish();
    return this;
  }
  // ------------------------------------------- service directory (D24/D25)
  /** Replace the embedder's half of the service directory and republish.
   *  Idempotent and cheap: the document is temp+renamed *only* when its
   *  content actually changes, and only then does `rev` move. fsiod calls
   *  this when the workspace registry changes — `fsio share` must reach a
   *  page without a daemon restart, the same "it bites at the next
   *  judgment" discipline D23 requires of revocation. */
  setServices(input) {
    this.servicesInput = input;
    this.republish();
    return this;
  }
  /** The document as this host would publish it right now (D24) — the
   *  introspection surface, and what the tests read. */
  services() {
    return { rev: this.servicesRev, ...this.buildServices() };
  }
  buildServices() {
    const shellServable = this.onSpawnRequest ? true : this.allowShell;
    const needsGrant = new Set(this.servicesInput.needsGrant ?? []);
    const named = [...this.kinds.keys(), ...shellServable ? ["shell"] : []];
    return canonServices({
      protocol: PROTOCOL_VERSION,
      capabilities: [
        ...shellServable ? [CAPABILITIES.SHELL] : [],
        ...this.ptyAvailable ? [CAPABILITIES.PTY] : [],
        CAPABILITIES.ATTACH,
        ...this.namedWorkspaces ? [CAPABILITIES.WORKSPACES] : [],
        ...this.servicesInput.capabilities ?? []
      ],
      kinds: named.map((name) => ({
        name,
        ...needsGrant.has(name) ? { needsGrant: true } : {},
        ...this.servicesInput.kindDetail?.[name] !== void 0 ? { detail: this.servicesInput.kindDetail[name] } : {}
      })),
      ...this.servicesInput.workspaces ? { workspaces: this.servicesInput.workspaces } : {},
      ...this.servicesInput.consent ? { consent: this.servicesInput.consent } : {}
    });
  }
  /** Write `services.json` if — and only if — its content changed, and ring
   *  the doorbell (`servicesRev` in `host.json`) when it did. Returns true
   *  on a revision bump. */
  publishServices() {
    const doc = this.buildServices();
    const body = JSON.stringify(doc);
    if (body === this.servicesBody)
      return false;
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
  readServices() {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(this.fsioDir, "services.json"), "utf8"));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  // Republish + beat immediately: the heartbeat is the doorbell, and a
  // client that just learned a workspace exists should not wait out a beat
  // to hear about it. Costs a write only when something actually changed.
  republish() {
    if (this.running && this.publishServices())
      this.heartbeat();
  }
  /** Attach to the shared dir and begin serving. Resolves after the first
   *  heartbeat is on disk (host.json presence = readiness, per spec). */
  async start() {
    if (this.running)
      throw new Error("HostServer already started");
    this.refuseLiveHost();
    this.running = true;
    this.startedAt = now();
    this.ptyMod = this.ptyOpt === false ? null : this.ptyOpt ?? await loadPty();
    this.ptyAvailable = !!this.ptyMod;
    if (this.ptyMod)
      this.log.info("pty available: shell sessions get a real pty");
    else if (this.ptyOpt === false)
      this.log.info("pty disabled by the embedder: shell sessions would fall back to pipes");
    else
      this.log.warn("no pty (node-pty not installed): shell sessions fall back to pipes. `npm i node-pty` for full terminal support.");
    if (this.fresh)
      this.cleanServiceDir();
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    this.sweepTranscripts();
    this.ensureGitignore();
    const manifest = { protocol: PROTOCOL_VERSION };
    writeJsonAtomic(path.join(this.fsioDir, "fsio.json"), manifest);
    this.publishServices();
    this.heartbeat();
    this.timers.push(setInterval(() => this.heartbeat(), this.timings.heartbeatMs));
    this.timers.push(setInterval(() => this.idleSweep(), this.timings.idleSweepMs));
    this.rootWatcher = this.watchDir(this.sessionsDir, () => this.scheduleScan());
    this.timers.push(setInterval(() => this.scheduleScan(), this.timings.safetyPollMs));
    if (this.pollMs > 0)
      this.timers.push(setInterval(() => this.scheduleScan(), this.pollMs));
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
  markActive() {
    this.lastTraffic = Date.now();
    if (this.hotTimer || this.hotPollMs <= 0 || !this.running)
      return;
    this.hotTimer = setInterval(() => {
      if (Date.now() - this.lastTraffic > this.timings.hotWindowMs) {
        clearInterval(this.hotTimer);
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
  close() {
    if (!this.running)
      return Promise.resolve();
    this.running = false;
    const reaps = [];
    for (const s of this.sessions.values()) {
      const proc = s.proc;
      const usesPty = s.usesPty;
      s.close();
      this.archiveTranscript(s, "host closed");
      if (proc)
        reaps.push(this.reapChild(s.id, proc, usesPty));
    }
    for (const t of this.timers)
      clearInterval(t);
    this.timers = [];
    if (this.hotTimer)
      clearInterval(this.hotTimer);
    this.hotTimer = null;
    for (const t of this.pendingCleanups)
      clearTimeout(t);
    this.pendingCleanups.clear();
    this.rootWatcher?.close();
    this.rootWatcher = null;
    try {
      fs.unlinkSync(path.join(this.fsioDir, "host.json"));
    } catch {
    }
    return Promise.all(reaps).then(() => {
    });
  }
  // Wait for a killed child to actually exit; escalate to SIGKILL after the
  // grace period. Timers are unref'd and capped — close() can never hang a
  // process that wants to exit.
  reapChild(id, proc, usesPty) {
    return new Promise((resolve2) => {
      let settled = false;
      const done = () => {
        if (settled)
          return;
        settled = true;
        clearTimeout(escalate);
        clearTimeout(cap);
        resolve2();
      };
      if (usesPty)
        proc.onExit(done);
      else if (proc.exitCode !== null || proc.signalCode !== null)
        return done();
      else
        proc.once("exit", done);
      const grace = this.timings.killGraceMs;
      const escalate = setTimeout(() => {
        this.log.warn(`session ${id}: child ignored SIGTERM for ${grace}ms \u2014 SIGKILL`);
        try {
          if (usesPty)
            proc.kill("SIGKILL");
          else
            proc.kill("SIGKILL");
        } catch {
        }
      }, grace);
      const cap = setTimeout(done, grace * 2 + 1e3);
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
  refuseLiveHost() {
    const hostJson = path.join(this.fsioDir, "host.json");
    let ageMs;
    try {
      ageMs = Date.now() - fs.statSync(hostJson).mtimeMs;
    } catch {
      return;
    }
    if (ageMs >= 3 * this.timings.heartbeatMs)
      return;
    const pid = readJson(hostJson)?.pid ?? "unknown";
    if (this.takeover) {
      this.log.warn(`taking over ${this.fsioDir} from a live-looking host (pid ${pid}, last heartbeat ${Math.round(ageMs)}ms ago)`);
      return;
    }
    throw new Error(`another fsio host looks live on ${this.fsioDir} (pid ${pid}, last heartbeat ${Math.round(ageMs)}ms ago). Stop it first, or pass takeover (--takeover) if it is a stale corpse.`);
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
  ensureGitignore() {
    if (!this.gitignore)
      return;
    let dir = this.sharedDir;
    for (; ; ) {
      if (fs.existsSync(path.join(dir, ".git")))
        break;
      const up = path.dirname(dir);
      if (up === dir)
        return;
      dir = up;
    }
    const file = path.join(this.sharedDir, ".gitignore");
    try {
      let text = "";
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
      }
      if (text.split("\n").some((l) => /^\/?\.fsio\/?$/.test(l.trim())))
        return;
      const sep = text.length > 0 && !text.endsWith("\n") ? "\n" : "";
      fs.appendFileSync(file, `${sep}# fsio transport state \u2014 session scrollback lives here
.fsio/
`);
      this.log.info(`added .fsio/ to ${file} (scrollback must never be committed)`);
    } catch (e) {
      this.log.warn(`could not git-ignore .fsio/ (${errMsg(e)}) \u2014 add ".fsio/" to ${file} yourself: session scrollback, secrets included, lives inside it`);
    }
  }
  watchDir(p, cb) {
    if (!this.watchEnabled)
      return null;
    try {
      const w = fs.watch(p, cb);
      w.on("error", () => {
      });
      return w;
    } catch {
      return null;
    }
  }
  heartbeat() {
    const info = {
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
      servicesRev: this.servicesRev
    };
    writeJsonAtomic(path.join(this.fsioDir, "host.json"), info);
  }
  idleSweep() {
    for (const s of this.sessions.values()) {
      if ((s.exited || s.done) && Date.now() - Math.max(s.lastActivity, s.lastClientSeen) > this.timings.staleGraceMs) {
        this.log.info(`session ${s.id}: terminal and client silent for ${Math.round(this.timings.staleGraceMs / 1e3)}s, removing`);
        s.close();
        this.removeSessionDir(s, "terminal, client gone");
        continue;
      }
      if (s.started && !s.done && s.spawn?.kind === "echo" && Date.now() - s.lastActivity > this.timings.idleGcMs) {
        this.log.info(`session ${s.id}: idle for ${Math.round(this.timings.idleGcMs / 1e3)}s, reaping`);
        s.close();
        this.removeSessionDir(s, "idle");
        continue;
      }
      if (s.approved && !s.done && !s.exited && s.heartbeatAware && Date.now() - s.lastClientSeen > this.timings.detachAfterMs) {
        if (s.spawn?.kind === "echo") {
          this.log.info(`session ${s.id}: client vanished (no heartbeat for ${Math.round(this.timings.detachAfterMs / 1e3)}s), reaping`);
          s.close();
          this.removeSessionDir(s, "client vanished");
        } else if (!s.detached) {
          this.log.info(`session ${s.id}: client vanished (no heartbeat for ${Math.round(this.timings.detachAfterMs / 1e3)}s), marking detached`);
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
  sweepClientDirs() {
    const root2 = path.join(this.fsioDir, CLIENT_DIR);
    let entries;
    try {
      entries = fs.readdirSync(root2, { withFileTypes: true });
    } catch {
      return;
    }
    const dirs = [];
    for (const e of entries) {
      if (!e.isDirectory())
        continue;
      try {
        const p = path.join(root2, e.name);
        let mtime = fs.statSync(p).mtimeMs;
        try {
          mtime = Math.max(mtime, fs.statSync(path.join(p, "report.json")).mtimeMs);
        } catch {
        }
        dirs.push({ name: e.name, mtime });
      } catch {
      }
    }
    if (dirs.length <= CLIENT_DIR_CAP)
      return;
    dirs.sort((a, b) => b.mtime - a.mtime);
    for (const d of dirs.slice(CLIENT_DIR_CAP)) {
      if (Date.now() - d.mtime < this.timings.staleGraceMs)
        continue;
      try {
        fs.rmSync(path.join(root2, d.name), { recursive: true, force: true });
        this.log.info(`client dir ${d.name}: over cap (${CLIENT_DIR_CAP}) and stale, removed`);
      } catch {
      }
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
  archiveTranscript(s, why) {
    if (!this.transcripts)
      return;
    let logs;
    try {
      logs = fs.readdirSync(s.dir).filter((n) => OUT_LOG_RE.test(n)).sort();
    } catch {
      return;
    }
    if (!logs.length)
      return;
    const dir = path.join(this.transcriptsDir, s.id);
    try {
      fs.mkdirSync(dir, { recursive: true });
      let bytes = 0;
      for (const name of logs) {
        const to = path.join(dir, name);
        fs.renameSync(path.join(s.dir, name), to);
        bytes += fs.statSync(to).size;
      }
      try {
        fs.copyFileSync(path.join(s.dir, "spawn.json"), path.join(dir, "spawn.json"));
      } catch {
      }
      const st = readJson(path.join(s.dir, "status.json"));
      const first = OUT_LOG_RE.exec(logs[0]);
      const meta = {
        id: s.id,
        kind: s.spawn ? s.spawn.kind ?? "echo" : null,
        ...s.spawn?.client ? { client: s.spawn.client } : {},
        ...s.spawn?.origin ? { origin: s.spawn.origin } : {},
        ended: now(),
        why,
        exitCode: st?.exitCode ?? null,
        gen: first ? Number(first[1]) : 0,
        total: s.outTotal,
        bytes
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
  sweepTranscripts() {
    const cfg = this.transcripts;
    if (!cfg)
      return;
    let entries;
    try {
      entries = fs.readdirSync(this.transcriptsDir, { withFileTypes: true });
    } catch {
      return;
    }
    const kept = [];
    for (const e of entries) {
      if (!e.isDirectory())
        continue;
      const dir = path.join(this.transcriptsDir, e.name);
      let bytes = 0;
      let ended = 0;
      try {
        for (const f of fs.readdirSync(dir))
          bytes += fs.statSync(path.join(dir, f)).size;
        ended = readJson(path.join(dir, "meta.json"))?.ended ?? fs.statSync(dir).mtimeMs;
      } catch {
        continue;
      }
      kept.push({ name: e.name, ended, bytes });
    }
    kept.sort((a, b) => b.ended - a.ended);
    let running = 0;
    for (let i = 0; i < kept.length; i++) {
      const t = kept[i];
      running += t.bytes;
      const over = i >= cfg.keep ? `over the ${cfg.keep}-transcript cap` : i > 0 && running > cfg.maxBytes ? `over the ${cfg.maxBytes} B cap` : null;
      if (!over)
        continue;
      try {
        fs.rmSync(path.join(this.transcriptsDir, t.name), { recursive: true, force: true });
        this.log.info(`transcript ${t.name}: removed (${over})`);
      } catch {
      }
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
  cleanServiceDir(keepClient = false) {
    const keep = /* @__PURE__ */ new Set();
    if (this.transcripts)
      keep.add(path.basename(this.transcriptsDir));
    if (keepClient)
      keep.add(CLIENT_DIR);
    let entries;
    try {
      entries = fs.readdirSync(this.fsioDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (keep.has(e.name))
        continue;
      try {
        fs.rmSync(path.join(this.fsioDir, e.name), { recursive: true, force: true });
      } catch {
      }
    }
    try {
      fs.rmdirSync(this.fsioDir);
    } catch {
    }
  }
  scheduleScan() {
    if (!this.running)
      return;
    if (this.scanning) {
      this.rescan = true;
      return;
    }
    this.runScan();
  }
  runScan() {
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
  scanOnce() {
    let entries;
    try {
      entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory())
        continue;
      if (!this.sessions.has(e.name))
        this.adoptSession(e.name);
    }
    for (const s of this.sessions.values()) {
      if (s.done)
        continue;
      if (!s.started)
        this.tryStart(s);
      if (s.approved)
        this.processIncoming(s);
      if (s.approved || s.exited)
        this.processAttach(s);
    }
  }
  adoptSession(id) {
    const s = new Session(this, id);
    this.sessions.set(id, s);
    const status = readJson(path.join(s.dir, "status.json"));
    if (status && status.state === "exited") {
      s.done = true;
      if (now() - (status.t ?? 0) > this.timings.staleGraceMs)
        this.removeSessionDir(s, "stale");
      return;
    }
    s.watchers.push(this.watchDir(s.dir, () => this.scheduleScan()));
    this.markActive();
    this.log.info(`session ${id}: adopted`);
  }
  tryStart(s) {
    const raw = readJson(path.join(s.dir, "spawn.json"));
    if (!raw)
      return;
    if (raw.jsonrpc === "2.0" && raw.method === "spawn") {
      s.spawn = raw.params ?? {};
      s.spawnId = raw.id ?? null;
    } else {
      s.spawn = raw;
    }
    const prior = readJson(path.join(s.dir, "status.json"));
    if (prior?.writer)
      s.epoch = prior.writer.epoch;
    s.started = true;
    s.watchers.push(this.watchDir(s.inDir, () => this.scheduleScan()));
    const kind = s.spawn.kind ?? "echo";
    if (kind !== "shell" && !this.kinds.has(kind)) {
      const error = `unknown kind: ${kind}`;
      s.setStatus({ state: "error", error });
      s.spawnFail(RpcErrors.UNKNOWN_KIND, error);
      s.done = true;
      return;
    }
    const info = {
      sessionId: s.id,
      kind,
      client: s.spawn.client,
      origin: s.spawn.origin
    };
    if (kind === "shell") {
      const root2 = this.resolveWorkspace(s, info);
      if (root2 === null)
        return;
      s.root = root2;
      Object.assign(info, this.resolveShell(s.spawn, root2));
      if (!contains(root2, info.cwd)) {
        const error = "cwd escapes the workspace root";
        s.setStatus({ state: "error", error });
        s.spawnFail(RpcErrors.INVALID_PARAMS, error);
        s.done = true;
        return;
      }
    }
    this.log.info(`session ${s.id}: spawn request kind=${kind}${info.origin ? ` origin=${info.origin}` : ""}${info.cmd ? ` cmd=${info.cmd}` : ""}`);
    void this.decideAndStart(s, kind, info);
  }
  // The default (static) policy — exactly the historical behavior: echo is
  // free, shell rides the allowShell boolean with the legacy 1001 code.
  defaultPolicy(info) {
    if (info.kind !== "shell" || this.allowShell)
      return true;
    return {
      allow: false,
      code: RpcErrors.SHELL_NOT_ALLOWED,
      reason: "shell sessions not allowed; start host with --allow-shell"
    };
  }
  // Consult the policy hook (or the static default), fail-safe. Shared by
  // spawn (D12) and attach (D18) — an attach is judged like a spawn of the
  // same kind, with the attacher's identity and `attach: true` in the info.
  async consultPolicy(s, spec, info) {
    let decision;
    try {
      decision = this.onSpawnRequest ? await this.onSpawnRequest(spec, info) : this.defaultPolicy(info);
    } catch (e) {
      this.log.error(`session ${s.id}: ${info.attach ? "attach" : "spawn"} policy threw (${errMsg(e)}) \u2014 denying`);
      decision = { allow: false, reason: `${info.attach ? "attach" : "spawn"} policy failed` };
    }
    return typeof decision === "boolean" ? { allow: decision } : decision;
  }
  // Consult the spawn policy (D12), then dispatch. Async on purpose: a
  // promise-returning hook is the confirmation mechanism — the session sits
  // unanswered (spawn request pending, no incoming processed) until the
  // policy settles. Sessions that closed while deciding are dropped.
  async decideAndStart(s, kind, info) {
    const d = await this.consultPolicy(s, s.spawn, info);
    if (!this.running || s.done)
      return;
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
    if (kind === "shell")
      this.startShell(s);
    else
      this.startKind(s, kind);
    this.scheduleScan();
  }
  // Start a registered kind (D13): run the handler (possibly async), then
  // answer the spawn request. Echo rides this path too — its handler is
  // the trivial `() => ({})`, so the registry mechanism is exercised on
  // every workbench bench run, not just by exotic embedders.
  startKind(s, kind) {
    const handler = this.kinds.get(kind);
    const ctx = {
      sessionId: s.id,
      spec: s.spawn ?? {},
      write: (data) => {
        if (s.done || !s.kindSession)
          return;
        s.appendFrame(FrameType.DATA, typeof data === "string" ? new TextEncoder().encode(data) : data);
      },
      exit: (exitCode = null) => {
        if (s.done || !s.kindSession)
          return;
        s.kindSession = null;
        s.exited = true;
        s.setStatus({ state: "exited", exitCode });
        this.log.info(`session ${s.id}: kind ${kind} exited (code ${exitCode})`);
      },
      log: {
        info: (...args) => this.log.info(`session ${s.id}:`, ...args),
        warn: (...args) => this.log.warn(`session ${s.id}:`, ...args),
        error: (...args) => this.log.error(`session ${s.id}:`, ...args)
      }
    };
    Promise.resolve().then(() => handler(ctx)).then((ks) => {
      if (s.done) {
        try {
          ks.onClose?.();
        } catch {
        }
        return;
      }
      s.kindSession = ks;
      s.setStatus({ state: "running", kind, pid: process.pid });
      s.spawnOk({ kind, pid: process.pid, ...ks.result });
      this.scheduleScan();
    }).catch((e) => {
      if (s.done)
        return;
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
  resolveWorkspace(s, info) {
    const asked = typeof s.spawn?.workspace === "string" ? s.spawn.workspace : void 0;
    const r = this.workspaces(asked, info);
    if ("error" in r) {
      this.log.info(`session ${s.id}: workspace refused (${r.error})`);
      s.setStatus({ state: "error", error: r.error });
      s.spawnFail(RpcErrors.UNKNOWN_WORKSPACE, r.error);
      s.done = true;
      return null;
    }
    const name = r.name ?? asked;
    if (name)
      info.workspace = s.workspace = name;
    return path.resolve(r.root);
  }
  /** The exact thing a shell spec would run — shared by the policy hook's
   *  info and startShell so the judged command can't drift from the
   *  executed one (#6: "display the exact spawn.json before honoring it").
   *  `root` is the resolved workspace root (D22), or the shared directory
   *  in one-folder mode. */
  resolveShell(spec, root2) {
    return {
      cmd: spec.cmd || process.env.SHELL || "/bin/bash",
      args: spec.args ?? [],
      cwd: spec.cwd ? path.resolve(root2, spec.cwd) : root2,
      pty: !!this.ptyMod && spec.pty !== false
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
  toPty(s, data) {
    s.ptyPending += data;
    if (s.ptyTimer)
      return;
    if (s.ptyPending.length <= PTY_CHUNK) {
      const all = s.ptyPending;
      s.ptyPending = "";
      s.pty?.write(all);
      return;
    }
    const pump = () => {
      s.ptyTimer = null;
      if (s.done || !s.pty) {
        s.ptyPending = "";
        return;
      }
      const piece = s.ptyPending.slice(0, PTY_CHUNK);
      s.ptyPending = s.ptyPending.slice(PTY_CHUNK);
      s.pty.write(piece);
      if (s.ptyPending)
        s.ptyTimer = setTimeout(pump, PTY_CHUNK_MS);
    };
    pump();
  }
  startShell(s) {
    const spec = s.spawn;
    const { cmd, args: cmdArgs, cwd, pty: usePty } = this.resolveShell(spec, s.root ?? this.sharedDir);
    const cols = spec.cols ?? 80;
    const rows = spec.rows ?? 24;
    if (usePty) {
      try {
        const p = this.ptyMod.spawn(cmd, cmdArgs, {
          name: "xterm-256color",
          cols,
          rows,
          cwd,
          env: process.env
        });
        s.proc = p;
        s.usesPty = true;
        p.onData((d) => {
          if (!s.done)
            s.appendFrame(FrameType.DATA, Buffer.from(d));
        });
        p.onExit(({ exitCode }) => {
          if (s.done)
            return;
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
      p.on("spawn", () => s.spawnOk({ kind: "shell", pty: false, pid: p.pid, cmd }));
      p.on("error", (e) => {
        if (s.done)
          return;
        this.log.warn(`session ${s.id}: spawn error: ${e.message}`);
        s.setStatus({ state: "error", error: `could not start ${cmd}: ${e.message}` });
        s.spawnFail(RpcErrors.SPAWN_FAILED, `could not start ${cmd}: ${e.message}`);
        s.proc = null;
      });
      s.proc = p;
      s.usesPty = false;
      p.stdout.on("data", (d) => {
        if (!s.done)
          s.appendFrame(FrameType.DATA, d);
      });
      p.stderr.on("data", (d) => {
        if (!s.done)
          s.appendFrame(FrameType.DATA, d);
      });
      p.on("exit", (code) => {
        if (s.done)
          return;
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
  processAttach(s) {
    let names;
    try {
      names = fs.readdirSync(s.dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (!/^attach\.[A-Za-z0-9_-]+\.json$/.test(name))
        continue;
      const p = path.join(s.dir, name);
      const raw = readJson(p);
      try {
        fs.unlinkSync(p);
      } catch {
        continue;
      }
      if (!raw) {
        this.log.warn(`session ${s.id}: discarding unparseable ${name}`);
        continue;
      }
      this.markActive();
      void this.decideAttach(s, raw);
    }
  }
  async decideAttach(s, msg) {
    const id = msg.id ?? null;
    const answer = (resp) => {
      if (id !== null && !s.done)
        s.appendJson(FrameType.RPC, resp);
    };
    const params = msg.params ?? {};
    const aid = typeof params.aid === "string" && params.aid.length > 0 ? params.aid : null;
    if (msg.method !== "attach" || !aid || id === null) {
      answer(rpcError(id, RpcErrors.INVALID_REQUEST, "malformed attach request"));
      return;
    }
    if (s.done || s.exited || !s.hasStatus) {
      answer(rpcError(id, RpcErrors.ATTACH_FAILED, s.exited ? "session exited" : "session not attachable"));
      return;
    }
    const kind = s.spawn?.kind ?? "echo";
    const info = {
      sessionId: s.id,
      kind,
      attach: true,
      client: params.client,
      origin: params.origin,
      // The workspace was resolved at spawn (D22) — an attach inherits the
      // subject it is taking over, it never re-picks one.
      ...s.workspace ? { workspace: s.workspace } : {},
      ...kind === "shell" ? this.resolveShell(s.spawn, s.root ?? this.sharedDir) : {}
    };
    this.log.info(`session ${s.id}: attach request from ${aid}${info.origin ? ` origin=${info.origin}` : ""}`);
    const d = await this.consultPolicy(s, s.spawn ?? {}, info);
    if (!this.running || s.done)
      return;
    if (!d.allow) {
      const reason = d.reason ?? "attach denied by host policy";
      this.log.info(`session ${s.id}: attach denied (${reason})`);
      answer(rpcError(id, d.code ?? RpcErrors.SPAWN_DENIED, reason));
      return;
    }
    if (s.exited) {
      answer(rpcError(id, RpcErrors.ATTACH_FAILED, "session exited"));
      return;
    }
    s.epoch += 1;
    s.nextInSeq = null;
    try {
      fs.mkdirSync(s.inDir, { recursive: true });
    } catch {
    }
    s.watchers.push(this.watchDir(s.inDir, () => this.scheduleScan()));
    s.lastClientSeen = Date.now();
    s.detached = false;
    s.patchStatus({ writer: { epoch: s.epoch, aid } });
    const pid = s.proc ? s.proc.pid ?? process.pid : process.pid;
    const result = {
      kind,
      pid,
      epoch: s.epoch,
      ...kind === "shell" ? { pty: s.usesPty, cmd: this.resolveShell(s.spawn, s.root ?? this.sharedDir).cmd } : {}
    };
    this.log.info(`session ${s.id}: attach granted to ${aid} (epoch ${s.epoch})`);
    answer(rpcResult(id, result));
    this.scheduleScan();
  }
  // Consume in/ chunks strictly in sequence order. Two kinds share one
  // sequence space: NNNNNNNN.f files (payload = content) and
  // NNNNNNNN-<b64url> directories (payload = name; fast lane, F10).
  processIncoming(s) {
    let names;
    try {
      names = fs.readdirSync(s.inDir);
    } catch {
      return;
    }
    const chunks = /* @__PURE__ */ new Map();
    for (const n of names) {
      let m;
      if (m = CHUNK_RE.exec(n))
        chunks.set(Number(m[1]), { name: n });
      else if (m = DIR_CHUNK_RE.exec(n))
        chunks.set(Number(m[1]), { name: n, data: m[2] });
    }
    if (chunks.size === 0)
      return;
    if (s.nextInSeq === null)
      s.nextInSeq = Math.min(...chunks.keys());
    while (chunks.has(s.nextInSeq)) {
      const chunk = chunks.get(s.nextInSeq);
      const p = path.join(s.inDir, chunk.name);
      let bytes;
      if (chunk.data !== void 0) {
        bytes = b64urlDecode(chunk.data);
      } else {
        try {
          bytes = fs.readFileSync(p);
        } catch {
          return;
        }
        if (bytes.length === 0) {
          s.scheduleRetry();
          return;
        }
      }
      const t1 = now();
      const { frames, consumed } = parseFrames(bytes);
      if (consumed < bytes.length || frames.length === 0) {
        s.scheduleRetry();
        return;
      }
      s.lastActivity = Date.now();
      s.lastClientSeen = Date.now();
      this.markActive();
      s.setDetached(false);
      for (const f of frames)
        this.handleFrame(s, f, t1);
      if (chunk.data !== void 0)
        fs.rmdirSync(p);
      else
        fs.unlinkSync(p);
      s.nextInSeq++;
    }
  }
  handleFrame(s, frame, t1) {
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
        if (!s.proc)
          break;
        if (s.pty)
          this.toPty(s, Buffer.from(frame.payload).toString("utf8"));
        else
          s.child.stdin.write(Buffer.from(frame.payload));
        break;
      }
      case FrameType.RPC: {
        let msg;
        try {
          msg = decodeJson(frame.payload);
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
  handleRpc(s, msg, t1) {
    const { id, method, params = {} } = msg;
    if (method === void 0)
      return;
    const isRequest = id !== void 0;
    if (s.kindSession?.methods && method !== "ack" && method !== "close" && method !== "heartbeat" && method !== "detach") {
      const fn = s.kindSession.methods[method];
      if (fn) {
        Promise.resolve().then(() => fn(params)).then((result) => {
          if (isRequest && !s.done)
            s.appendJson(FrameType.RPC, rpcResult(id, result ?? null));
        }).catch((e) => {
          if (!isRequest || s.done)
            return;
          const code = typeof e?.code === "number" ? e.code : RpcErrors.INTERNAL_ERROR;
          const data = e?.data;
          s.appendJson(FrameType.RPC, rpcError(id, code, errMsg(e), data));
        });
        return;
      }
    }
    switch (method) {
      case "ping": {
        const result = { t0: 0, ...params, t1, t2: now() };
        if (isRequest)
          s.appendJson(FrameType.RPC, rpcResult(id, result));
        break;
      }
      case "resize": {
        const { cols, rows } = params;
        s.pty?.resize(cols, rows);
        break;
      }
      case "ack":
        s.ack(params.total);
        break;
      case "heartbeat":
        s.heartbeatAware = true;
        break;
      case "detach":
        this.log.info(`session ${s.id}: detached by client`);
        s.setDetached(true);
        break;
      case "signal": {
        const { sig } = params;
        if (s.proc) {
          try {
            if (s.pty)
              s.pty.kill(sig);
            else
              s.child.kill(sig ?? "SIGTERM");
          } catch {
          }
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
        {
          const t = setTimeout(() => {
            this.pendingCleanups.delete(t);
            this.removeSessionDir(s, "closed");
          }, this.timings.closeDelayMs);
          this.pendingCleanups.add(t);
        }
        break;
      default:
        if (isRequest)
          s.appendJson(FrameType.RPC, rpcError(id, RpcErrors.METHOD_NOT_FOUND, `unknown method: ${method}`));
        else
          this.log.warn(`session ${s.id}: unknown notification ${method}`);
    }
  }
  removeSessionDir(s, why) {
    try {
      this.archiveTranscript(s, why);
      fs.rmSync(s.dir, { recursive: true, force: true });
      this.sessions.delete(s.id);
      this.log.info(`session ${s.id}: removed (${why})`);
    } catch (e) {
      this.log.warn(`session ${s.id}: cleanup failed: ${errMsg(e)}`);
    }
  }
};

// dist/acp-kind.js
import fs4 from "node:fs";
import path4 from "node:path";
import { spawn } from "node:child_process";

// dist/agents.js
import fs3 from "node:fs";
import path3 from "node:path";

// dist/install.js
import fs2 from "node:fs";
import os from "node:os";
import path2 from "node:path";
import readline from "node:readline/promises";
import { execFile } from "node:child_process";
var agentsHome = (home = os.homedir()) => path2.join(home, ".fsio", "agents");
var agentDir = (name, home) => path2.join(agentsHome(home), name);
function managedBin(entry, home) {
  if (entry.bin.includes(path2.sep))
    return null;
  return path2.join(agentDir(entry.name, home), "node_modules", ".bin", entry.bin);
}
async function installAgent(entry, home) {
  const dir = agentDir(entry.name, home);
  if (!entry.pkg)
    return { ok: false, dir, error: `${entry.name} is not an npm package this helper can install` };
  fs2.mkdirSync(dir, { recursive: true });
  const spec = `${entry.pkg.name}@${entry.pkg.version}`;
  const args = ["install", "--prefix", dir, "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", spec];
  const out = await new Promise((resolve2) => {
    execFile("npm", args, { timeout: 6e5, maxBuffer: 8 << 20 }, (err, stdout, stderr) => resolve2({ err, stdout: String(stdout), stderr: String(stderr) }));
  });
  if (out.err)
    return { ok: false, dir, error: (out.stderr || out.stdout || out.err.message).trim() };
  const bin = managedBin(entry, home);
  if (!bin || !fs2.existsSync(bin)) {
    return { ok: false, dir, error: `npm reported success but ${bin ?? "the binary"} is not there` };
  }
  return { ok: true, dir };
}
async function confirm(question, input = process.stdin) {
  if (!input.isTTY)
    return false;
  const rl = readline.createInterface({ input, output: process.stdout });
  try {
    const answer = await new Promise((resolve2) => {
      rl.once("close", () => resolve2(""));
      void rl.question(question).then(resolve2, () => resolve2(""));
    });
    return /^y(es)?$/i.test(answer.trim());
  } catch {
    return false;
  } finally {
    rl.close();
    input.pause();
  }
}

// dist/agents.js
var installLine = (a) => a.install ?? (a.pkg ? `npm i -g ${a.pkg.name}@${a.pkg.version}` : "");
var AGENTS = [
  {
    name: "pi-acp",
    bin: "pi-acp",
    args: [],
    title: "pi coding agent (ACP adapter)",
    // 0.0.32: the version MEASUREMENTS.md measured, for the same reason the
    // entry below pins F30's. Not latest.
    pkg: { name: "pi-acp", version: "0.0.32" },
    // The demo's default subject: one small package, and model-agnostic —
    // which keeps the page an *ACP* client rather than a client of any one
    // vendor's agent. Caveat worth knowing before you drive it: pi reads and
    // edits with its own hands, so it never sends `session/request_permission`
    // or `fs/*` (#100). What it exercises is the transport, the framing, the
    // confinement facts and the live workspace — not the consent surface.
    // #100: 0 `session/request_permission`, 0 `fs/*` across a driven session.
    asks: false,
    state: {
      mode: "own",
      why: "pi keeps its credential (auth.json) beside its session history in ~/.pi; placing the state would place the identity too, and the agent would come up logged out (MEASUREMENTS.md)."
    }
  },
  {
    // The Claude Code ACP adapter. Not exercised by this repo's tests —
    // listed because it is the other posture, and MEASUREMENTS.md measured
    // its state placement directly: CLAUDE_CONFIG_DIR moves the whole tree
    // with zero denials, while the credential stays in the login Keychain
    // (reachable here only because the profile is `allow default`).
    //
    // Renamed since that was measured (checked 2026-08-01): the package
    // `@zed-industries/claude-code-acp` (0.16.2, bin `claude-code-acp`) is
    // deprecated in favour of `@agentclientprotocol/claude-agent-acp`
    // (0.64.0, bin `claude-agent-acp`). The name here is the new one; an
    // entry pointing at a deprecated package is an entry that will quietly
    // stop matching what people install.
    //
    // Unlike pi-acp this one *does* send `session/request_permission`, which
    // is why it is the standing answer to #100 for anyone who wants to see
    // the consent question fire against a real agent — and why it is the one
    // the helper offers to install when a machine has none (`recommended`
    // below). It needs its own Claude credential either way.
    name: "claude-agent-acp",
    bin: "claude-agent-acp",
    args: [],
    title: "Claude Code (ACP adapter)",
    // **0.64.0 because that is the version F30 measured**, not because it is
    // the newest — npm was already offering 0.64.2 when this was written,
    // and taking it would have been "install whatever is current" wearing a
    // pin's clothing. The profile below is a set of claims about one
    // release; the pin's whole job is to make those claims true of the copy
    // that actually runs. Bumping it means re-measuring F30 first.
    //
    // Install measured 2026-08-02 against this exact version: 111 packages,
    // 293 MB (260 MB of it the bundled Claude Code CLI), ~3 s, and
    // `--ignore-scripts` produces a byte-identical tree (install.ts).
    pkg: { name: "@agentclientprotocol/claude-agent-acp", version: "0.64.0" },
    /** The one a machine with no agent is offered. It asks before it edits,
     *  and the consent card is what this demo is *for* — offering the other
     *  one would install an agent that never fires the surface the human came
     *  to look at (#100, F30). */
    recommended: true,
    // F30: it asks, and the page renders the card with the file named and
    // three options. Caveat the roster cannot carry and the page copy must:
    // only in manual permission mode, which is inherited from the
    // operator's own Claude Code config.
    asks: true,
    // Was "place" until it was actually run (F30, 2026-08-01). Placement
    // moves the state tree perfectly — fresh config, `sessions/`,
    // `projects/`, zero denials — and the agent still cannot log in, because
    // login is *two* pieces in two places: the token in the login Keychain
    // (reachable; the profile is `allow default`) and the account binding
    // `oauthAccount` inside `~/.claude.json`. Placement replaces that file
    // with an empty one, so the child holds a key and does not know which
    // lock it fits: `session/prompt` fails "Authentication required".
    //
    // That is MEASUREMENTS.md's headline reaching its conclusion. Two agents
    // out of two keep identity and state inseparable (pi in subject 2, claude
    // here), so a placed host-owned slot is the nicer design for a kind of
    // agent neither of ours is. Leave both alone, and say why.
    state: {
      mode: "own",
      why: "the CLI's token is in the login Keychain but its account binding is in ~/.claude.json, so a placed config dir authenticates as nobody (F30); its state stays in ~/.claude where it puts it."
    }
  }
];
function roster(agents = AGENTS) {
  return agents.map((a) => {
    const found = resolve(a);
    return {
      name: a.name,
      title: a.title,
      install: installLine(a),
      installed: found !== null,
      asks: a.asks,
      via: found?.via ?? null
    };
  });
}
function findAgent(name, agents = AGENTS) {
  if (typeof name !== "string")
    return null;
  return agents.find((a) => a.name === name) ?? null;
}
function resolve(entry) {
  if (entry.bin.includes(path3.sep))
    return isExec(entry.bin) ? { bin: entry.bin, via: "PATH" } : null;
  for (const dir of (process.env["PATH"] ?? "").split(path3.delimiter)) {
    if (!dir)
      continue;
    const candidate = path3.join(dir, entry.bin);
    if (isExec(candidate))
      return { bin: candidate, via: "PATH" };
  }
  const managed = managedBin(entry);
  if (managed && isExec(managed))
    return { bin: managed, via: "fsio" };
  return null;
}
var resolveBin = (entry) => resolve(entry)?.bin ?? null;
function isExec(p) {
  try {
    fs3.accessSync(p, fs3.constants.X_OK);
    return fs3.statSync(p).isFile();
  } catch {
    return false;
  }
}

// dist/env.js
import os2 from "node:os";
var ENV_FLOOR = ["PATH", "HOME", "TERM", "LANG", "USER", "LOGNAME", "SHELL", "TMPDIR"];
function synthesizeEnv(entry, inputs) {
  const src = inputs.from ?? process.env;
  const env = {};
  for (const name of ENV_FLOOR) {
    const v = src[name];
    if (v !== void 0)
      env[name] = v;
  }
  env["TMPDIR"] = inputs.tmp;
  env["TERM"] = "dumb";
  env["HOME"] ??= os2.homedir();
  Object.assign(env, entry.env ?? {});
  if (entry.state.mode === "place") {
    if (!inputs.stateDir)
      throw new Error(`agent ${entry.name} needs a state dir (posture "place")`);
    env[entry.state.env] = inputs.stateDir;
  }
  return env;
}

// dist/framing.js
var MAX_LINE_BYTES = 1 << 20;
var LineSplitter = class {
  ev;
  max;
  #parts = [];
  #len = 0;
  #dropping = false;
  constructor(ev, max = MAX_LINE_BYTES) {
    this.ev = ev;
    this.max = max;
  }
  push(chunk) {
    let rest = chunk;
    for (; ; ) {
      const nl = rest.indexOf(10);
      if (nl < 0)
        break;
      const head = rest.subarray(0, nl);
      rest = rest.subarray(nl + 1);
      if (this.#dropping) {
        this.#dropping = false;
        this.#reset();
        continue;
      }
      this.#parts.push(head);
      this.#len += head.length;
      const text = Buffer.concat(this.#parts, this.#len).toString("utf8");
      this.#reset();
      const trimmed = text.endsWith("\r") ? text.slice(0, -1) : text;
      if (trimmed.length > 0)
        this.ev.line(trimmed);
    }
    if (rest.length === 0)
      return;
    if (this.#dropping)
      return;
    this.#parts.push(rest);
    this.#len += rest.length;
    if (this.#len > this.max) {
      this.ev.overflow(this.#len);
      this.#dropping = true;
      this.#reset();
    }
  }
  /** Bytes held back waiting for a newline (diagnostics; a child that exits
   *  mid-line leaves them here — they are never delivered as a message). */
  get pending() {
    return this.#len;
  }
  #reset() {
    this.#parts = [];
    this.#len = 0;
  }
};
function classify(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `not JSON (${e instanceof Error ? e.message : String(e)})`, text };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "not a JSON object", text };
  }
  return { ok: true, text };
}
function isJsonRpc(text) {
  try {
    return JSON.parse(text).jsonrpc === "2.0";
  } catch {
    return false;
  }
}
function toAgentLine(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "not valid UTF-8" };
  }
  const body = text.replace(/\r?\n$/, "");
  if (body.includes("\n"))
    return { ok: false, reason: "more than one line in a DATA frame" };
  const c = classify(body);
  if (!c.ok)
    return { ok: false, reason: c.reason };
  return { ok: true, line: body + "\n" };
}

// dist/acp-kind.js
var STDERR_KEEP = 200;
var STDERR_LINE_MAX = 2e3;
var KILL_GRACE_MS = 2e3;
function acpKind(opts) {
  const agents = opts.agents ?? AGENTS;
  return (ctx) => {
    const asked = ctx.spec["agent"];
    const entry = asked === void 0 ? agents.find((a) => resolveBin(a) !== null) ?? null : findAgent(asked, agents);
    if (!entry) {
      throw new Error(asked === void 0 ? `no ACP agent found on this machine's PATH; this helper knows: ${agents.map((a) => `${a.name} (${a.bin})`).join(", ")}` : `unknown agent ${JSON.stringify(asked)}; this helper serves: ${agents.map((a) => a.name).join(", ")}`);
    }
    const bin = resolveBin(entry);
    if (!bin)
      throw new Error(`agent ${entry.name} is not on this machine's PATH (looked for "${entry.bin}")`);
    let placedDir;
    if (entry.state.mode === "place") {
      placedDir = path4.join(opts.stateRoot, entry.name);
      fs4.mkdirSync(placedDir, { recursive: true });
    }
    const env = synthesizeEnv(entry, { tmp: opts.tmp, ...placedDir ? { stateDir: placedDir } : {}, ...opts.env ? { from: opts.env } : {} });
    const counters = { messagesOut: 0, messagesIn: 0, junkLines: 0, nonRpc: 0, refusedIn: 0, overflows: 0, bytesOut: 0, bytesIn: 0 };
    const stderr = [];
    const keep = (line2) => {
      stderr.push(line2.length > STDERR_LINE_MAX ? line2.slice(0, STDERR_LINE_MAX) + "\u2026" : line2);
      if (stderr.length > STDERR_KEEP)
        stderr.splice(0, stderr.length - STDERR_KEEP);
    };
    const child = spawn(bin, entry.args, { cwd: opts.root, env, stdio: ["pipe", "pipe", "pipe"] });
    const splitter = new LineSplitter({
      line: (text) => {
        const c = classify(text);
        if (!c.ok) {
          counters.junkLines++;
          keep(`[stdout, not a message: ${c.reason}] ${text.slice(0, 300)}`);
          ctx.log.warn(`agent ${entry.name} wrote non-message stdout (${c.reason})`);
          return;
        }
        if (!isJsonRpc(text))
          counters.nonRpc++;
        counters.messagesOut++;
        counters.bytesOut += text.length;
        ctx.write(text);
      },
      overflow: (bytes) => {
        counters.overflows++;
        ctx.log.warn(`agent ${entry.name}: dropped a ${bytes}-byte line with no newline (framing limit)`);
        keep(`[dropped an over-long stdout line: ${bytes} bytes]`);
      }
    });
    child.stdout.on("data", (chunk) => splitter.push(chunk));
    let errBuf = "";
    child.stderr.on("data", (chunk) => {
      errBuf += chunk.toString("utf8");
      const lines = errBuf.split("\n");
      errBuf = lines.pop() ?? "";
      for (const l of lines)
        if (l.trim())
          keep(l);
    });
    let exited = false;
    const finish = (code, signal) => {
      if (exited)
        return;
      exited = true;
      if (errBuf.trim())
        keep(errBuf.trim());
      ctx.log.info(`agent ${entry.name} exited (code ${code}, signal ${signal ?? "none"})`);
      ctx.exit(code ?? (signal ? 128 : null));
    };
    child.on("close", (code, signal) => finish(code, signal));
    child.on("error", (e) => {
      keep(`[spawn error] ${e.message}`);
      ctx.log.error(`agent ${entry.name}: ${e.message}`);
      finish(127, null);
    });
    child.stdin.on("error", (e) => keep(`[stdin] ${e.message}`));
    ctx.log.info(`agent ${entry.name} (pid ${child.pid}) in ${path4.basename(opts.root)}/`);
    return {
      // Spawn-result extras (D13): everything the page needs to render the
      // session header honestly, without asking a second question.
      result: {
        agent: entry.name,
        title: entry.title,
        protocol: "acp",
        // The host stamps `pid` with its own (D13: kinds run in-process);
        // the agent is a child of it, so its pid needs its own name.
        agentPid: child.pid ?? null,
        state: { mode: entry.state.mode, why: entry.state.why }
      },
      // ---- uplink: one DATA frame → one line on the agent's stdin
      onData: (bytes) => {
        const r = toAgentLine(bytes);
        if (!r.ok) {
          counters.refusedIn++;
          ctx.log.warn(`refused a DATA frame from the page: ${r.reason}`);
          keep(`[refused an uplink frame: ${r.reason}]`);
          return;
        }
        counters.messagesIn++;
        counters.bytesIn += r.line.length;
        if (!child.stdin.destroyed)
          child.stdin.write(r.line);
      },
      methods: {
        /** Who is running, under what, and where the policy file is — the
         *  page reads that file through the same folder handle. */
        "acp/info": () => ({
          agent: entry.name,
          title: entry.title,
          pid: child.pid ?? null,
          // The agent's cwd, absolute — ACP's `session/new` requires one,
          // and the page is the ACP client, so the page has to have it.
          // A deliberate exception to D22's "names, never paths": that rule
          // protects a client from learning the layout of workspaces it was
          // never granted, and this client is holding a handle to this exact
          // folder. The path is a label for a capability it already has.
          cwd: opts.root,
          argv: [entry.bin, ...entry.args],
          state: { mode: entry.state.mode, why: entry.state.why },
          env: Object.keys(env).sort()
        }),
        /** Everything that did not fit the payload channel. A stalled agent
         *  is diagnosable from the page instead of from the terminal the
         *  demo is trying to replace. */
        "acp/diagnostics": () => ({
          ...counters,
          pendingBytes: splitter.pending,
          exited,
          stderr: [...stderr]
        })
      },
      onClose: () => {
        if (!exited) {
          child.kill("SIGTERM");
          const t = setTimeout(() => {
            if (!exited)
              child.kill("SIGKILL");
          }, KILL_GRACE_MS);
          t.unref();
        }
      }
    };
  };
}

// dist/launch.js
var DEFAULT_PAGE = "https://agent-demo.pewter.town/";
var okDir = (v) => v.length > 0 && v.length <= 64 && !/[/\\]/.test(v) && ![...v].some((c) => (c.codePointAt(0) ?? 0) < 32);
var okAgent = (v) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v);
var hint = (ok, v) => typeof v === "string" && ok(v) ? v : null;
function launchUrl(base, l) {
  const u = new URL(base);
  const dir = hint(okDir, l.dir);
  const agent = hint(okAgent, l.agent);
  if (dir)
    u.searchParams.set("dir", dir);
  if (agent)
    u.searchParams.set("agent", agent);
  return u.toString();
}

// dist/open.js
import fs5 from "node:fs";
import path5 from "node:path";
import { execFile as execFile2 } from "node:child_process";
var CHROMIUMS = [
  { id: "com.google.Chrome", name: "Google Chrome" },
  { id: "com.microsoft.edgemac", name: "Microsoft Edge" },
  { id: "com.brave.Browser", name: "Brave" },
  { id: "org.chromium.Chromium", name: "Chromium" }
];
async function openInChromium(url, platform = process.platform) {
  if (platform !== "darwin") {
    return { opened: false, why: `opening a browser is only wired up on macOS (this is ${platform})` };
  }
  for (const b of CHROMIUMS) {
    const ok = await new Promise((resolve2) => {
      execFile2("open", ["-b", b.id, url], { timeout: 1e4 }, (err) => resolve2(!err));
    });
    if (ok)
      return { opened: true, browser: b.name };
  }
  return { opened: false, why: `no Chromium browser found (looked for ${CHROMIUMS.map((b) => b.name).join(", ")})` };
}
function hasClientDirs(fsioDir2) {
  try {
    return fs5.readdirSync(path5.join(fsioDir2, "client"), { withFileTypes: true }).some((e) => e.isDirectory());
  } catch {
    return false;
  }
}
async function pageIsWatching(fsioDir2, ms = 3500, stepMs = 250) {
  const until = Date.now() + ms;
  for (; ; ) {
    if (hasClientDirs(fsioDir2))
      return true;
    if (Date.now() >= until)
      return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// dist/helper.js
var fail = (msg) => {
  console.error(`fsio acp-demo: ${msg}`);
  process.exit(1);
};
var USAGE = "usage: fsio-acp-demo [dir] [--fixture] [--agent <name>] [--no-open] [--url <base>]";
var rootArg = null;
var wantFixture = false;
var wantOpen = true;
var urlArg = null;
var agentArg = null;
var argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--fixture")
    wantFixture = true;
  else if (a === "--no-open")
    wantOpen = false;
  else if (a === "--url") {
    urlArg = argv[++i] ?? null;
    if (!urlArg)
      fail(`--url needs a base URL \u2014 ${USAGE}`);
  } else if (a.startsWith("--url="))
    urlArg = a.slice("--url=".length);
  else if (a === "--agent") {
    agentArg = argv[++i] ?? null;
    if (!agentArg)
      fail(`--agent needs a name \u2014 ${USAGE}`);
  } else if (a.startsWith("--agent="))
    agentArg = a.slice("--agent=".length);
  else if (a.startsWith("-"))
    fail(`unknown flag ${a} \u2014 ${USAGE}`);
  else
    rootArg = a;
}
if (wantFixture && agentArg)
  fail(`--fixture and --agent are two ways to say the same thing; pick one \u2014 ${USAGE}`);
var pageBase = urlArg ?? process.env["FSIO_ACP_URL"] ?? DEFAULT_PAGE;
try {
  new URL(pageBase);
} catch {
  fail(`--url ${JSON.stringify(pageBase)} is not a URL \u2014 ${USAGE}`);
}
var root = path6.resolve(rootArg ?? process.cwd());
if (rootArg)
  fs6.mkdirSync(root, { recursive: true });
var rootReal = fs6.realpathSync(root);
var tmpReal = fs6.realpathSync(os3.tmpdir());
if (rootReal.startsWith("/private/tmp") || rootReal.startsWith(tmpReal)) {
  fail(`refusing to run under a temp dir (${rootReal}) \u2014 Chrome's file observers break there (F9). Use a real working folder.`);
}
var demoDir = path6.join(tmpReal, "fsio-acp-demo");
var scratch = path6.join(demoDir, "scratch");
var stateRoot = path6.join(demoDir, "state");
fs6.mkdirSync(scratch, { recursive: true });
fs6.mkdirSync(stateRoot, { recursive: true });
var scratchReal = fs6.realpathSync(scratch);
var FIXTURE = {
  name: "fixture",
  bin: process.execPath,
  args: [path6.join(import.meta.dirname, "fixture-agent.js")],
  title: "PUPPET \u2014 a scripted test agent, not a real one",
  install: "(built with this repo; re-run the helper with --fixture)",
  // Asking is the entire reason it exists: 5 permission asks and 10 `fs/*`
  // calls across the scripted run, measured in test-fixture-agent.ts.
  asks: true,
  state: {
    mode: "place",
    env: "FSIO_FIXTURE_STATE",
    why: "the puppet keeps no state; a placed dir it never writes to leaves the profile with no carve at all."
  }
};
if (wantFixture && !fs6.existsSync(FIXTURE.args[0])) {
  fail(`--fixture: the puppet is not built (expected ${FIXTURE.args[0]}). Run \`npm run build\`.`);
}
if (agentArg && !AGENTS.some((a) => a.name === agentArg)) {
  fail(`--agent ${JSON.stringify(agentArg)}: this helper serves ${AGENTS.map((a) => a.name).join(", ")}`);
}
var catalogue = wantFixture ? [FIXTURE] : agentArg ? AGENTS.filter((a) => a.name === agentArg) : AGENTS;
var offer = (a) => `    ${a.name.padEnd(17)} ${a.title}
      ${a.install}`;
var tilde = (p) => p.startsWith(os3.homedir() + path6.sep) ? `~${p.slice(os3.homedir().length)}` : p;
var rosterNow = () => roster(catalogue);
var line = (tag, a) => console.log((/* @__PURE__ */ new Date()).toISOString(), ...tag ? [tag] : [], ...a);
var log = {
  info: (...a) => line("", a),
  warn: (...a) => line("[warn]", a),
  error: (...a) => line("[error]", a)
};
var fsioDir = path6.join(rootReal, ".fsio");
var folderHasSeenAPage = hasClientDirs(fsioDir);
var TRANSCRIPT_KEEP = 10;
var server = new HostServer({
  root: rootReal,
  // The allow-list is the gate; the policy narrates.
  // `origin` is advisory (D15): display is exactly its job.
  onSpawnRequest: (spec, info) => {
    log.info(`\u25CF page connected \u2014 origin: ${info.origin ?? "(none reported)"} \xB7 ${info.kind}${spec["agent"] ? ` (${String(spec["agent"])})` : ""}`);
    return true;
  },
  fresh: true,
  // demo restarts should never inherit stale sessions
  // …but a restart must not eat the conversations either (#119). `fresh`
  // is right that a session pointing at a dead pid is not attachable and
  // right to sweep the plumbing; it was wrong that the out log is plumbing.
  // For this demo that file IS the conversation — the agent's half of it,
  // which the page deliberately does not persist browser-side because
  // "it rode the folder, so the folder is where it is read back from"
  // (P2). The folder now keeps its side of that bargain.
  //
  // The count is stated here rather than inherited because the banner
  // promises it out loud, and a promise about the user's own project
  // directory is not a thing to leave to a default two packages away.
  transcripts: { keep: TRANSCRIPT_KEEP },
  // This demo serves exactly one kind and it is not `shell`; a pty would
  // never be reached. Saying so keeps the npx artifact (which bundles no
  // node_modules) from opening with advice about a package nobody here needs.
  pty: false,
  logger: log
});
server.registerKind("acp", acpKind({
  root: rootReal,
  fsioDir,
  tmp: scratchReal,
  stateRoot,
  // The page names an agent from this list or names none; either way the
  // wire never contributes a path (agents.ts). `--fixture` narrows the
  // list to one, so a page asking for "pi-acp" here is refused by the same
  // allow-list that refuses anything else it does not serve.
  agents: catalogue
}));
var publishRoster = () => void server.setServices({ kindDetail: { acp: { agents: rosterNow() } } });
publishRoster();
await server.start().catch((e) => fail(e instanceof Error ? e.message : String(e)));
var rosterTimer = setInterval(publishRoster, 3e3);
var offerable = catalogue.find((a) => a.recommended && a.pkg) ?? catalogue.find((a) => a.pkg);
if (!wantFixture && offerable && !rosterNow().some((a) => a.installed)) {
  const dest = agentDir(offerable.name);
  const yes = await confirm(`
!! no ACP agent on this machine.

   install ${offerable.title}?
     ${offerable.pkg.name}@${offerable.pkg.version}  \u2192  ${tilde(dest)}
     ~293 MB; no install scripts are run; nothing is put on your PATH
     ${offerable.asks ? "it asks before it edits, which is the part of this demo worth watching" : "it edits with its own hands \u2014 no permission card"}
     undo:  rm -rf ${tilde(dest)}
     pinned so everyone who takes this offer gets the same build \u2014 which
     also means the copy ages until somebody bumps it here.

   Or answer n and install it yourself, any way you like:  ${installLine(offerable)}

   install it? [y/N] `);
  if (yes) {
    console.log(`   installing ${offerable.pkg.name}@${offerable.pkg.version}\u2026`);
    const res = await installAgent(offerable);
    if (res.ok) {
      console.log(`   installed \u2192 ${tilde(res.dir)}`);
      publishRoster();
    } else {
      console.log(`   install failed; carrying on without it:
${res.error}`);
    }
  }
}
var folderName = path6.basename(rootReal);
var startupRoster = rosterNow();
var installed = startupRoster.filter((a) => a.installed);
var missing = startupRoster.filter((a) => !a.installed);
console.log(`
fsio ACP demo \xB7 serving ${rootReal}${wantFixture ? `
  !! --fixture: this is a PUPPET, not an agent. It calls no model and thinks
  nothing. It asks permission and has no hands: every file it reads or writes
  goes through the page. It exists to make the permission card and the fs/*
  handlers actually run (#100).
    try:  "go"        propose an edit, ask, write when you allow it
          "refuse"    reach outside the folder and read the refusals back
          "many"      three separate asks in one turn
          "read"      a read, which needs no card \u2014 you granted the folder
          "markdown"  what the page renders, and the four things it won't` : ""}
  ${installed.length ? (
  // Which copy, every time (#124). Two can exist — a PATH install and
  // one under ~/.fsio/agents — and a demo that silently drove the
  // other one is a debugging trap that looks like a version bug.
  `agents available here: ${installed.map((a) => `${a.name}${a.via === "fsio" ? " (~/.fsio/agents)" : ""}`).join(", ")}${missing.length ? `
  also known, not installed:
` + missing.map(offer).join("\n") : ""}`
) : `!! no ACP agent here. The helper is running anyway \u2014 the page shows this
  same list and updates itself when one appears, so you can install without
  restarting anything:

` + missing.map(offer).join("\n") + // 293 MB / 111 packages measured 2026-08-02 against
// claude-agent-acp@0.64.2 (install.ts). The old ~118 MB figure was
// the deprecated Zed adapter's, and it had outlived the package it
// described.
`

  fsio ships none of them on purpose (#100): vendoring one costs ~293 MB of
  transitive dependencies, and an agent you installed is one you can also
  inspect, update, and revoke.`}

  in the page: pick this folder \u2014 ${folderName} \u2014 and allow it twice. Those
  clicks are Chrome's and cannot be automated (F15); they are also the whole
  security model, so they are the three gestures worth keeping.

(Ctrl-C ends the agents and sweeps .fsio; the newest ${TRANSCRIPT_KEEP} conversations
  are kept in .fsio/transcripts/, and a page that self-reported leaves its
  report in .fsio/client/)
`);
var soleAgent = rosterNow().filter((a) => a.installed);
var pageUrl = launchUrl(pageBase, {
  dir: folderName,
  agent: soleAgent.length === 1 ? soleAgent[0].name : null
});
console.log(`  ${pageUrl}
`);
if (!wantOpen) {
  console.log("--no-open: opening nothing. Paste that into a Chromium browser.\n");
} else if (folderHasSeenAPage && await pageIsWatching(fsioDir)) {
  console.log("a page is already open on this folder \u2014 not opening another tab.\n");
} else {
  const res = await openInChromium(pageUrl);
  console.log(res.opened ? `opened in ${res.browser}.
` : `${res.why} \u2014 open that URL yourself, in Chrome or another Chromium.
`);
}
var closing = false;
var shutdown = async (signal) => {
  if (closing)
    return;
  closing = true;
  clearInterval(rosterTimer);
  console.log(`
${signal} \u2014 closing sessions\u2026`);
  await server.close();
  server.cleanServiceDir(true);
  const kept = fs6.existsSync(server.transcriptsDir) ? fs6.readdirSync(server.transcriptsDir).length : 0;
  const clientDir = path6.join(fsioDir, "client");
  const reports = fs6.existsSync(clientDir) ? fs6.readdirSync(clientDir).length : 0;
  const left = [
    kept ? `${kept} conversation${kept === 1 ? "" : "s"} in .fsio/transcripts/` : "",
    reports ? `${reports} page report${reports === 1 ? "" : "s"} in .fsio/client/` : ""
  ].filter(Boolean);
  console.log(left.length ? `done; .fsio swept, ${left.join(" and ")} kept.` : "done; .fsio removed.");
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
