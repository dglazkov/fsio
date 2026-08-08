#!/usr/bin/env node
// fsio terminal-demo helper — generated bundle; source: packages/terminal-demo (github.com/dglazkov/fsio)

// dist/helper.js
import fs3 from "node:fs";
import os from "node:os";
import path2 from "node:path";

// ../confine/dist/argv.js
import fs from "node:fs";
var SANDBOX_EXEC = "/usr/bin/sandbox-exec";
function sandboxArgv(cfg2, file, args) {
  return {
    file: SANDBOX_EXEC,
    args: ["-f", cfg2.profilePath, "-D", `ROOT=${cfg2.root}`, "-D", `FSIO=${cfg2.fsio}`, "-D", `TMP=${cfg2.tmp}`, file, ...args]
  };
}
function assertSandboxUsable(cfg2) {
  fs.accessSync(cfg2.profilePath, fs.constants.R_OK);
  fs.accessSync(SANDBOX_EXEC, fs.constants.X_OK);
}

// ../confine/dist/profile.js
var sbplString = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
var sbplRegex = (s) => {
  if (/["\\]/.test(s))
    throw new Error(`confine: refusing a pattern containing a quote or backslash: ${s}`);
  return `#"${s}"`;
};
var comment = (text) => text.trim().split("\n").map((l) => l.trim() ? `;; ${l.trim()}` : ";;").join("\n");
function sandboxProfile(inputs) {
  const carves = (inputs.carves ?? []).map((c) => [
    comment(c.why),
    ...(c.dirs ?? []).map((d) => `(allow file-write* (subpath ${sbplString(d)}))`),
    ...(c.patterns ?? []).map((p) => `(allow file-write* (regex ${sbplRegex(p)}))`)
  ].join("\n")).join("\n\n");
  return `(version 1)

${comment(inputs.subject)}
;;
${comment(inputs.posture)}

;; Everything that is not a file write: allowed (process-exec, network,
;; file-read*, signals, ...). The wall held here is what the child may
;; MODIFY \u2014 not what it can see, and not who it can talk to.
(allow default)

;; The wall: no file writes anywhere...
(deny file-write*)

;; ...except the shared folder \u2014 the one the human granted the page, now
;; granted to the child the page drives. That symmetry is the point.
(allow file-write* (subpath (param "ROOT")))

;; ...the scratch dir the child is handed as TMPDIR,
(allow file-write* (subpath (param "TMP")))

;; ...and the bit bucket.
(allow file-write* (literal "/dev/null"))
${carves ? "\n" + carves + "\n" : ""}
;; Final word (last match wins): the protocol area inside ROOT stays
;; host-owned even though ROOT is writable. A child that could edit .fsio
;; could corrupt or spoof its own transport (D6) \u2014 including the frames
;; carrying the permission prompts the human is answering.
(deny file-write* (subpath (param "FSIO")))
`;
}
function profileSummary(folder, alsoWrites = []) {
  const also = alsoWrites.length ? `, and ${alsoWrites.join(", ")}` : "";
  return `writes: ${folder}/ (not .fsio), a scratch dir${also} \u2014 nothing else. reads: everything you can read. network: on.`;
}

// ../host/dist/host-server.js
import fs2 from "node:fs";
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
  fs2.writeFileSync(tmp, data);
  fs2.renameSync(tmp, file);
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
    return within(fs2.realpathSync(root2), fs2.realpathSync(p));
  } catch {
    return true;
  }
}
function readJson(file) {
  try {
    return JSON.parse(fs2.readFileSync(file, "utf8"));
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
    const fd = fs2.openSync(this.segPath(this.outGen), "a");
    fs2.writeSync(fd, bytes);
    fs2.closeSync(fd);
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
        fs2.unlinkSync(this.segPath(seg.gen));
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
      const parsed = JSON.parse(fs2.readFileSync(path.join(this.fsioDir, "services.json"), "utf8"));
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
    fs2.mkdirSync(this.sessionsDir, { recursive: true });
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
      fs2.unlinkSync(path.join(this.fsioDir, "host.json"));
    } catch {
    }
    return Promise.all(reaps).then(() => {
    });
  }
  // Wait for a killed child to actually exit; escalate to SIGKILL after the
  // grace period. Timers are unref'd and capped — close() can never hang a
  // process that wants to exit.
  reapChild(id, proc, usesPty) {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled)
          return;
        settled = true;
        clearTimeout(escalate);
        clearTimeout(cap);
        resolve();
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
      ageMs = Date.now() - fs2.statSync(hostJson).mtimeMs;
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
      if (fs2.existsSync(path.join(dir, ".git")))
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
        text = fs2.readFileSync(file, "utf8");
      } catch {
      }
      if (text.split("\n").some((l) => /^\/?\.fsio\/?$/.test(l.trim())))
        return;
      const sep = text.length > 0 && !text.endsWith("\n") ? "\n" : "";
      fs2.appendFileSync(file, `${sep}# fsio transport state \u2014 session scrollback lives here
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
      const w = fs2.watch(p, cb);
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
      entries = fs2.readdirSync(root2, { withFileTypes: true });
    } catch {
      return;
    }
    const dirs = [];
    for (const e of entries) {
      if (!e.isDirectory())
        continue;
      try {
        const p = path.join(root2, e.name);
        let mtime = fs2.statSync(p).mtimeMs;
        try {
          mtime = Math.max(mtime, fs2.statSync(path.join(p, "report.json")).mtimeMs);
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
        fs2.rmSync(path.join(root2, d.name), { recursive: true, force: true });
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
      logs = fs2.readdirSync(s.dir).filter((n) => OUT_LOG_RE.test(n)).sort();
    } catch {
      return;
    }
    if (!logs.length)
      return;
    const dir = path.join(this.transcriptsDir, s.id);
    try {
      fs2.mkdirSync(dir, { recursive: true });
      let bytes = 0;
      for (const name of logs) {
        const to = path.join(dir, name);
        fs2.renameSync(path.join(s.dir, name), to);
        bytes += fs2.statSync(to).size;
      }
      try {
        fs2.copyFileSync(path.join(s.dir, "spawn.json"), path.join(dir, "spawn.json"));
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
    const cfg2 = this.transcripts;
    if (!cfg2)
      return;
    let entries;
    try {
      entries = fs2.readdirSync(this.transcriptsDir, { withFileTypes: true });
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
        for (const f of fs2.readdirSync(dir))
          bytes += fs2.statSync(path.join(dir, f)).size;
        ended = readJson(path.join(dir, "meta.json"))?.ended ?? fs2.statSync(dir).mtimeMs;
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
      const over = i >= cfg2.keep ? `over the ${cfg2.keep}-transcript cap` : i > 0 && running > cfg2.maxBytes ? `over the ${cfg2.maxBytes} B cap` : null;
      if (!over)
        continue;
      try {
        fs2.rmSync(path.join(this.transcriptsDir, t.name), { recursive: true, force: true });
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
      entries = fs2.readdirSync(this.fsioDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (keep.has(e.name))
        continue;
      try {
        fs2.rmSync(path.join(this.fsioDir, e.name), { recursive: true, force: true });
      } catch {
      }
    }
    try {
      fs2.rmdirSync(this.fsioDir);
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
      entries = fs2.readdirSync(this.sessionsDir, { withFileTypes: true });
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
      names = fs2.readdirSync(s.dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (!/^attach\.[A-Za-z0-9_-]+\.json$/.test(name))
        continue;
      const p = path.join(s.dir, name);
      const raw = readJson(p);
      try {
        fs2.unlinkSync(p);
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
      fs2.mkdirSync(s.inDir, { recursive: true });
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
      names = fs2.readdirSync(s.inDir);
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
          bytes = fs2.readFileSync(p);
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
        fs2.rmdirSync(p);
      else
        fs2.unlinkSync(p);
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
      fs2.rmSync(s.dir, { recursive: true, force: true });
      this.sessions.delete(s.id);
      this.log.info(`session ${s.id}: removed (${why})`);
    } catch (e) {
      this.log.warn(`session ${s.id}: cleanup failed: ${errMsg(e)}`);
    }
  }
};

// dist/profile.js
var SHELL_PROFILE = sandboxProfile({
  subject: "terminal-demo shell sandbox (fsio #16).",
  posture: `Posture: read the world, write only the shared folder \u2014 minus
the protocol's own .fsio area \u2014 plus the scratch space a shell needs to
be usable. Network is deliberately allowed (working-folder use: git
pull, npm install). The threat model is "a remote page drives a local
shell".`,
  carves: [
    {
      why: `...and /tmp as well as TMPDIR: shells, git, editors and
installers assume a writable temp dir, and enough of them hardcode
/tmp rather than reading the variable that denying it makes the
shell feel broken in ways nobody would connect to a sandbox.`,
      dirs: ["/private/tmp"]
    },
    {
      why: `...and the device an interactive shell IS: its own pty. A
child on a pipe gets no such rule \u2014 this one is here because a human
is sitting at this one, watching its output.`,
      patterns: ["^/dev/tty"]
    }
  ]
});

