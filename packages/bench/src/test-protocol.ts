// Protocol integration tests: spec MUSTs against a real host over a real
// filesystem. Hermetic: every scenario gets its own tmpdir and host process.
// Each test cites the rule it enforces (spec/PROTOCOL.md, D-, F-numbers).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FrameType,
  encodeFrame,
  jsonFrame,
  decodeJson,
  parseFrames,
  chunkName,
  dirChunkName,
  rpcRequest,
  rpcNotification,
  SPAWN_REQUEST_ID,
  RpcErrors,
  type RpcResponseMsg,
  type SpawnSpec,
} from "@fsio/common";

const here = path.dirname(fileURLToPath(import.meta.url)); // …/bench/dist
const hostJs = path.join(here, "..", "..", "host", "dist", "fsio-host.js");

async function waitFor<T>(fn: () => T | null | undefined | false, what: string, timeoutMs = 5000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

class HostFixture {
  dir!: string;
  proc!: ChildProcess;
  stopped = false;

  static async start(extraFlags: string[] = ["--allow-shell"], dir?: string): Promise<HostFixture> {
    const f = new HostFixture();
    f.dir = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "fsio-proto-"));
    f.proc = spawn(process.execPath, [hostJs, f.dir, ...extraFlags], { stdio: ["ignore", "ignore", "inherit"] });
    await waitFor(() => fs.existsSync(path.join(f.dir, ".fsio", "host.json")), "host heartbeat");
    return f;
  }

  async stop(keepDir = false): Promise<void> {
    this.stopped = true;
    this.proc.kill("SIGKILL"); // SIGINT would delete host.json; tests manage dirs themselves
    await new Promise((r) => this.proc.once("exit", r));
    if (!keepDir) fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

/** A minimal protocol-level client: raw files, no library conveniences —
 *  so tests exercise the wire contract, not our client code. */
class RawSession {
  sessionDir: string;
  inDir: string;
  seq = 1;

  constructor(rootDir: string, name = `t-${Math.random().toString(36).slice(2, 8)}`) {
    this.sessionDir = path.join(rootDir, ".fsio", "sessions", name);
    this.inDir = path.join(this.sessionDir, "in");
    fs.mkdirSync(this.inDir, { recursive: true });
  }

  /** spawn.json is written LAST via rename — presence means session is ready. */
  spawn(spec: SpawnSpec): void {
    const t = path.join(this.sessionDir, ".t");
    fs.writeFileSync(t, JSON.stringify(rpcRequest(SPAWN_REQUEST_ID, "spawn", spec)));
    fs.renameSync(t, path.join(this.sessionDir, "spawn.json"));
  }

  commit(bytes: Uint8Array, seq = this.seq++): string {
    const name = chunkName(seq);
    const t = path.join(this.inDir, `.tmp-${name}`);
    fs.writeFileSync(t, bytes);
    fs.renameSync(t, path.join(this.inDir, name));
    return name;
  }

  commitDirname(bytes: Uint8Array, seq = this.seq++): string {
    const name = dirChunkName(seq, bytes);
    fs.mkdirSync(path.join(this.inDir, name));
    return name;
  }

  /** All RPC messages appended to the out stream so far (segment 0). */
  responses(): RpcResponseMsg[] {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(path.join(this.sessionDir, "out.00000000.log"));
    } catch {
      return [];
    }
    return parseFrames(buf)
      .frames.filter((f) => f.type === FrameType.RPC)
      .map((f) => decodeJson<RpcResponseMsg>(f.payload));
  }

  response(id: number | string): RpcResponseMsg | undefined {
    return this.responses().find((m) => m.id === id);
  }
}

const ping = (id: number) => jsonFrame(FrameType.RPC, rpcRequest(id, "ping", { t0: 1 }));

// ------------------------------------------------------------------ spawn

test("spawn: echo answers the spawn.json request with a result on the out stream", async () => {
  const h = await HostFixture.start();
  try {
    const s = new RawSession(h.dir);
    s.spawn({ kind: "echo" });
    const res = await waitFor(() => s.response(SPAWN_REQUEST_ID), "spawn response");
    assert.equal(res.error, undefined);
    assert.equal((res.result as { kind: string }).kind, "echo");
  } finally {
    await h.stop();
  }
});

