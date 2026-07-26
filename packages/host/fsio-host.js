#!/usr/bin/env node
// fsio host: attaches to <dir>/.fsio, serves sessions created by clients.
//
// Usage:
//   node packages/host/fsio-host.js <dir> [--allow-shell] [--poll <ms>] [--no-watch] [--fresh]
//
//   --allow-shell   permit `kind: "shell"` sessions (spawns processes!)
//   --hot <ms>      hot-poll interval while sessions are active (default 5, 0=off)
//   --poll <ms>     add an unconditional poll loop at <ms> interval
//   --no-watch      disable fs.watch (pure polling; use with --poll to measure)
//   --fresh         wipe .fsio on startup

import fs from "node:fs";
import path from "node:path";
import { spawn as cpSpawn } from "node:child_process";
import {
  FrameType,
  frameTypeName,
  encodeFrame,
  jsonFrame,
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
} from "@fsio/common";

const HEARTBEAT_MS = 2000;
const SAFETY_POLL_MS = 250;
const IDLE_GC_MS = 5 * 60_000; // echo sessions with no traffic get removed
// Flow control (spec: segmented out log + ack window). A `find .` produced
// 60 MB of scrollback in one file with nothing telling the pty to slow down.
const SEG_MAX = 8 * 1024 * 1024; // rotate segment at 8 MB
const ACK_WINDOW = 4 * 1024 * 1024; // pause output when unacked exceeds this
const ACK_RESUME = 2 * 1024 * 1024; // resume when unacked drops below this
const RETRY_MS = 5; // fast retry when a chunk looks torn/empty

// ---------------------------------------------------------------- args

const args = process.argv.slice(2);
const flags = { allowShell: false, poll: 0, hot: 5, watch: true, fresh: false };
let rootArg = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--allow-shell") flags.allowShell = true;
  else if (a === "--poll") flags.poll = Number(args[++i]);
  else if (a === "--hot") flags.hot = Number(args[++i]);
  else if (a === "--no-watch") flags.watch = false;
  else if (a === "--fresh") flags.fresh = true;
  else if (!a.startsWith("-")) rootArg = a;
  else {
    console.error(`unknown flag: ${a}`);
    process.exit(1);
  }
}
if (!rootArg) {
  console.error("usage: fsio-host <dir> [--allow-shell] [--poll ms] [--no-watch] [--fresh]");
  process.exit(1);
}

const sharedDir = path.resolve(rootArg);
const fsioDir = path.join(sharedDir, ".fsio");
const sessionsDir = path.join(fsioDir, "sessions");

if (flags.fresh) fs.rmSync(fsioDir, { recursive: true, force: true });
fs.mkdirSync(sessionsDir, { recursive: true });

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- helpers