// dist/sandbox.js
function sandboxedPty(real, cfg2) {
  return {
    spawn(file, args, opts) {
      try {
        assertSandboxUsable(cfg2);
        const wrapped = sandboxArgv(cfg2, file, args);
        return real.spawn(wrapped.file, wrapped.args, opts);
      } catch (e) {
        return deadPty(e instanceof Error ? e.message : String(e));
      }
    }
  };
}
function deadPty(reason) {
  const dataCbs = [];
  const exitCbs = [];
  setTimeout(() => {
    for (const cb of dataCbs)
      cb(`sandbox spawn failed (refusing unsandboxed fallback): ${reason}\r
`);
    for (const cb of exitCbs)
      cb({ exitCode: 127 });
  }, 0);
  return {
    pid: -1,
    write() {
    },
    resize() {
    },
    kill() {
    },
    pause() {
    },
    resume() {
    },
    onData(cb) {
      dataCbs.push(cb);
    },
    onExit(cb) {
      exitCbs.push(cb);
    }
  };
}

// dist/helper.js
var fail = (msg) => {
  console.error(`fsio terminal-demo: ${msg}`);
  process.exit(1);
};
if (process.platform !== "darwin") {
  fail(`this demo is macOS-only (sandbox-exec confinement); got ${process.platform}`);
}
var realPty = await import("node-pty").catch((e) => fail(`node-pty failed to load (${e instanceof Error ? e.message : e}) \u2014 the demo needs a real pty. Try reinstalling.`));
var rootArg = process.argv[2];
if (rootArg?.startsWith("-"))
  fail(`unknown flag ${rootArg} \u2014 usage: fsio-terminal-helper [dir]`);