test("spawn errors carry JSON-RPC codes: 1003 unknown kind, 1002 bad cmd, 1001 shell denied", async () => {
  // spec "Control plane": a failed spawn is an error object, not a status to poll.
  const allow = await HostFixture.start(["--allow-shell"]);
  const deny = await HostFixture.start([]);
  try {
    const bad = new RawSession(allow.dir);
    bad.spawn({ kind: "quantum" } as unknown as SpawnSpec);
    const e1 = await waitFor(() => bad.response(SPAWN_REQUEST_ID), "unknown-kind response");
    assert.equal(e1.error?.code, RpcErrors.UNKNOWN_KIND);

    const enoent = new RawSession(allow.dir);
    enoent.spawn({ kind: "shell", cmd: "/no/such/binary", pty: false });
    const e2 = await waitFor(() => enoent.response(SPAWN_REQUEST_ID), "spawn-failed response");
    assert.equal(e2.error?.code, RpcErrors.SPAWN_FAILED);
    assert.match(e2.error!.message, /ENOENT/); // the real reason, not a generic state

    const denied = new RawSession(deny.dir);
    denied.spawn({ kind: "shell" });
    const e3 = await waitFor(() => denied.response(SPAWN_REQUEST_ID), "shell-denied response");
    assert.equal(e3.error?.code, RpcErrors.SHELL_NOT_ALLOWED);
  } finally {
    await allow.stop();
    await deny.stop();
  }
});

test("unknown request method gets -32601; unknown notification is ignored", async () => {
  const h = await HostFixture.start();
  try {
    const s = new RawSession(h.dir);
    s.spawn({ kind: "echo" });
    await waitFor(() => s.response(SPAWN_REQUEST_ID), "spawn response");
    s.commit(jsonFrame(FrameType.RPC, rpcNotification("no-such-notification"))); // must not kill anything
    s.commit(jsonFrame(FrameType.RPC, rpcRequest(7, "no-such-method")));
    const res = await waitFor(() => s.response(7), "error response");
    assert.equal(res.error?.code, RpcErrors.METHOD_NOT_FOUND);
  } finally {
    await h.stop();
  }
});

// ------------------------------------------------------------------ torn state (invariant 3)

test("torn chunk: host waits for completion, never skips (invariant 3, F-derived)", async () => {
  const h = await HostFixture.start();
  try {
    const s = new RawSession(h.dir);
    s.spawn({ kind: "echo" });
    await waitFor(() => s.response(SPAWN_REQUEST_ID), "spawn response");

    // Write chunk 1 *unatomically* with a torn tail: header promises 64
    // payload bytes, only 10 arrive. (Emulates the browser's crswap window.)
    const whole = ping(1);
    const torn = encodeFrame(FrameType.RPC, new Uint8Array(64)).subarray(0, 15);
    const chunkPath = path.join(s.inDir, chunkName(1));
    fs.writeFileSync(chunkPath, Buffer.concat([Buffer.from(whole), Buffer.from(torn)]));

    await new Promise((r) => setTimeout(r, 400)); // give the host every chance to do the wrong thing
    assert.ok(fs.existsSync(chunkPath), "host consumed/deleted a torn chunk");
    assert.equal(s.response(1), undefined, "host processed frames from a torn chunk");

    // Complete the chunk in place: now both frames must land, in order.
    fs.writeFileSync(chunkPath, Buffer.concat([Buffer.from(whole), Buffer.from(ping(2))]));
    await waitFor(() => s.response(2), "second ping response");
    assert.ok(s.response(1), "first frame of the completed chunk was processed");
    assert.ok(!fs.existsSync(chunkPath), "completed chunk was consumed (deletion = ack)");
  } finally {
    await h.stop();
  }
});

test("empty chunk file means in-progress, not empty message", async () => {
  const h = await HostFixture.start();
  try {
    const s = new RawSession(h.dir);
    s.spawn({ kind: "echo" });
    await waitFor(() => s.response(SPAWN_REQUEST_ID), "spawn response");

    const chunkPath = path.join(s.inDir, chunkName(1));
    fs.writeFileSync(chunkPath, ""); // create-empty → content-appears (browser swap pattern)
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(fs.existsSync(chunkPath), "host consumed an empty chunk");

    fs.writeFileSync(chunkPath, ping(1));
    await waitFor(() => s.response(1), "response after content appeared");
  } finally {
    await h.stop();
  }
});

// ------------------------------------------------------------------ ordering

