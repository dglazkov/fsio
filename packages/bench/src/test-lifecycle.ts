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
import { now, rpcRequest, SPAWN_REQUEST_ID, type SpawnSpec, type SessionStatus } from "@fsio/common";

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