var root = path2.resolve(rootArg ?? process.cwd());
if (rootArg)
  fs3.mkdirSync(root, { recursive: true });
var rootReal = fs3.realpathSync(root);
var tmpReal = fs3.realpathSync(os.tmpdir());
if (rootReal.startsWith("/private/tmp") || rootReal.startsWith(tmpReal)) {
  fail(`refusing to run under a temp dir (${rootReal}) \u2014 Chrome's file observers break there (F9). Use a real working folder.`);
}
var line = (tag, a) => console.log((/* @__PURE__ */ new Date()).toISOString(), ...tag ? [tag] : [], ...a);
var log = {
  info: (...a) => line("", a),
  warn: (...a) => line("[warn]", a),
  error: (...a) => line("[error]", a)
};
var fsioDir = path2.join(rootReal, ".fsio");
var profilePath = path2.join(fsioDir, "sandbox.sb");
var cfg = { profilePath, root: rootReal, fsio: fsioDir, tmp: tmpReal };
var pty = sandboxedPty(realPty, cfg);
process.env["SHELL_SESSIONS_DISABLE"] = "1";
process.env["HISTFILE"] = path2.join(tmpReal, "fsio-terminal-demo-history");
process.env["CLAUDE_CONFIG_DIR"] = path2.join(tmpReal, "fsio-terminal-demo-agent-state");
var server = new HostServer({
  root: rootReal,
  // The sandbox is the gate; the policy only narrates (#16 ledger: no y/N
  // prompt — it allows everything a default --allow-shell host would).
  // `origin` is advisory (D15): display is exactly its job.
  onSpawnRequest: (_spec, info) => {
    log.info(`\u25CF page connected \u2014 origin: ${info.origin ?? "(none reported)"} \xB7 ${info.kind}${info.cmd ? ` (${info.cmd})` : ""}`);
    return true;
  },
  fresh: true,
  // demo restarts should never inherit stale sessions
  pty,
  logger: log
});
await server.start().catch((e) => fail(e instanceof Error ? e.message : String(e)));
fs3.writeFileSync(profilePath, SHELL_PROFILE);
await new Promise((resolve, reject) => {
  let out = "";
  const p = pty.spawn("/bin/sh", ["-c", "echo __FSIO_SANDBOX_OK__"], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: rootReal,
    env: process.env
  });
  p.onData((d) => out += d);
  p.onExit(({ exitCode }) => {
    if (exitCode === 0 && out.includes("__FSIO_SANDBOX_OK__"))
      resolve();
    else
      reject(new Error(`preflight shell failed (exit ${exitCode}): ${out.trim()}`));
  });
  setTimeout(() => reject(new Error("preflight timed out (5s)")), 5e3).unref();
}).catch(async (e) => {
  await server.close();
  fs3.rmSync(fsioDir, { recursive: true, force: true });
  fail(e.message);
});
var folderName = path2.basename(rootReal);
console.log(`
fsio terminal demo \xB7 serving ${rootReal}
  shells are confined to this folder:
    ${profileSummary(folderName, ["/private/tmp"])}
  The whole policy is .fsio/sandbox.sb \u2014 read it from the folder itself.

  \u2192 back in the demo page, pick the folder:  ${folderName}

waiting for a browser\u2026 (Ctrl-C stops the helper and cleans up .fsio; a page
  that self-reported leaves its report in .fsio/client/)
`);
var closing = false;
var shutdown = async (signal) => {
  if (closing)
    return;
  closing = true;
  console.log(`
${signal} \u2014 closing sessions\u2026`);
  await server.close();
  server.cleanServiceDir(true);
  const clientDir = path2.join(fsioDir, "client");
  const reports = fs3.existsSync(clientDir) ? fs3.readdirSync(clientDir).length : 0;
  console.log(reports ? `done; .fsio swept, ${reports} page report${reports === 1 ? "" : "s"} kept in .fsio/client/.` : "done; .fsio removed.");
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
