// Daemon singleton (D21) and the daemon's own startup contract.
//
// What the lock protects is the F8/D6 one-writer invariant: a second
// daemon on one hub would re-spawn every adopted session, consume uplink
// chunks the first then sees as gaps, and mint competing D18 epochs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { acquireHubLock, lockPathFor, HubLockedError } from "./lock.js";
import { startDaemon } from "./daemon.js";

function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fsiod-lock-"));
  const state = path.join(tmp, "state");
  const hub = path.join(tmp, "hub");
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  fs.mkdirSync(hub, { recursive: true });
  return { tmp, state, hub, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

const isWin = process.platform === "win32";

test("one hub, one daemon: the second acquire is refused, not queued", async () => {
  const f = fixture();
  try {
    const first = await acquireHubLock(f.state, f.hub);
    await assert.rejects(acquireHubLock(f.state, f.hub), (e: unknown) => {
      assert.ok(e instanceof HubLockedError, `expected HubLockedError, got ${e}`);
      return true;
    });
    // …and it frees on release, so a restart is not blocked by its corpse.
    first.release();
    const second = await acquireHubLock(f.state, f.hub);
    second.release();
  } finally {
    f.cleanup();
  }
});

test("the lock is keyed by the hub path: different hubs do not exclude each other", async () => {
  const f = fixture();
  try {
    const other = path.join(f.tmp, "hub2");
    fs.mkdirSync(other);
    const a = await acquireHubLock(f.state, f.hub);
    const b = await acquireHubLock(f.state, other);
    assert.notEqual(a.path, b.path);
    a.release();
    b.release();
  } finally {
    f.cleanup();
  }
});

test("the lock lives in private state, not in the hub (D20), mode 0600", async (t) => {
  if (isWin) return t.skip("named pipes have no filesystem residue");
  const f = fixture();
  try {
    const lock = await acquireHubLock(f.state, f.hub);
    assert.ok(lock.path.startsWith(f.state), "a lock a co-tenant can delete is not a lock (D20)");
    assert.deepEqual(fs.readdirSync(f.hub), [], "nothing about the lock may appear in the granted folder");
    assert.equal(fs.statSync(lock.path).mode & 0o777, 0o600);
    lock.release();
  } finally {
    f.cleanup();
  }
});

test("a deep state dir falls back to the runtime dir instead of failing at bind()", async (t) => {
  if (isWin) return t.skip("named pipes have no path-length limit");
  const f = fixture();
  try {
    // sun_path is 104 bytes; a sandboxed FSIO_STATE_DIR or a long $HOME
    // reaches that easily, and the lock must not be what breaks.
    const deep = path.join(f.state, "a".repeat(40), "b".repeat(40), "c".repeat(40));
    fs.mkdirSync(deep, { recursive: true });
    const p = lockPathFor(deep, f.hub);
    assert.ok(!p.startsWith(deep), "should not have used the deep path");
    assert.ok(Buffer.byteLength(p) <= 104);
    // Deterministic: two starters must contend for the same name.
    assert.equal(p, lockPathFor(deep, f.hub));
    const lock = await acquireHubLock(deep, f.hub);
    try {
      await assert.rejects(acquireHubLock(deep, f.hub), (e: unknown) => e instanceof HubLockedError);
    } finally {
      lock.release();
    }
  } finally {
    f.cleanup();
  }
});

test("a socket left by a killed daemon is reclaimed, not treated as an owner", async (t) => {
  if (isWin) return t.skip("no stale case: a named pipe dies with its process");
  const f = fixture();
  try {
    const lockPath = lockPathFor(f.state, f.hub);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    // A real corpse: bind in a child, then SIGKILL it — no unlink runs, so
    // the socket file survives exactly as it would after a crash. This is
    // the case that makes an O_EXCL lock file strand a hub (D21).
    const child = spawn(process.execPath, ["-e", "require('node:net').createServer().listen(process.argv[1], () => console.log('bound'))", lockPath]);
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (d: Buffer) => (d.toString().includes("bound") ? resolve() : undefined));
      child.on("exit", () => reject(new Error("lock child exited before binding")));
      setTimeout(() => reject(new Error("lock child never bound")), 5000).unref();
    });
    // While it lives, we must lose.
    await assert.rejects(acquireHubLock(f.state, f.hub), (e: unknown) => e instanceof HubLockedError);
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    assert.ok(fs.existsSync(lockPath), "the corpse should have left its socket behind");

    const lock = await acquireHubLock(f.state, f.hub);
    lock.release();
  } finally {
    f.cleanup();
  }
});

test("a bound socket owns the hub even when nothing answers on it", async (t) => {
  if (isWin) return t.skip("unix-socket specific");
  const f = fixture();
  const lockPath = lockPathFor(f.state, f.hub);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  // The probe asks the kernel "is this name bound?", not the application
  // "are you well?" — a daemon wedged in a long spawn policy must not look
  // like a corpse. (The probe's own timeout is fail-safe for the same
  // reason: a socket that neither connects nor refuses counts as live.)
  const server = net.createServer();
  await new Promise<void>((r) => server.listen({ path: lockPath, backlog: 0 }, () => r()));
  try {
    await assert.rejects(acquireHubLock(f.state, f.hub, 150), (e: unknown) => e instanceof HubLockedError);
  } finally {
    server.close();
    f.cleanup();
  }
});

// ------------------------------------------------------------- the daemon

test("startDaemon takes the lock; a second daemon on the same hub refuses (D21)", async () => {
  const f = fixture();
  const opts = { hub: f.hub, stateDir: f.state, allowTempHub: true, watch: false, hotPollMs: 0 };
  const first = await startDaemon(opts);
  try {
    assert.ok(first.lock, "a daemon without a lock is not a singleton");
    await assert.rejects(startDaemon(opts), (e: unknown) => e instanceof HubLockedError);
    // The refusal must not have touched the hub: the survivor owns it.
    assert.ok(fs.existsSync(path.join(f.hub, ".fsio", "host.json")), "the first daemon still serves");
  } finally {
    await first.stop();
    f.cleanup();
  }
});

test("a daemon that cannot start releases the lock instead of stranding the hub", async () => {
  const f = fixture();
  try {
    // A hub whose .fsio cannot be created: start() throws, and the lock
    // must not outlive the failed attempt.
    const blocked = path.join(f.tmp, "blocked");
    fs.writeFileSync(blocked, "not a directory");
    await assert.rejects(startDaemon({ hub: blocked, stateDir: f.state, allowTempHub: true }));
    const lock = await acquireHubLock(f.state, blocked);
    lock.release();
  } finally {
    f.cleanup();
  }
});

test("private state inside the hub is refused before anything is served (D20)", async () => {
  const f = fixture();
  try {
    await assert.rejects(startDaemon({ hub: f.hub, stateDir: path.join(f.hub, "state"), allowTempHub: true }), /inside the hub/);
  } finally {
    f.cleanup();
  }
});
