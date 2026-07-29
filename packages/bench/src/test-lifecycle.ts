// Host lifecycle tests: the time-based behaviors TESTING.md deliberately
// excluded from integration testing "at real timescales" — testable now
// that #17 made HostServer's intervals injectable. In-process (no child
// host): the library surface *is* what's under test here.
//
// Hermetic: every scenario gets its own tmpdir and HostServer instance.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HostServer, type HostServerOptions } from "@fsio/host";
import { now, encodeFrame, FrameType, rpcRequest, rpcNotification, SPAWN_REQUEST_ID, type SpawnSpec, type SessionStatus } from "@fsio/common";

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "fsio-life-"));

async function waitFor<T>(fn: () => T | null | undefined | false, what: string, timeoutMs = 5000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal raw client: session dir + spawn.json written last via rename
 *  (spec: Session lifecycle — presence means ready). */
function makeSession(root: string, id: string, spec: SpawnSpec): string {
  const dir = path.join(root, ".fsio", "sessions", id);
  fs.mkdirSync(path.join(dir, "in"), { recursive: true });
  const t = path.join(dir, ".t");
  fs.writeFileSync(t, JSON.stringify(rpcRequest(SPAWN_REQUEST_ID, "spawn", spec)));
  fs.renameSync(t, path.join(dir, "spawn.json"));
  return dir;
}

/** Commit one uplink chunk carrying a single RPC notification, atomically
 *  (temp+rename, like a native client — spec: Uplink). */
const chunkSeq = new Map<string, number>();
function sendNotification(sessionDir: string, method: string): void {
  const seq = (chunkSeq.get(sessionDir) ?? 1);
  chunkSeq.set(sessionDir, seq + 1);
  const bytes = encodeFrame(FrameType.RPC, new TextEncoder().encode(JSON.stringify(rpcNotification(method))));
  const t = path.join(sessionDir, "in", ".t");
  fs.writeFileSync(t, bytes);
  fs.renameSync(t, path.join(sessionDir, "in", `${String(seq).padStart(8, "0")}.f`));
}

function status(sessionDir: string): SessionStatus | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionDir, "status.json"), "utf8")) as SessionStatus;
  } catch {
    return null;
  }
}