function writeFileAtomic(file, data) {
  const tmp = path.join(path.dirname(file), `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function writeJsonAtomic(file, obj) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function watchDir(p, cb) {
  if (!flags.watch) return null;
  try {
    const w = fs.watch(p, cb);
    w.on("error", () => {});
    return w;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- node-pty (optional)

let ptyMod = null;
try {
  ptyMod = await import("node-pty");
  log("node-pty available: shell sessions get a real pty");
} catch {
  log("node-pty not installed: shell sessions fall back to pipes (no pty). `npm i node-pty` for full terminal support.");
}

// ---------------------------------------------------------------- session state

/** @type {Map<string, Session>} */
const sessions = new Map();

class Session {
  constructor(id) {
    this.id = id;
    this.dir = path.join(sessionsDir, id);
    this.inDir = path.join(this.dir, "in");
    this.spawn = null; // spawn params (from the JSON-RPC request in spawn.json)
    this.spawnId = null; // request id to answer (null = legacy bare spec)
    this.spawnAnswered = false;
    this.started = false;
    this.done = false;
    this.nextInSeq = null; // discovered from the smallest chunk present
    // Output stream state: segmented log + cumulative byte accounting.
    this.outGen = 0; // current segment number
    this.segBytes = 0; // bytes in current segment
    this.prevFinal = 0; // final size of segment outGen-1 (for reader handoff)
    this.outTotal = 0; // cumulative bytes ever appended
    this.ackTotal = 0; // cumulative bytes the client has confirmed consuming
    this.paused = false; // output paused waiting for acks
    this.doneSegs = []; // finished segments: {gen, endTotal}
    this.proc = null; // pty or child process
    this.usesPty = false;
    this.watchers = [];
    this.retryTimer = null;
    this.lastActivity = Date.now();
  }

  segPath(gen) {
    return path.join(this.dir, `out.${String(gen).padStart(8, "0")}.log`);
  }

  // Append with open/write/close per call, then bump a rename-committed
  // doorbell file. Rationale (measured, spec/FINDINGS.md F1): on macOS, appends through
  // a long-held fd are nearly invisible to FSEvents-backed watchers — events
  // fire on close() and renames, not on in-place writes.
  // Segments always rotate on frame boundaries (rotation happens between
  // appends), so every segment is independently parseable.
  appendFrame(type, payload) {
    const bytes = encodeFrame(type, payload);
    const fd = fs.openSync(this.segPath(this.outGen), "a");
    fs.writeSync(fd, bytes);
    fs.closeSync(fd);
    this.segBytes += bytes.length;
    this.outTotal += bytes.length;
    if (this.segBytes >= SEG_MAX) {
      this.doneSegs.push({ gen: this.outGen, endTotal: this.outTotal });
      this.prevFinal = this.segBytes;
      this.outGen++;
      this.segBytes = 0;
      this.gcSegments();
    }
    // Doorbell doubles as the reader's map: current segment, its size, the
    // final size of the previous segment, and the cumulative total.
    writeFileAtomic(
      path.join(this.dir, "out.sig"),
      JSON.stringify({ gen: this.outGen, size: this.segBytes, prevFinal: this.prevFinal, total: this.outTotal })
    );
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
      } catch {}
    }
  }

  checkWindow() {
    if (!this.proc) return;
    const unacked = this.outTotal - this.ackTotal;
    if (!this.paused && unacked > ACK_WINDOW) {
      this.paused = true;
      try {
        this.usesPty ? this.proc.pause() : (this.proc.stdout.pause(), this.proc.stderr.pause());
      } catch {}
      log(`session ${this.id}: output paused (${(unacked / 1048576).toFixed(1)} MB unacked)`);
    } else if (this.paused && unacked <= ACK_RESUME) {
      this.paused = false;
      try {
        this.usesPty ? this.proc.resume() : (this.proc.stdout.resume(), this.proc.stderr.resume());
      } catch {}
      log(`session ${this.id}: output resumed`);
    }
  }

  appendJson(type, obj) {
    this.appendFrame(type, new TextEncoder().encode(JSON.stringify(obj)));
  }

  setStatus(obj) {
    writeJsonAtomic(path.join(this.dir, "status.json"), { t: now(), ...obj });
  }

  // Answer the spawn request (once) on the out stream. Errors get real
  // JSON-RPC error objects instead of a status.json state the client must
  // poll for and interpret. Duplicated answers (host restart re-adopting a
  // session) are fine: clients ignore responses with unknown ids.
  answerSpawn(msg) {
    if (this.spawnId === null || this.spawnAnswered) return;
    this.spawnAnswered = true;
    this.appendJson(FrameType.RPC, msg);
  }

  spawnOk(result) {
    this.answerSpawn(rpcResult(this.spawnId, result));
  }

  spawnFail(code, message) {
    this.answerSpawn(rpcError(this.spawnId, code, message));
  }

  scheduleRetry() {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      scheduleScan();
    }, RETRY_MS);
  }

  close() {
    this.done = true;
    for (const w of this.watchers) w?.close();
    this.watchers = [];
    if (this.proc) {
      try {
        this.usesPty ? this.proc.kill() : this.proc.kill("SIGTERM");
      } catch {}
      this.proc = null;
    }
  }
}

// ---------------------------------------------------------------- scan loop
// fs.watch events are treated purely as wakeups; every wake runs a full,
// idempotent scan. A slow safety poll catches anything watch misses.

let scanning = false;
let rescan = false;

function scheduleScan() {
  if (scanning) {
    rescan = true;
    return;
  }
  runScan();
}

async function runScan() {
  scanning = true;
  do {
    rescan = false;
    try {
      scanOnce();
    } catch (e) {
      log("scan error:", e.message);
    }
  } while (rescan);
  scanning = false;
}

function scanOnce() {
  let entries;
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!sessions.has(e.name)) adoptSession(e.name);
  }
  for (const s of sessions.values()) {
    if (s.done) continue;
    if (!s.started) tryStart(s);
    if (s.started) processIncoming(s);
  }
}

function adoptSession(id) {
  const s = new Session(id);
  sessions.set(id, s);
  const status = readJson(path.join(s.dir, "status.json"));
  if (status && status.state === "exited") {
    s.done = true;
    // Stale leftover (e.g. host restarted before cleanup): GC after a grace
    // period so a client can still read the final out.log.
    if (now() - (status.t ?? 0) > 60_000) removeSessionDir(s, "stale");
    return;
  }
  s.watchers.push(watchDir(s.dir, scheduleScan));
  log(`session ${id}: adopted`);
}

function tryStart(s) {
  const raw = readJson(path.join(s.dir, "spawn.json"));
  if (!raw) return; // not written yet; a watch event will re-trigger
  // spawn.json carries a JSON-RPC "spawn" request (the file is the bootstrap
  // transport; the response rides the out stream). Legacy bare specs are
  // tolerated: no id, no response, status.json only.
  if (raw.jsonrpc === "2.0" && raw.method === "spawn") {
    s.spawn = raw.params ?? {};
    s.spawnId = raw.id ?? null;
  } else {
    s.spawn = raw;
  }
  s.started = true;
  s.watchers.push(watchDir(s.inDir, scheduleScan));
  const kind = s.spawn.kind ?? "echo";
  log(`session ${s.id}: start kind=${kind}`);
  if (kind === "echo") {
    s.setStatus({ state: "running", kind, pid: process.pid });
    s.spawnOk({ kind, pid: process.pid });
  } else if (kind === "shell") {
    if (!flags.allowShell) {
      const error = "shell sessions not allowed; start host with --allow-shell";
      s.setStatus({ state: "error", error });
      s.spawnFail(RpcErrors.SHELL_NOT_ALLOWED, error);
      s.done = true;
      return;
    }
    startShell(s);
  } else {
    const error = `unknown kind: ${kind}`;
    s.setStatus({ state: "error", error });
    s.spawnFail(RpcErrors.UNKNOWN_KIND, error);
    s.done = true;
  }
}

function startShell(s) {
  const spec = s.spawn;
  const cmd = spec.cmd || process.env.SHELL || "/bin/bash";
  const cmdArgs = spec.args ?? [];
  const cols = spec.cols ?? 80;
  const rows = spec.rows ?? 24;
  const cwd = spec.cwd ? path.resolve(sharedDir, spec.cwd) : sharedDir;

  // A spawn failure must never be silent: the client is watching status.json
  // and will otherwise stare at an empty terminal forever.
  if (ptyMod && spec.pty !== false) {
    try {
      const p = ptyMod.spawn(cmd, cmdArgs, {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: process.env,
      });
      s.proc = p;
      s.usesPty = true;
      p.onData((d) => s.appendFrame(FrameType.DATA, Buffer.from(d)));
      p.onExit(({ exitCode }) => {
        log(`session ${s.id}: exited code=${exitCode}`);
        s.setStatus({ state: "exited", exitCode });
        s.proc = null;
      });
      s.setStatus({ state: "running", kind: "shell", pty: true, pid: p.pid, cmd });
      s.spawnOk({ kind: "shell", pty: true, pid: p.pid, cmd });
      return;
    } catch (e) {
      log(`session ${s.id}: pty spawn failed (${e.message}); falling back to pipes`);
    }
  }
  try {
    const p = cpSpawn(cmd, cmdArgs, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    // ENOENT etc. arrive async; answer the spawn request only once the
    // outcome is known ('spawn' fires on success, 'error' instead of it).
    p.on("spawn", () => s.spawnOk({ kind: "shell", pty: false, pid: p.pid, cmd }));
    p.on("error", (e) => {
      log(`session ${s.id}: spawn error: ${e.message}`);
      s.setStatus({ state: "error", error: `could not start ${cmd}: ${e.message}` });
      s.spawnFail(RpcErrors.SPAWN_FAILED, `could not start ${cmd}: ${e.message}`);
      s.proc = null;
    });
    s.proc = p;
    p.stdout.on("data", (d) => s.appendFrame(FrameType.DATA, d));
    p.stderr.on("data", (d) => s.appendFrame(FrameType.DATA, d));
    p.on("exit", (code) => {
      log(`session ${s.id}: exited code=${code}`);
      s.setStatus({ state: "exited", exitCode: code });
      s.proc = null;
    });
    s.setStatus({ state: "running", kind: "shell", pty: false, pid: p.pid, cmd });
  } catch (e) {
    log(`session ${s.id}: spawn failed: ${e.message}`);
    s.setStatus({ state: "error", error: `could not start ${cmd}: ${e.message}` });
    s.spawnFail(RpcErrors.SPAWN_FAILED, `could not start ${cmd}: ${e.message}`);
    s.done = true;
  }
}

// Consume in/ chunks strictly in sequence order. Two kinds share one
// sequence space: NNNNNNNN.f files (payload = content) and
// NNNNNNNN-<b64url> directories (payload = name; experimental fast lane).
function processIncoming(s) {
  let names;
  try {
    names = fs.readdirSync(s.inDir);
  } catch {
    return; // in/ not created yet
  }
  const chunks = new Map(); // seq -> {name, data?}
  for (const n of names) {
    let m;
    if ((m = CHUNK_RE.exec(n))) chunks.set(Number(m[1]), { name: n });
    else if ((m = DIR_CHUNK_RE.exec(n))) chunks.set(Number(m[1]), { name: n, data: m[2] });
  }
  if (chunks.size === 0) return;
  if (s.nextInSeq === null) s.nextInSeq = Math.min(...chunks.keys());

  while (chunks.has(s.nextInSeq)) {
    const chunk = chunks.get(s.nextInSeq);
    const p = path.join(s.inDir, chunk.name);
    let bytes;
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
    for (const f of frames) handleFrame(s, f, t1);
    if (chunk.data !== undefined) fs.rmdirSync(p); // consumption ack
    else fs.unlinkSync(p);
    s.nextInSeq++;
  }
}

function handleFrame(s, frame, t1) {
  switch (frame.type) {
    case FrameType.DATA: {
      if (!s.proc) break;
      if (s.usesPty) s.proc.write(Buffer.from(frame.payload).toString("utf8"));
      else s.proc.stdin.write(Buffer.from(frame.payload));
      break;
    }
    case FrameType.RPC: {
      let msg;
      try {
        msg = decodeJson(frame.payload);
      } catch (e) {
        s.appendJson(FrameType.RPC, rpcError(null, RpcErrors.PARSE_ERROR, `unparseable RPC frame: ${e.message}`));
        break;
      }
      handleRpc(s, msg, t1);
      break;
    }
    default:
      log(`session ${s.id}: ignoring frame type ${frameTypeName(frame.type)}`);
  }
}

// Control plane: JSON-RPC 2.0, one message per RPC frame (spec D10).
// Requests get responses on the out stream; notifications are
// fire-and-forget; responses from the client are not expected (the host
// never sends requests in v0) and are ignored.
function handleRpc(s, msg, t1) {
  const { id, method, params = {} } = msg;
  if (method === undefined) return; // a response; host has no pending requests
  const isRequest = id !== undefined;
  switch (method) {
    case "ping":
      // Result echoes params (filler exercises the downlink under payload
      // tests) plus host receive/append timestamps for leg attribution.
      if (isRequest) s.appendJson(FrameType.RPC, rpcResult(id, { ...params, t1, t2: now() }));
      break;
    case "resize":
      if (s.proc && s.usesPty) s.proc.resize(params.cols, params.rows);
      break;
    case "ack":
      s.ack(params.total);
      break;
    case "signal":
      if (s.proc) {
        try {
          s.usesPty ? s.proc.kill(params.sig) : s.proc.kill(params.sig ?? "SIGTERM");
        } catch {}
      }
      break;
    case "eof":
      if (s.proc && !s.usesPty) s.proc.stdin.end();
      break;
    case "close":
      log(`session ${s.id}: closed by client`);
      s.setStatus({ state: "exited", exitCode: null, closedByClient: true });
      s.close();
      // Cleanup is host-owned (browser-side deletes race with our writes).
      // Small delay lets the client stop its watchers first.
      setTimeout(() => removeSessionDir(s, "closed"), 500);
      break;
    default:
      if (isRequest) s.appendJson(FrameType.RPC, rpcError(id, RpcErrors.METHOD_NOT_FOUND, `unknown method: ${method}`));
      else log(`session ${s.id}: unknown notification ${method}`);
  }
}

function removeSessionDir(s, why) {
  try {
    fs.rmSync(s.dir, { recursive: true, force: true });
    log(`session ${s.id}: removed (${why})`);
  } catch (e) {
    log(`session ${s.id}: cleanup failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------- startup

writeJsonAtomic(path.join(fsioDir, "fsio.json"), { protocol: PROTOCOL_VERSION });

let hbSeq = 0;
function heartbeat() {
  writeJsonAtomic(path.join(fsioDir, "host.json"), {
    pid: process.pid,
    protocol: PROTOCOL_VERSION,
    allowShell: flags.allowShell,
    pty: !!ptyMod,
    startedAt: startedAt,
    seq: hbSeq++,
    t: now(),
  });
}
const startedAt = now();
heartbeat();
setInterval(heartbeat, HEARTBEAT_MS);

// GC: clients that vanish without CTL close (crashed tab, hard refresh)
// leave "running" sessions behind forever. Echo sessions are workbench
// artifacts — reap them after idle timeout. Shell sessions are left alone
// (they may hold real user processes).
setInterval(() => {
  for (const s of sessions.values()) {
    if (s.started && !s.done && s.spawn?.kind === "echo" && Date.now() - s.lastActivity > IDLE_GC_MS) {
      log(`session ${s.id}: idle for ${Math.round(IDLE_GC_MS / 60000)}m, reaping`);
      s.close();
      removeSessionDir(s, "idle");
    }
  }
}, 30_000);

watchDir(sessionsDir, scheduleScan);
setInterval(scheduleScan, SAFETY_POLL_MS);
if (flags.poll > 0) setInterval(scheduleScan, flags.poll);
// Hot poll: fs.watch wakeups ride FSEvents with ~50ms latency on macOS
// (measured; spec/FINDINGS.md F2). While a session is live, poll fast so the uplink
// isn't notification-bound. Idle cost is zero.
if (flags.hot > 0) {
  setInterval(() => {
    for (const s of sessions.values()) {
      if (s.started && !s.done) {
        scheduleScan();
        return;
      }
    }
  }, flags.hot);
}

log(`fsio host on ${fsioDir}`);
log(`  shell sessions: ${flags.allowShell ? "ALLOWED" : "disabled (--allow-shell to enable)"}`);
log(`  wakeup: ${flags.watch ? "fs.watch" : "no fs.watch"}${flags.poll ? ` + ${flags.poll}ms poll` : ""}${flags.hot ? ` + ${flags.hot}ms hot poll` : ""} + ${SAFETY_POLL_MS}ms safety poll`);
scheduleScan();

process.on("SIGINT", () => {
  for (const s of sessions.values()) s.close();
  try {
    fs.unlinkSync(path.join(fsioDir, "host.json"));
  } catch {}
  process.exit(0);
});