test("a sequence gap stalls consumption; both lanes share one ordered space", async () => {
  // spec "Uplink": strictly ascending consumption after the base sequence
  // is discovered from the smallest present chunk. (The discovery rule is
  // why out-of-order FIRST commits are a client MUST, not host-detectable:
  // "first chunk is seq 2" is indistinguishable from "seq 1 was already
  // consumed before a host restart.")
  const h = await HostFixture.start();
  try {
    const s = new RawSession(h.dir);
    s.spawn({ kind: "echo" });
    await waitFor(() => s.response(SPAWN_REQUEST_ID), "spawn response");

    s.commit(ping(1), 1);
    await waitFor(() => s.response(1), "base sequence established");

    s.commitDirname(ping(3), 3); // fast lane, ahead of the gap: must stall
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(s.response(3), undefined, "host jumped a sequence gap");

    s.commit(ping(2), 2); // gap filled: 2 then 3, in order
    await waitFor(() => s.response(3), "responses after gap fill");
    const ids = s.responses().map((m) => m.id);
    assert.deepEqual(ids.slice(ids.indexOf(1)), [1, 2, 3], "responses out of order");
  } finally {
    await h.stop();
  }
});

// ------------------------------------------------------------------ shell (pipe fallback)

test("pipe shell: DATA roundtrip, eof ends stdin, status reaches exited 0", async () => {
  // spec "Session kinds" + "Control plane": eof notification closes the
  // child's stdin (pipe mode); status.json is the durable state record.
  const h = await HostFixture.start();
  try {
    const s = new RawSession(h.dir);
    s.spawn({ kind: "shell", cmd: "/bin/cat", pty: false }); // cat: echoes stdin, exits on EOF
    const res = await waitFor(() => s.response(SPAWN_REQUEST_ID), "spawn response");
    assert.equal((res.result as { pty: boolean }).pty, false);

    s.commit(encodeFrame(FrameType.DATA, new TextEncoder().encode("echo-me\n")));
    await waitFor(() => {
      const buf = fs.readFileSync(path.join(s.sessionDir, "out.00000000.log"));
      const data = parseFrames(buf).frames.filter((f) => f.type === FrameType.DATA);
      return data.some((f) => new TextDecoder().decode(f.payload).includes("echo-me"));
    }, "DATA echoed back through the pipe");

    s.commit(jsonFrame(FrameType.RPC, rpcNotification("eof")));
    const status = await waitFor(() => {
      try {
        const st = JSON.parse(fs.readFileSync(path.join(s.sessionDir, "status.json"), "utf8")) as { state: string; exitCode?: number };
        return st.state === "exited" ? st : null;
      } catch {
        return null;
      }
    }, "exited status after eof");
    assert.equal(status.exitCode, 0);
  } finally {
    await h.stop();
  }
});

test("signal notification terminates the child", async () => {
  const h = await HostFixture.start();
  try {
    const s = new RawSession(h.dir);
    s.spawn({ kind: "shell", cmd: "/bin/sleep", args: ["60"], pty: false });
    await waitFor(() => s.response(SPAWN_REQUEST_ID), "spawn response");
    s.commit(jsonFrame(FrameType.RPC, rpcNotification("signal", { sig: "SIGTERM" })));
    await waitFor(() => {
      try {
        return (JSON.parse(fs.readFileSync(path.join(s.sessionDir, "status.json"), "utf8")) as { state: string }).state === "exited";
      } catch {
        return false;
      }
    }, "exited status after signal");
  } finally {
    await h.stop();
  }
});

// ------------------------------------------------------------------ lifecycle

test("close notification: host owns cleanup and deletes the session dir (D6/F8)", async () => {
  const h = await HostFixture.start();
  try {
    const s = new RawSession(h.dir);
    s.spawn({ kind: "echo" });
    await waitFor(() => s.response(SPAWN_REQUEST_ID), "spawn response");
    s.commit(jsonFrame(FrameType.RPC, rpcNotification("close")));
    await waitFor(() => !fs.existsSync(s.sessionDir), "session dir removal", 3000);
  } finally {
    await h.stop();
  }
});

test("host restart: re-adopts live sessions, resumes echo, duplicate spawn answers are tolerable", async () => {
  // spec "Control plane": responses MAY be duplicated (restart re-answering);
  // clients MUST ignore unknown ids — so the wire may legally contain both.
  const h1 = await HostFixture.start();
  const dir = h1.dir;
  const s = new RawSession(dir);
  try {
    s.spawn({ kind: "echo" });
    await waitFor(() => s.response(SPAWN_REQUEST_ID), "spawn response");
    s.commit(ping(1));
    await waitFor(() => s.response(1), "pre-restart ping");
    await h1.stop(true); // keep the shared dir: simulate a crash

    const h2 = await HostFixture.start([], dir);
    try {
      s.commit(ping(2));
      await waitFor(() => s.response(2), "post-restart ping", 8000);
    } finally {
      await h2.stop();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