async function withServer(opts: Omit<HostServerOptions, "root">, fn: (server: HostServer, root: string) => Promise<void>): Promise<void> {
  const root = tmpRoot();
  const server = new HostServer({ root, ...opts });
  await server.start();
  try {
    await fn(server, root);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------- idle GC (#3)

test("idle echo sessions are reaped after idleGcMs; the dir is removed", async () => {
  // Host policy pending #3: echo sessions are workbench artifacts — a
  // vanished client (crashed tab) must not leak them forever.
  await withServer({ timings: { idleGcMs: 300, idleSweepMs: 50 } }, async (_server, root) => {
    const dir = makeSession(root, "idle-echo", { kind: "echo" });
    await waitFor(() => status(dir)?.state === "running", "echo session running");
    await waitFor(() => !fs.existsSync(dir), "idle echo session reaped");
  });
});

test("idle shell sessions are NOT reaped (they may hold real user processes)", async () => {
  await withServer({ allowShell: true, timings: { idleGcMs: 100, idleSweepMs: 25 } }, async (_server, root) => {
    const dir = makeSession(root, "idle-shell", { kind: "shell", cmd: "/bin/sleep", args: ["60"], pty: false });
    await waitFor(() => status(dir)?.state === "running", "shell session running");
    await sleep(500); // many idle windows and sweeps
    assert.ok(fs.existsSync(dir), "idle sweep reaped a shell session");
    assert.equal(status(dir)?.state, "running");
  });
});

// ---------------------------------------- vanished clients + detach (D17, #3)

test("heartbeat-aware echo session is reaped once the client goes silent past detachAfterMs", async () => {
  // D17: a heartbeat opts the session into precise vanished-client GC —
  // echo is a stateless workbench artifact, so silence means reap, without
  // waiting out the blunt 5-minute idle window.
  await withServer({ timings: { detachAfterMs: 200, idleSweepMs: 25 } }, async (_server, root) => {
    const dir = makeSession(root, "hb-echo", { kind: "echo" });
    await waitFor(() => status(dir)?.state === "running", "echo session running");
    sendNotification(dir, "heartbeat");
    await waitFor(() => !fs.existsSync(dir), "vanished heartbeat-aware echo reaped");
  });
});

test("heartbeat-aware shell is marked detached (never killed); a returning client clears it", async () => {
  // D17: stateful sessions get a detached MARKER, not a kill — a
  // backgrounded tab's beats clamp to 1/min (F16) and the user will
  // return. Any uplink traffic (here: the next heartbeat) reattaches.
  await withServer({ allowShell: true, timings: { detachAfterMs: 200, idleSweepMs: 25 } }, async (server, root) => {
    const dir = makeSession(root, "hb-shell", { kind: "shell", cmd: "/bin/sleep", args: ["60"], pty: false });
    const st = await waitFor(() => {
      const s = status(dir);
      return s?.state === "running" ? s : null;
    }, "shell session running");
    sendNotification(dir, "heartbeat");
    await waitFor(() => status(dir)?.detached === true, "detached marker in status.json");
    const detachedStatus = status(dir)!;
    assert.equal(detachedStatus.state, "running", "detach must not change state");
    assert.doesNotThrow(() => process.kill(st.pid!, 0), "detach must not kill the child");
    assert.ok(server.listSessions().find((s) => s.id === "hb-shell")?.detached, "listSessions must surface detached");
    sendNotification(dir, "heartbeat");
    await waitFor(() => status(dir)?.detached === undefined, "detached cleared on client return");
    assert.equal(status(dir)?.state, "running");
  });
});

test("legacy clients (no heartbeat) are never marked detached", async () => {
  // D17: only heartbeat-aware sessions are judged by client presence —
  // a legacy client that is merely quiet keeps the pre-D17 behavior.
  await withServer({ allowShell: true, timings: { detachAfterMs: 100, idleSweepMs: 25 } }, async (_server, root) => {
    const dir = makeSession(root, "legacy-shell", { kind: "shell", cmd: "/bin/sleep", args: ["60"], pty: false });
    await waitFor(() => status(dir)?.state === "running", "shell session running");
    await sleep(400); // many detach windows and sweeps
    assert.equal(status(dir)?.detached, undefined, "legacy session must not be judged by heartbeat silence");
    assert.equal(status(dir)?.state, "running");
  });
});

// ------------------------------------------- reporter client-dir sweep (#39)

test("idle sweep caps .fsio/client/* dirs: newest kept, stale overflow removed, fresh never touched", async () => {
  // #39: one reporter dir per page load; the host owns .fsio cleanup (D6).
  // Cap is 8 (CLIENT_DIR_CAP): beyond-cap dirs older than staleGraceMs go;
  // fresh dirs survive even beyond the cap (a live reporter flushes ≥ every
  // 5 s, so live pages always look fresh).
  await withServer({ timings: { idleSweepMs: 25, staleGraceMs: 500 } }, async (_server, root) => {
    const clientRoot = path.join(root, ".fsio", "client");
    // 10 stale dirs (mtimes increasing with i) + 2 fresh ones = 12.
    for (let i = 0; i < 10; i++) {
      const d = path.join(clientRoot, `c-stale-${i}`);
      fs.mkdirSync(d, { recursive: true });
      const old = new Date(Date.now() - 60_000 + i * 1000);
      fs.utimesSync(d, old, old);
    }
    fs.mkdirSync(path.join(clientRoot, "c-fresh-a"), { recursive: true });
    fs.mkdirSync(path.join(clientRoot, "c-fresh-b"), { recursive: true });
    // Newest 8 = 2 fresh + c-stale-9..c-stale-4; c-stale-3..0 are over cap
    // and stale → removed.
    await waitFor(() => fs.readdirSync(clientRoot).length === 8, "over-cap stale client dirs removed");
    const left = fs.readdirSync(clientRoot).sort();
    assert.deepEqual(left, ["c-fresh-a", "c-fresh-b", "c-stale-4", "c-stale-5", "c-stale-6", "c-stale-7", "c-stale-8", "c-stale-9"]);
    await sleep(100); // several more sweeps
    assert.equal(fs.readdirSync(clientRoot).length, 8, "sweep must not remove fresh or within-cap dirs");
  });
});

// ------------------------------------- stale-session GC (spec: Session lifecycle)

test("adoption GCs exited sessions older than the grace period, keeps fresh ones", async () => {
  // spec "Session lifecycle": the host "GCs stale exited sessions (>60 s)
  // on adoption" — grace so a client can still read the final out log (D6).
  const root = tmpRoot();
  const mk = (id: string, t: number) => {
    const dir = path.join(root, ".fsio", "sessions", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ t, state: "exited", exitCode: 0 }));
    return dir;
  };
  const stale = mk("stale", now() - 10_000);
  const fresh = mk("fresh", now());
  const server = new HostServer({ root, timings: { staleGraceMs: 1000 } });
  await server.start();
  try {
    await waitFor(() => !fs.existsSync(stale), "stale exited session removed");
    assert.ok(fs.existsSync(fresh), "fresh exited session must survive the grace period");
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------- host mutual exclusion (#40)

test("start() refuses over a live host.json; the seat frees when the incumbent closes", async () => {
  // spec "Session lifecycle": one live host per .fsio — a second host
  // would double-spawn adopted sessions and violate one-writer (F8/D6).
  const root = tmpRoot();
  const first = new HostServer({ root, timings: { heartbeatMs: 50 } });
  await first.start();
  const second = new HostServer({ root, timings: { heartbeatMs: 50 } });
  await assert.rejects(() => second.start(), /looks live/, "second start() must refuse while the first heartbeats");
  assert.ok(fs.existsSync(path.join(root, ".fsio", "host.json")), "refusal must not disturb the incumbent");
  await first.close();
  await second.start(); // close() retracted host.json — the seat is free
  await second.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a stale host.json (crashed host) does not block start()", async () => {
  // Liveness = mtime < 3 beats: a corpse past the window is adoptable,
  // exactly as clients would already have judged it gone.
  const root = tmpRoot();
  const fsioDir = path.join(root, ".fsio");
  fs.mkdirSync(fsioDir, { recursive: true });
  const hostJson = path.join(fsioDir, "host.json");
  fs.writeFileSync(hostJson, JSON.stringify({ pid: 99999, t: now() - 60_000 }));
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(hostJson, old, old);
  const server = new HostServer({ root, timings: { heartbeatMs: 50 } });
  await server.start();
  await server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("takeover: true starts over a live-looking host.json", async () => {
  // The escape hatch for a SIGKILLed host whose last beat hasn't gone
  // stale: mtime is the only signal, so a fresh corpse looks live.
  const root = tmpRoot();
  const fsioDir = path.join(root, ".fsio");
  fs.mkdirSync(fsioDir, { recursive: true });
  fs.writeFileSync(path.join(fsioDir, "host.json"), JSON.stringify({ pid: 99999, t: now() }));
  const blocked = new HostServer({ root, timings: { heartbeatMs: 60_000 } });
  await assert.rejects(() => blocked.start(), /looks live/, "a fresh corpse must refuse without takeover");
  const seizing = new HostServer({ root, takeover: true, timings: { heartbeatMs: 60_000 } });
  await seizing.start();
  await seizing.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("fresh: true refuses over a live host and leaves its .fsio intact", async () => {
  // #40: --fresh would otherwise rmSync a *live* host's .fsio out from
  // under it — the refusal must come before any mutation.
  const root = tmpRoot();
  const first = new HostServer({ root, timings: { heartbeatMs: 50 } });
  await first.start();
  const dir = makeSession(root, "survivor", { kind: "echo" });
  await waitFor(() => status(dir)?.state === "running", "echo session running");
  const wiper = new HostServer({ root, fresh: true, timings: { heartbeatMs: 50 } });
  await assert.rejects(() => wiper.start(), /looks live/, "fresh: true must refuse like any other start");
  assert.ok(fs.existsSync(dir), "fresh: true must not wipe a live host's sessions");
  assert.equal(status(dir)?.state, "running");
  await first.close();
  fs.rmSync(root, { recursive: true, force: true });
});

// ------------------------------------------------------------- close()

test("close() retracts host.json and stops the heartbeat", async () => {
  // spec "Session lifecycle": liveness = host.json younger than 3 beats;
  // a closed host must read as gone, not as flapping.
  const root = tmpRoot();
  const server = new HostServer({ root, timings: { heartbeatMs: 50 } });
  await server.start();
  const hostJson = path.join(root, ".fsio", "host.json");
  assert.ok(fs.existsSync(hostJson), "start() resolves with the first heartbeat on disk");
  server.close();
  assert.ok(!fs.existsSync(hostJson), "close() must retract host.json");
  await sleep(200); // several would-be beats
  assert.ok(!fs.existsSync(hostJson), "heartbeat kept running after close()");
  fs.rmSync(root, { recursive: true, force: true });
});

test("await close(): resolves only after a TERM-ignoring child is SIGKILLed (D14)", async () => {
  // Q5 of #26: close() was sync while child exit was async. The promise
  // resolves once children are actually gone — SIGTERM, then SIGKILL after
  // killGraceMs. The child here traps TERM, so only escalation can end it.
  const root = tmpRoot();
  const server = new HostServer({ root, allowShell: true, timings: { killGraceMs: 150 } });
  await server.start();
  const dir = makeSession(root, "stubborn", {
    kind: "shell",
    cmd: "/bin/sh",
    // Two traps for the test's own races (both bit, measured): the loop
    // keeps `sh -c` from exec()ing a lone trailing command (which discards
    // the trap — close resolved in 6 ms); the marker file proves the trap
    // is *armed* before we SIGTERM ("running" status only means the OS
    // process exists — close resolved in 8 ms when TERM beat the trap).
    args: ["-c", "trap '' TERM; : > trapped.marker; while true; do sleep 0.5; done"],
    pty: false,
  });
  const st = await waitFor(() => {
    const s = status(dir);
    return s?.state === "running" ? s : null;
  }, "stubborn shell running");
  const pid = st.pid!;
  await waitFor(() => fs.existsSync(path.join(root, "trapped.marker")), "trap to be armed");
  const t0 = Date.now();
  await server.close();
  const elapsed = Date.now() - t0;
  const alive = (() => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  })();
  assert.ok(!alive, "child survived an awaited close()");
  assert.ok(elapsed >= 140, `close() resolved before the SIGKILL grace elapsed (${elapsed}ms)`);
  assert.ok(elapsed < 5000, `close() took implausibly long (${elapsed}ms)`);
  fs.rmSync(root, { recursive: true, force: true });
});

test("close() terminates session child processes", async () => {
  // D6: the host owns cleanup — including processes it spawned. An embedder
  // calling close() must not leak children.
  const root = tmpRoot();
  const server = new HostServer({ root, allowShell: true });
  await server.start();
  const dir = makeSession(root, "child", { kind: "shell", cmd: "/bin/sleep", args: ["60"], pty: false });
  const st = await waitFor(() => {
    const s = status(dir);
    return s?.state === "running" ? s : null;
  }, "shell session running");
  const pid = st.pid!;
  server.close();
  await waitFor(() => {
    try {
      process.kill(pid, 0); // 0 = existence probe
      return false;
    } catch {
      return true;
    }
  }, "child process termination");
  fs.rmSync(root, { recursive: true, force: true });
});
