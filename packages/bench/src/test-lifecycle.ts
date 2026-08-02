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
import { now, encodeFrame, FrameType, rpcRequest, rpcNotification, SPAWN_REQUEST_ID, type SpawnSpec, type SessionStatus, type TranscriptMeta } from "@fsio/common";

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
 *  (temp+rename, like a native client — spec: Uplink). Returns the chunk
 *  path: the host deletes it on consumption, and deletion *is* the ack. */
const chunkSeq = new Map<string, number>();
function sendNotification(sessionDir: string, method: string): string {
  const seq = (chunkSeq.get(sessionDir) ?? 1);
  chunkSeq.set(sessionDir, seq + 1);
  const bytes = encodeFrame(FrameType.RPC, new TextEncoder().encode(JSON.stringify(rpcNotification(method))));
  const t = path.join(sessionDir, "in", ".t");
  const chunk = path.join(sessionDir, "in", `${String(seq).padStart(8, "0")}.f`);
  fs.writeFileSync(t, bytes);
  fs.renameSync(t, chunk);
  return chunk;
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

// --------------------------------------- hot-poll traffic gate (D4, F22, #73)

test("the hot poll is armed by traffic, not by session liveness (F22)", async () => {
  // F22 located the host's idle burn in this gate: it was `started && !done`
  // — session *liveness* — so N idle-but-running sessions kept the 5 ms ×
  // O(N) scan loop hot forever (~60% of a core at 32 idle sessions, against
  // ~3% for the same machinery idle-gated). D4's client-side rule, ported
  // host-side: hot only while traffic flowed within hotWindowMs, with the
  // watchers + safety scan carrying idle (invariant 1).
  //
  // Observable without counting scans: with fs.watch off, uplink latency IS
  // the gate's state — armed = hot-poll speed, disarmed = the safety scan.
  const HOT_WINDOW = 250;
  const SAFETY = 1500;
  const root = tmpRoot();
  const dir = makeSession(root, "hot-gate", { kind: "echo" }); // exists before start()
  const server = new HostServer({ root, watch: false, hotPollMs: 5, timings: { hotWindowMs: HOT_WINDOW, safetyPollMs: SAFETY } });
  await server.start(); // the first scan adopts the session, which arms the poll
  const timeConsumption = async (what: string): Promise<number> => {
    const chunk = sendNotification(dir, "heartbeat");
    const t0 = Date.now();
    await waitFor(() => !fs.existsSync(chunk), what);
    return Date.now() - t0;
  };
  try {
    await waitFor(() => status(dir)?.state === "running", "echo session running");
    const hotMs = await timeConsumption("chunk consumed while hot");
    assert.ok(hotMs < HOT_WINDOW, `armed hot poll took ${hotMs}ms to consume a chunk`);

    // Silence past the window disarms — while the session stays running, the
    // exact state the old gate kept polling for.
    await sleep(HOT_WINDOW * 2);
    const cold = sendNotification(dir, "heartbeat");
    await sleep(HOT_WINDOW + 150); // still well before the next safety scan
    assert.ok(fs.existsSync(cold), "hot poll still scanning after hotWindowMs of silence");
    assert.equal(status(dir)?.state, "running", "session must still be live — liveness is not the gate");

    // Invariant 1: the safety poll is the backstop, so idle costs latency,
    // never delivery.
    await waitFor(() => !fs.existsSync(cold), "idle chunk consumed by the safety scan", SAFETY * 3);

    // …and that consumption re-arms the loop (F22: the hot poll re-arms on
    // first traffic).
    const rearmedMs = await timeConsumption("chunk consumed after re-arm");
    assert.ok(rearmedMs < HOT_WINDOW, `re-armed hot poll took ${rearmedMs}ms`);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
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

// ------------------------------------------- scrollback hygiene (#82, D26)

test("an exited session is removed after staleGraceMs of client silence (running host, not just adoption)", async () => {
  // spec "Scrollback hygiene" / D26: the out log is full scrollback, and a
  // terminal session whose client vanished must not retain it past the
  // grace window. Before this rule the adoption-time GC was the only
  // reaper — an exited session lingered, secrets included, for the life
  // of the host.
  await withServer({ allowShell: true, timings: { staleGraceMs: 250, idleSweepMs: 25 } }, async (_server, root) => {
    const dir = makeSession(root, "shred-exited", { kind: "shell", cmd: "/bin/echo", args: ["secret-scrollback"], pty: false });
    await waitFor(() => status(dir)?.state === "exited", "session exited");
    await waitFor(() => !fs.existsSync(dir), "exited session dir removed after grace");
  });
});

test("a denied session is removed after staleGraceMs too (error state is terminal)", async () => {
  // spec "Scrollback hygiene" / D26: denied and errored sessions are as
  // terminal as exited ones — a crashed client must not leave them behind.
  await withServer({ allowShell: false, timings: { staleGraceMs: 250, idleSweepMs: 25 } }, async (_server, root) => {
    const dir = makeSession(root, "shred-denied", { kind: "shell", pty: false });
    await waitFor(() => status(dir)?.state === "error", "spawn denied");
    await waitFor(() => !fs.existsSync(dir), "denied session dir removed after grace");
  });
});

test("an exited session with a client still talking is NOT removed; silence then reaps it", async () => {
  // spec "Scrollback hygiene" / D26: the grace window measures CLIENT
  // silence, not time-since-exit — a client still draining the final out
  // log keeps refreshing presence with every consumed chunk.
  // Grace is 4× the talk cadence: the per-iteration liveness assertion must
  // not flake when a loaded runner stretches a 100 ms sleep.
  await withServer({ allowShell: true, timings: { staleGraceMs: 400, idleSweepMs: 25 } }, async (_server, root) => {
    const dir = makeSession(root, "shred-reader", { kind: "shell", cmd: "/bin/echo", args: ["final-output"], pty: false });
    await waitFor(() => status(dir)?.state === "exited", "session exited");
    for (let i = 0; i < 8; i++) {
      sendNotification(dir, "heartbeat");
      await sleep(100); // each consumed chunk refreshes lastClientSeen
      assert.ok(fs.existsSync(dir), "session removed while its client was still talking");
    }
    await waitFor(() => !fs.existsSync(dir), "session removed once the client went silent");
  });
});

test("a detached (running) shell is never swept by the hygiene rule", async () => {
  // D17/D18 reattach promise: hygiene applies to TERMINAL sessions only —
  // a detached shell may hold real user processes and its scrollback is
  // the thing reattach replays.
  await withServer({ allowShell: true, timings: { staleGraceMs: 100, idleSweepMs: 25, detachAfterMs: 200 } }, async (_server, root) => {
    const dir = makeSession(root, "shred-detached", { kind: "shell", cmd: "/bin/sleep", args: ["60"], pty: false });
    await waitFor(() => status(dir)?.state === "running", "shell running");
    sendNotification(dir, "heartbeat");
    await waitFor(() => status(dir)?.detached === true, "shell detached");
    await sleep(400); // many grace windows and sweeps
    assert.ok(fs.existsSync(dir), "hygiene sweep removed a detached running session");
    assert.equal(status(dir)?.state, "running");
  });
});

test(".fsio/ is appended to the shared dir's .gitignore when inside a git repo — once", async () => {
  // spec "Scrollback hygiene" / D26: scrollback must never reach version
  // control. Nested shared dirs get their own .gitignore (git reads one at
  // every level); restarts must not duplicate the entry.
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, ".git")); // the shared dir IS a repo
  const nested = path.join(root, "project");
  fs.mkdirSync(nested);
  const s1 = new HostServer({ root: nested });
  await s1.start();
  await s1.close();
  const file = path.join(nested, ".gitignore");
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /^\.fsio\/$/m, ".gitignore must gain a .fsio/ line");
  const s2 = new HostServer({ root: nested });
  await s2.start();
  await s2.close();
  assert.equal(fs.readFileSync(file, "utf8"), text, "restart must not duplicate the entry");
  fs.rmSync(root, { recursive: true, force: true });
});

test("gitignore: existing ignore line respected, non-repos untouched, opt-out honored", async () => {
  // Existing `.fsio/`-shaped line (any of .fsio, .fsio/, /.fsio): no append.
  const repo = tmpRoot();
  fs.mkdirSync(path.join(repo, ".git"));
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n/.fsio\n");
  const s1 = new HostServer({ root: repo });
  await s1.start();
  await s1.close();
  assert.equal(fs.readFileSync(path.join(repo, ".gitignore"), "utf8"), "node_modules\n/.fsio\n");
  fs.rmSync(repo, { recursive: true, force: true });
  // Not a repo: no .gitignore materializes.
  const plain = tmpRoot();
  const s2 = new HostServer({ root: plain });
  await s2.start();
  await s2.close();
  assert.ok(!fs.existsSync(path.join(plain, ".gitignore")), "non-repo dirs must not grow a .gitignore");
  fs.rmSync(plain, { recursive: true, force: true });
  // Embedder opt-out.
  const optout = tmpRoot();
  fs.mkdirSync(path.join(optout, ".git"));
  const s3 = new HostServer({ root: optout, gitignore: false });
  await s3.start();
  await s3.close();
  assert.ok(!fs.existsSync(path.join(optout, ".gitignore")), "gitignore: false must disable the append");
  fs.rmSync(optout, { recursive: true, force: true });
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

// ------------------------- ended-session transcripts (#119, D26 rule 4)

const transcriptDir = (root: string, id: string): string => path.join(root, ".fsio", "transcripts", id);
const transcriptMeta = (root: string, id: string): TranscriptMeta | null => {
  try {
    return JSON.parse(fs.readFileSync(path.join(transcriptDir(root, id), "meta.json"), "utf8")) as TranscriptMeta;
  } catch {
    return null;
  }
};

test("a session closed by its client leaves its out log in transcripts/ and its plumbing nowhere", async () => {
  // D26 rule 4: the sweep is right about `in/`, doorbells and status.json,
  // and was wrong about the out log — for a session carrying a
  // conversation, that file IS the conversation (#119).
  await withServer({ transcripts: true, timings: { closeDelayMs: 25 } }, async (_server, root) => {
    const dir = makeSession(root, "s-kept", { kind: "echo", client: "c-test", origin: "https://example.test" });
    await waitFor(() => status(dir)?.state === "running", "echo session running");
    sendNotification(dir, "close");
    await waitFor(() => !fs.existsSync(dir), "closed session dir removed");
    const kept = transcriptDir(root, "s-kept");
    assert.ok(fs.existsSync(path.join(kept, "out.00000000.log")), "the out log must survive the session dir");
    assert.ok(fs.statSync(path.join(kept, "out.00000000.log")).size > 0, "an empty transcript is not a transcript");
    // spawn.json rides along: it is where a reader learns what produced
    // these bytes (for `acp`, which agent).
    assert.ok(fs.existsSync(path.join(kept, "spawn.json")), "spawn.json must be copied beside the log");
    const meta = transcriptMeta(root, "s-kept");
    assert.equal(meta?.kind, "echo");
    assert.equal(meta?.why, "closed");
    assert.equal(meta?.client, "c-test");
    assert.equal(meta?.origin, "https://example.test");
    assert.equal(meta?.gen, 0, "gen 0 = the log never rotated, so this is the whole conversation (#57)");
    assert.ok((meta?.bytes ?? 0) > 0);
  });
});

test("retention is opt-in: without it a closed session leaves nothing behind", async () => {
  // The generic host serves workbench echoes and shells; only an embedder
  // whose sessions carry a conversation asks for the record to outlive it.
  await withServer({ timings: { closeDelayMs: 25 } }, async (_server, root) => {
    const dir = makeSession(root, "s-gone", { kind: "echo" });
    await waitFor(() => status(dir)?.state === "running", "echo session running");
    sendNotification(dir, "close");
    await waitFor(() => !fs.existsSync(dir), "closed session dir removed");
    assert.ok(!fs.existsSync(path.join(root, ".fsio", "transcripts")), "retention off must archive nothing");
  });
});

test("close() keeps the transcript of a session it kills (the Ctrl-C case, #119)", async () => {
  // The demonstrated loss: a 572 KB agent session, recovered by hand from
  // this file, unrecoverable minutes later because the helper was stopped.
  const root = tmpRoot();
  const server = new HostServer({ root, transcripts: true });
  await server.start();
  const dir = makeSession(root, "s-ctrlc", { kind: "echo" });
  await waitFor(() => status(dir)?.state === "running", "echo session running");
  await server.close();
  assert.ok(fs.existsSync(path.join(transcriptDir(root, "s-ctrlc"), "out.00000000.log")), "close() must not take the conversation with it");
  assert.equal(transcriptMeta(root, "s-ctrlc")?.why, "host closed");
  fs.rmSync(root, { recursive: true, force: true });
});

test("cleanServiceDir() sweeps the plumbing and keeps transcripts/; with retention off it removes .fsio outright", async () => {
  // What the demo helper runs at Ctrl-C, in place of `rm -rf .fsio` (#119).
  const root = tmpRoot();
  const server = new HostServer({ root, transcripts: true });
  await server.start();
  const dir = makeSession(root, "s-swept", { kind: "echo" });
  await waitFor(() => status(dir)?.state === "running", "echo session running");
  await server.close();
  server.cleanServiceDir();
  const fsioDir = path.join(root, ".fsio");
  assert.deepEqual(fs.readdirSync(fsioDir), ["transcripts"], "only the durable record may survive the sweep");
  assert.ok(fs.existsSync(path.join(transcriptDir(root, "s-swept"), "out.00000000.log")));

  // Same folder, retention off: the pre-#119 behavior, unchanged.
  const plain = new HostServer({ root });
  await plain.start();
  await plain.close();
  plain.cleanServiceDir();
  assert.ok(!fs.existsSync(fsioDir), "retention off must hand the folder back pristine");
  fs.rmSync(root, { recursive: true, force: true });
});

test("fresh: true wipes the plumbing and spares the transcripts", async () => {
  // The other half of the contradiction #119 names: `fresh` is right that a
  // session pointing at a dead pid is not attachable, and was wrong that
  // the transcript is part of what makes it stale.
  const root = tmpRoot();
  const first = new HostServer({ root, transcripts: true });
  await first.start();
  const dir = makeSession(root, "s-before", { kind: "echo" });
  await waitFor(() => status(dir)?.state === "running", "echo session running");
  await first.close();
  assert.ok(fs.existsSync(dir), "close() leaves the session dir for the sweep that follows");

  const second = new HostServer({ root, fresh: true, transcripts: true });
  await second.start();
  assert.ok(!fs.existsSync(dir), "fresh: true must still sweep dead sessions");
  assert.ok(fs.existsSync(path.join(transcriptDir(root, "s-before"), "out.00000000.log")), "fresh: true must not delete the conversation");
  await second.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("retention bounds: the oldest transcripts drop at the count cap; the newest is never swept for size", async () => {
  const root = tmpRoot();
  const server = new HostServer({ root, transcripts: { keep: 2 }, timings: { closeDelayMs: 10 } });
  await server.start();
  for (const id of ["s-one", "s-two", "s-three"]) {
    const dir = makeSession(root, id, { kind: "echo" });
    await waitFor(() => status(dir)?.state === "running", `${id} running`);
    sendNotification(dir, "close");
    await waitFor(() => !fs.existsSync(dir), `${id} removed`);
    await waitFor(() => fs.existsSync(transcriptDir(root, id)), `${id} archived`);
  }
  assert.deepEqual(fs.readdirSync(path.join(root, ".fsio", "transcripts")).sort(), ["s-three", "s-two"], "the count cap keeps the newest N");
  await server.close();

  // A byte cap below one transcript must not delete the conversation the
  // human just ended — that is the failure this feature exists to prevent.
  const tight = new HostServer({ root, fresh: true, transcripts: { keep: 10, maxBytes: 1 } });
  await tight.start();
  assert.deepEqual(fs.readdirSync(path.join(root, ".fsio", "transcripts")), ["s-three"], "the newest transcript survives any byte cap");
  await tight.close();
  fs.rmSync(root, { recursive: true, force: true });
});
