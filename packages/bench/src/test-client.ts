// B1 client-conformance tests (TESTING.md): the REAL @fsio/client running
// over the Node fs shim (fs-shim.ts) against an in-process HostServer.
// This tier proves client *logic* — event delivery, construction/disposal
// semantics (D11), uplink lane selection (F10), lifecycle ownership (D6) —
// per push, no browser. Platform truth (F7/F10/F11 numbers) stays in the
// workbench labs.
//
// Hermetic: every scenario gets its own tmpdir, HostServer, and client.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HostServer, type HostServerOptions, type SpawnRequestInfo, type WorkspaceResolver, type PtyModule } from "@fsio/host";
import { RpcErrors } from "@fsio/common";
import { FsioClient, RpcError, now, type PingResult, type SessionStatus } from "@fsio/client";
import { ShimDirectory, type ShimFaults } from "./fs-shim.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | null | undefined | false, what: string, timeoutMs = 5000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

async function withHost(
  opts: Omit<HostServerOptions, "root">,
  fn: (client: FsioClient, root: string, faults: ShimFaults) => Promise<void>
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsio-b1-"));
  const server = new HostServer({ root, ...opts });
  await server.start();
  const faults: ShimFaults = {};
  const client = new FsioClient(new ShimDirectory(root, faults));
  try {
    await client.connect();
    await fn(client, root, faults);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ------------------------------------------------- discovery (spec: Discovery)

test("connect() discovers a live host via the host.json heartbeat", async () => {
  await withHost({}, async (client) => {
    const host = await client.hostInfo();
    assert.ok(host.alive, `host not alive (age ${host.ageMs}ms)`);
    assert.ok(host.info!.pid! > 0);
  });
});

// ----------------------------------- control plane round trip (spec D10)

test("echo session: ready resolves with the spawn result; ping round-trips", async () => {
  await withHost({}, async (client) => {
    const s = client.createSession({ kind: "echo", client: "b1" }, { pollMs: 5 });
    try {
      const info = await s.ready;
      assert.equal(info.kind, "echo");
      const { result } = await s.request<PingResult>("ping", { t0: now() }, { timeoutMs: 5000 });
      assert.ok(result.t1 > 0 && result.t2 >= result.t1, "host timestamps missing from ping result");
    } finally {
      await s.close();
    }
  });
});

// ------------------------- events + sync construction (D11; spec DATA plane)

test("data/frame/status events fire; listeners attached after createSession miss nothing", async () => {
  await withHost({ allowShell: true }, async (client) => {
    // createSession is synchronous (D11): no I/O can complete before these
    // listeners are attached, so the first status ("running") and the first
    // output MUST be observed — that's the guarantee under test.
    const s = client.createSession({ kind: "shell", cmd: "/bin/cat", pty: false }, { pollMs: 5 });
    const chunks: Buffer[] = [];
    const frames: number[] = [];
    const states: string[] = [];
    s.on("data", (b) => chunks.push(Buffer.from(b)));
    s.on("frame", (f) => frames.push(f.type));
    s.on("status", (st) => states.push(st.state));
    try {
      await s.ready;
      s.sendData("hello fsio\n");
      await waitFor(() => Buffer.concat(chunks).toString().includes("hello fsio"), "cat to echo the line");
      assert.ok(states.includes("running"), `missed the running status (saw: ${states.join(",") || "none"})`);
      assert.ok(frames.length > 0, "frame event should fire alongside data");
    } finally {
      await s.close();
    }
  });
});

// ------------------------------- spawn refusal (spec D10: errors as errors)

test("ready rejects with a coded RpcError when the host refuses the spawn", async () => {
  await withHost({ allowShell: false }, async (client) => {
    const s = client.createSession({ kind: "shell" }, { pollMs: 5 });
    try {
      await assert.rejects(s.ready, (e: unknown) => {
        assert.ok(e instanceof RpcError, `expected RpcError, got ${e}`);
        assert.equal(e.code, RpcErrors.SHELL_NOT_ALLOWED);
        return true;
      });
    } finally {
      await s.close();
    }
  });
});

// ------------------------------------------------ heartbeats (D17, #3)

test("client heartbeats flow at heartbeatMs and the host consumes them", async () => {
  // D17: the presence beacon is a real uplink notification — if the frame
  // were malformed the host's in-order consumption would stall and the
  // backlog below would never drain.
  await withHost({}, async (client) => {
    const s = client.createSession({ kind: "echo" }, { pollMs: 5, heartbeatMs: 25 });
    try {
      await s.ready;
      const base = s.stats.chunksWritten;
      await waitFor(() => s.stats.chunksWritten >= base + 3, "several heartbeats committed");
      const t0 = Date.now();
      while ((await s.uplinkBacklog()) > 0) {
        if (Date.now() - t0 > 5000) throw new Error("host did not consume the heartbeat chunks");
        await sleep(10);
      }
      assert.ok(s.stats.dirChunks >= 3, "heartbeats must ride the dirname fast lane");
    } finally {
      await s.close();
    }
  });
});

test("heartbeatMs: 0 disables the beacon", async () => {
  await withHost({}, async (client) => {
    const s = client.createSession({ kind: "echo" }, { pollMs: 5, heartbeatMs: 0 });
    try {
      await s.ready;
      await sleep(300); // let the spawn-response ack settle — it is uplink traffic too
      const base = s.stats.chunksWritten;
      await sleep(150);
      assert.equal(s.stats.chunksWritten, base, "no uplink traffic expected with the beacon off");
    } finally {
      await s.close();
    }
  });
});

// --------------------------------- notifier: stalled observe() guard (F19)

test("a stalled FileSystemObserver.observe() downgrades to polling; ready still resolves", async () => {
  // Node has no FileSystemObserver (the B1 tier forces the poll path), so
  // inject a stalling fake: observe() never settles — the failure mode F19
  // measured in Chrome (~49 s stall, no rejection, so the D7 refusal path
  // never fires). The guard must bound it and keep the session alive.
  class StallingObserver {
    constructor(_cb: (records: unknown[]) => void) {}
    observe(): Promise<void> {
      return new Promise(() => {}); // never settles
    }
    disconnect(): void {}
  }
  (globalThis as Record<string, unknown>).FileSystemObserver = StallingObserver;
  try {
    await withHost({}, async (client) => {
      const s = client.createSession({ kind: "echo", client: "b1-f19" }, { mode: "adaptive", pollMs: 5, observeSettleMs: 100 });
      const notes: string[] = [];
      s.on("note", (n) => notes.push(n));
      try {
        const t0 = Date.now();
        const info = await s.ready; // the stall must not gate this (F19)
        assert.equal(info.kind, "echo");
        assert.ok(Date.now() - t0 < 5000, "ready must not wait out the stalled observer");
        // The downgrade happens concurrently, at the observeSettleMs bound.
        await waitFor(() => s.mode === "poll", "the downgrade to polling");
        assert.ok(notes.some((n) => n.includes("F19")), `expected the F19 downgrade note (saw: ${notes.join(" | ") || "none"})`);
        const { result } = await s.request<PingResult>("ping", { t0: now() }, { timeoutMs: 5000 });
        assert.ok(result.t1 > 0, "session must be fully usable after the downgrade");
      } finally {
        await s.close();
      }
    });
  } finally {
    delete (globalThis as Record<string, unknown>).FileSystemObserver;
  }
});

// ------------------------------------------------ attach / detach (D18, #3)

const readStatus = (sessionDir: string): SessionStatus | null => {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionDir, "status.json"), "utf8")) as SessionStatus;
  } catch {
    return null;
  }
};

test("attach takeover: replayed scrollback, working uplink on the new epoch, superseded spawner fenced", async () => {
  // D18 end to end: B attaches to A's live shell — the grant bumps the
  // writer epoch, B's uplink rides in.1/, replay re-emits A's scrollback,
  // and A fences itself off the moment it observes the writer record
  // (one writer per file across takeovers, F8/D6).
  await withHost({ allowShell: true }, async (clientA, root) => {
    const a = clientA.createSession({ kind: "shell", cmd: "/bin/cat", pty: false }, { pollMs: 5, safetyMs: 50 });
    const aOut: Buffer[] = [];
    const aNotes: string[] = [];
    a.on("data", (x) => aOut.push(Buffer.from(x)));
    a.on("note", (n) => aNotes.push(n));
    try {
      await a.ready;
      a.sendData("scrollback-line\n");
      await waitFor(() => Buffer.concat(aOut).toString().includes("scrollback-line"), "cat echo to A");

      const clientB = new FsioClient(new ShimDirectory(root));
      await clientB.connect();
      const b = clientB.attachSession(a.id, { pollMs: 5, safetyMs: 50, replay: true });
      const bOut: Buffer[] = [];
      b.on("data", (x) => bOut.push(Buffer.from(x)));
      try {
        const grant = await b.ready;
        assert.equal(grant.kind, "shell");
        assert.equal(b.epoch, 1, "grant must carry the bumped writer epoch");
        await waitFor(() => Buffer.concat(bOut).toString().includes("scrollback-line"), "replayed scrollback at B");
        b.sendData("via-epoch-1\n");
        await waitFor(() => Buffer.concat(bOut).toString().includes("via-epoch-1"), "B's uplink (in.1/) round-trips");
        await waitFor(() => aNotes.some((n) => n.includes("superseded")), "A observes the fence");
        assert.throws(() => a.sendData("after-fence\n"), /superseded/, "a fenced writer must refuse to send");
      } finally {
        await b.close();
      }
    } finally {
      await a.close();
    }
  });
});

test("re-attach to a previously-attached session: the stale writer record must not fence the new attacher", async () => {
  // The #58 dead-terminal bug (cooperative loop, second pass): once a
  // session has been attached, status.json permanently names a writer.
  // A NEW attacher reads that record while its own epoch is still 0 —
  // before its grant response is even on disk — and fenced itself:
  // ready resolved, replay played, and every keystroke silently failed.
  // The async policy delay pins the ordering: C polls status (writer
  // epoch 1 from B's grant) for 250 ms before its own grant can land.
  await withHost(
    { onSpawnRequest: async (_spec, info) => { if (info.attach) await sleep(250); return true; } },
    async (client, root) => {
      const s = client.createSession({ kind: "echo" }, { pollMs: 5, safetyMs: 50 });
      await s.ready;
      const clientB = new FsioClient(new ShimDirectory(root));
      await clientB.connect();
      const b = clientB.attachSession(s.id, { pollMs: 5, safetyMs: 50 });
      await b.ready; // writer {epoch: 1} now durable in status.json
      await b.detach();
      const clientC = new FsioClient(new ShimDirectory(root));
      await clientC.connect();
      const c = clientC.attachSession(s.id, { pollMs: 5, safetyMs: 50 });
      const cNotes: string[] = [];
      c.on("note", (n) => cNotes.push(n));
      try {
        const grant = await c.ready;
        assert.equal(grant.epoch, 2);
        assert.ok(!cNotes.some((n) => n.includes("superseded")), `C fenced itself on the stale record: ${cNotes.join(" | ")}`);
        const { result } = await c.request<PingResult>("ping", { t0: now() }, { timeoutMs: 5000 });
        assert.ok(result.t1 > 0, "the resumed session must serve the new writer");
      } finally {
        await c.close();
        await s.close();
      }
    }
  );
});

test("attach to an exited session rejects with ATTACH_FAILED (1005)", async () => {
  await withHost({ allowShell: true }, async (client, root) => {
    const s = client.createSession({ kind: "shell", cmd: "/bin/sh", args: ["-c", "exit 0"], pty: false }, { pollMs: 5 });
    await s.ready;
    await s.waitForStatus((st) => st.state === "exited");
    const clientB = new FsioClient(new ShimDirectory(root));
    await clientB.connect();
    const b = clientB.attachSession(s.id, { pollMs: 5 });
    try {
      await assert.rejects(b.ready, (e: unknown) => {
        assert.ok(e instanceof RpcError, `expected RpcError, got ${e}`);
        assert.equal(e.code, RpcErrors.ATTACH_FAILED);
        return true;
      });
    } finally {
      await b.close();
      await s.close();
    }
  });
});

test("detach() marks the session detached immediately; a later attach clears it and takes over", async () => {
  // D18: deliberate walk-away must not wait out the D17 silence window,
  // and the session must survive to be adopted by the next client.
  await withHost({}, async (client, root) => {
    const s = client.createSession({ kind: "echo" }, { pollMs: 5, safetyMs: 50 });
    await s.ready;
    const dir = path.join(root, ".fsio", "sessions", s.id);
    await s.detach();
    await waitFor(() => readStatus(dir)?.detached === true, "detached marker after detach()");
    const clientB = new FsioClient(new ShimDirectory(root));
    await clientB.connect();
    const b = clientB.attachSession(s.id, { pollMs: 5, safetyMs: 50 });
    try {
      await b.ready;
      await waitFor(() => {
        const st = readStatus(dir);
        return st?.detached === undefined && st?.writer?.epoch === 1;
      }, "attach cleared the marker and recorded the writer");
      const { result } = await b.request<PingResult>("ping", { t0: now() }, { timeoutMs: 5000 });
      assert.ok(result.t1 > 0, "attached client must get service");
    } finally {
      await b.close();
    }
  });
});

test("listSessions() discovers sessions with kind, client tag, and status", async () => {
  await withHost({}, async (client) => {
    const s = client.createSession({ kind: "echo", client: "b1-list" }, { pollMs: 5 });
    try {
      await s.ready;
      const rows = await client.listSessions();
      const row = rows.find((r) => r.id === s.id);
      assert.ok(row, "spawned session not discovered");
      assert.equal(row.kind, "echo");
      assert.equal(row.client, "b1-list");
      assert.equal(row.status?.state, "running");
    } finally {
      await s.close();
    }
  });
});

test("attach consults the policy with attach:true; denial rejects ready with the coded error", async () => {
  // D18 judges an attach like a spawn of the same kind: the hook sees the
  // attacher's identity and attach:true, and its denial is fail-safe.
  const seen: SpawnRequestInfo[] = [];
  await withHost(
    {
      onSpawnRequest: (_spec, info) => {
        seen.push(info);
        return info.attach ? { allow: false, reason: "no takeovers" } : true;
      },
    },
    async (client, root) => {
      const s = client.createSession({ kind: "echo" }, { pollMs: 5 });
      await s.ready;
      const clientB = new FsioClient(new ShimDirectory(root));
      await clientB.connect();
      const b = clientB.attachSession(s.id, { pollMs: 5 });
      try {
        await assert.rejects(b.ready, (e: unknown) => {
          assert.ok(e instanceof RpcError, `expected RpcError, got ${e}`);
          assert.equal(e.code, RpcErrors.SPAWN_DENIED);
          assert.match(e.message, /no takeovers/);
          return true;
        });
        assert.ok(
          seen.some((i) => i.attach === true && i.kind === "echo"),
          "policy never saw the attach request"
        );
      } finally {
        await b.close();
        await s.close();
      }
    }
  );
});

// ------------------------------------------------ uplink lanes (F10, #4)

test("auto uplink: small batches ride the dirname lane, big ones fall back to files", async () => {
  await withHost({}, async (client) => {
    const s = client.createSession({ kind: "echo", client: "b1-lanes" }, { pollMs: 5, uplink: "auto" });
    try {
      await s.ready;
      await s.request<PingResult>("ping", { t0: now() }, { timeoutMs: 5000 }); // 81 B framed — dirname budget
      assert.ok(s.stats.dirChunks >= 1, `small ping should ride the dirname lane (stats: ${JSON.stringify(s.stats)})`);
      const before = s.stats.fileChunks;
      await s.request<PingResult>("ping", { t0: now(), filler: "x".repeat(400) }, { timeoutMs: 5000 }); // > DIR_CHUNK_MAX_BYTES
      assert.ok(s.stats.fileChunks > before, `oversized ping should fall back to a file chunk (stats: ${JSON.stringify(s.stats)})`);
      // uplinkBacklog (the labs' backlog probe, #4): a response implies the
      // host consumed-and-deleted our chunks, so the backlog must read 0.
      assert.equal(await s.uplinkBacklog(), 0, "in/ should be drained once requests are answered");
    } finally {
      await s.close();
    }
  });
});

test("uplink 'file' forces file chunks even for small batches", async () => {
  await withHost({}, async (client) => {
    const s = client.createSession({ kind: "echo", client: "b1-file" }, { pollMs: 5, uplink: "file" });
    try {
      await s.ready;
      await s.request<PingResult>("ping", { t0: now() }, { timeoutMs: 5000 });
      assert.equal(s.stats.dirChunks, 0);
      assert.ok(s.stats.fileChunks >= 1);
    } finally {
      await s.close();
    }
  });
});

// --------------------- uplink commit retry (#37; spec Uplink "corollary")
// A failed commit must not abandon its seq — the host consumes in/ strictly
// in order, so a gap wedges the session's uplink. The shim aborts commits
// the way CfT's Safe Browsing was observed to; the client must absorb it.

test("file-lane commit aborts are retried on the same seq; nothing is lost", async () => {
  await withHost({}, async (client, _root, faults) => {
    const s = client.createSession({ kind: "echo", client: "b1-retry" }, { pollMs: 5, uplink: "file" });
    const notes: string[] = [];
    s.on("note", (n) => notes.push(n));
    try {
      await s.ready;
      faults.closeAborts = 2; // first commit + first retry both abort
      const { result } = await s.request<PingResult>("ping", { t0: now() }, { timeoutMs: 5000 });
      assert.ok(result.t1 > 0, "ping must round-trip despite the aborted commits");
      assert.ok((s.stats.commitRetries ?? 0) >= 2, `expected ≥2 retries (stats: ${JSON.stringify(s.stats)})`);
      assert.ok(
        notes.some((n) => n.includes("commit failed") && n.includes("Aborted due to security policy")),
        `retries surface as notes, not silence (notes: ${JSON.stringify(notes)})`
      );
    } finally {
      await s.close();
    }
  });
});

test("a dirname commit abort falls back to a file chunk on the same seq (#4); one abort is no latch", async () => {
  // #37's same-seq guarantee, #4's lane fallback: the failed dir chunk
  // re-lands as a FILE chunk under the same number (idempotent — the two
  // lanes share one sequence space), instead of burning retries on a lane
  // that may be structurally broken.
  await withHost({}, async (client, _root, faults) => {
    const s = client.createSession({ kind: "echo", client: "b1-retry-dir" }, { pollMs: 5, uplink: "auto" });
    const notes: string[] = [];
    s.on("note", (n) => notes.push(n));
    try {
      await s.ready;
      faults.dirCreateAborts = 1;
      const { result } = await s.request<PingResult>("ping", { t0: now() }, { timeoutMs: 5000 }); // small → dirname lane
      assert.ok(result.t1 > 0, "ping must round-trip despite the aborted dir commit");
      assert.equal(s.stats.laneFallbacks, 1, `expected exactly one fallback (stats: ${JSON.stringify(s.stats)})`);
      assert.ok(s.stats.fileChunks >= 1, `fallback chunk must land as a file (stats: ${JSON.stringify(s.stats)})`);
      assert.ok(
        notes.some((n) => n.includes("falling back to a file chunk")),
        `fallback surfaces as a note (notes: ${JSON.stringify(notes)})`
      );
      // A single strike must not disable the lane (transient aborts exist,
      // #37): the next small batch tries dirname again.
      const dirBefore = s.stats.dirChunks;
      await s.request<PingResult>("ping", { t0: now() }, { timeoutMs: 5000 });
      assert.ok(s.stats.dirChunks > dirBefore, `one strike must not park the lane (stats: ${JSON.stringify(s.stats)})`);
      assert.notEqual(s.stats.dirLane, "broken");
    } finally {
      await s.close();
    }
  });
});

// --------------------------- dirname-lane health latches (#4)

test("repeated dirname failures latch the lane off for the session", async () => {
  // #4 failure-mode fallback: two commits that failed on the dir lane but
  // landed as files = the lane is structurally broken here (name limits,
  // filesystem quirks) — stop attempting it, traffic keeps flowing.
  await withHost({}, async (client, _root, faults) => {
    const s = client.createSession({ kind: "echo", client: "b1-lane-broken" }, { pollMs: 5, uplink: "auto" });
    const notes: string[] = [];
    s.on("note", (n) => notes.push(n));
    try {
      await s.ready;
      faults.dirCreateAborts = 99; // every dir attempt fails, files work
      await s.request<PingResult>("ping", { t0: now() }, { timeoutMs: 5000 });
      await s.request<PingResult>("ping", { t0: now() }, { timeoutMs: 5000 });
      await waitFor(() => s.stats.dirLane === "broken", `broken latch (stats: ${JSON.stringify(s.stats)}, notes: ${JSON.stringify(notes)})`);
      assert.ok(
        notes.some((n) => n.includes("dirname lane disabled")),
        `latch surfaces as a note (notes: ${JSON.stringify(notes)})`
      );
      // Once broken, small batches go straight to files: no more fallbacks.
      const fallbacksBefore = s.stats.laneFallbacks;
      const fileBefore = s.stats.fileChunks;
      await s.request<PingResult>("ping", { t0: now() }, { timeoutMs: 5000 });
      assert.ok(s.stats.fileChunks > fileBefore, "small batch must ride the file lane once broken");
      assert.equal(s.stats.laneFallbacks, fallbacksBefore, "no dir attempts (hence no fallbacks) after the latch");
    } finally {
      faults.dirCreateAborts = 0;
      await s.close();
    }
  });
});

test("a slow dirname lane is parked after a streak and restored by the periodic re-probe", async () => {
  // #4 durability probe: if Chrome starts scanning directory creation too
  // (the F10 asymmetry closing — every dir commit lands at the F7 scan
  // floor), the lane loses its reason to exist. Simulated with an injected
  // per-mkdir delay; recovery uses the real re-probe path (one live batch
  // after the cooldown), not a synthetic probe.
  await withHost({}, async (client, _root, faults) => {
    const s = client.createSession(
      { kind: "echo", client: "b1-lane-slow" },
      { pollMs: 5, uplink: "auto", uplinkLane: { slowMs: 15, reprobeMs: 200 } }
    );
    const notes: string[] = [];
    s.on("note", (n) => notes.push(n));
    try {
      await s.ready;
      faults.dirCreateDelayMs = 40; // > slowMs and > file baseline: "scanned"
      for (let i = 0; i < 4 && s.stats.dirLane === "on"; i++) {
        await s.request<PingResult>("ping", { t0: now() }, { timeoutMs: 5000 });
      }
      await waitFor(() => s.stats.dirLane === "slow", `slow latch (stats: ${JSON.stringify(s.stats)}, notes: ${JSON.stringify(notes)})`);
      const fileBefore = s.stats.fileChunks;
      await s.request<PingResult>("ping", { t0: now() }, { timeoutMs: 5000 });
      assert.ok(s.stats.fileChunks > fileBefore, "small batches prefer files while the lane is parked");
      // The asymmetry "reopens": after the cooldown, one real batch
      // re-probes the lane and restores it.
      faults.dirCreateDelayMs = 0;
      await sleep(250); // past reprobeMs
      await s.request<PingResult>("ping", { t0: now() }, { timeoutMs: 5000 });
      await waitFor(() => s.stats.dirLane === "on", `recovery (stats: ${JSON.stringify(s.stats)}, notes: ${JSON.stringify(notes)})`);
      assert.ok(
        notes.some((n) => n.includes("dirname lane slow")) && notes.some((n) => n.includes("recovered")),
        `both transitions surface as notes (notes: ${JSON.stringify(notes)})`
      );
      const dirBefore = s.stats.dirChunks;
      await s.request<PingResult>("ping", { t0: now() }, { timeoutMs: 5000 });
      assert.ok(s.stats.dirChunks > dirBefore, "restored lane carries small batches again");
    } finally {
      faults.dirCreateDelayMs = 0;
      await s.close();
    }
  });
});

test("retries are bounded: persistent aborts surface as an error and poison send()", async () => {
  await withHost({}, async (client, _root, faults) => {
    const s = client.createSession({ kind: "echo", client: "b1-retry-cap" }, { pollMs: 5, uplink: "file" });
    try {
      await s.ready;
      faults.closeAborts = 99; // more than the backoff schedule — never heals
      const surfaced = new Promise<Error>((resolve) => s.on("error", resolve));
      s.sendData("doomed");
      const err = await surfaced; // ~1.3 s: the full backoff schedule
      assert.match(err.message, /committing .*AbortError/);
      assert.throws(() => s.sendData("after"), /AbortError/, "send() after a dead pump must throw, not queue silently");
    } finally {
      faults.closeAborts = 0;
      await s.close();
    }
  });
});

// -------------------------------------- disposal + cleanup ownership (D6, D11)

test("unsubscribe stops delivery; close() lets the host remove the session dir", async () => {
  await withHost({ timings: { closeDelayMs: 50 } }, async (client, root) => {
    const s = client.createSession({ kind: "echo", client: "b1-dispose" }, { pollMs: 5 });
    let calls = 0;
    const off = s.on("frame", () => calls++);
    await s.ready;
    await s.request<PingResult>("ping", { t0: now() }, { timeoutMs: 5000 });
    off(); // disposal is the returned function (D11)
    const seen = calls;
    await s.request<PingResult>("ping", { t0: now() }, { timeoutMs: 5000 });
    assert.equal(calls, seen, "unsubscribed listener still called");
    const dir = path.join(root, ".fsio", "sessions", s.id);
    assert.ok(fs.existsSync(dir), "session dir should exist while open");
    await s.close();
    // Cleanup is HOST-owned (D6): the dir disappears without client deletes.
    await waitFor(() => !fs.existsSync(dir), "host to remove the closed session dir");
  });
});

// ------------------------------------------- spawn policy hook (D12, #6)

test("onSpawnRequest sees the resolved command and denies with a coded reason", async () => {
  const seen: SpawnRequestInfo[] = [];
  await withHost(
    {
      allowShell: true, // the hook must override the boolean, not AND with it
      onSpawnRequest: (_spec, info) => {
        seen.push(info);
        return { allow: false, reason: "cmd not on the allow-list" };
      },
    },
    async (client) => {
      const s = client.createSession({ kind: "shell", cmd: "/bin/cat", client: "b1-policy", pty: false }, { pollMs: 5 });
      try {
        await assert.rejects(s.ready, (e: unknown) => {
          assert.ok(e instanceof RpcError);
          assert.equal(e.code, RpcErrors.SPAWN_DENIED);
          assert.match(e.message, /allow-list/); // the policy's reason reaches the client
          return true;
        });
        // The hook judged the RESOLVED command (D12): what would run, not
        // just what was asked for.
        assert.equal(seen.length, 1);
        assert.equal(seen[0]!.kind, "shell");
        assert.equal(seen[0]!.cmd, "/bin/cat");
        assert.equal(seen[0]!.sessionId, s.id);
        assert.equal(seen[0]!.client, "b1-policy");
      } finally {
        await s.close();
      }
    }
  );
});

test("async policy is the confirmation mechanism: no service before the verdict", async () => {
  let allowedAt = 0;
  await withHost(
    {
      onSpawnRequest: async () => {
        await sleep(150);
        allowedAt = Date.now();
        return true;
      },
    },
    async (client) => {
      const t0 = Date.now();
      const s = client.createSession({ kind: "echo", client: "b1-confirm" }, { pollMs: 5 });
      try {
        // Fire a ping while the decision is pending: chunks must queue, not
        // be served (D12 — a pending-confirmation session answers nothing).
        const early = s.request<PingResult>("ping", { t0: now() }, { timeoutMs: 10000 });
        await s.ready;
        assert.ok(Date.now() - t0 >= 140, `ready resolved before the policy did (${Date.now() - t0}ms)`);
        const { rx } = await early;
        assert.ok(rx >= allowedAt - 5, "ping was answered before the spawn was approved");
      } finally {
        await s.close();
      }
    }
  );
});

test("policy allow overrides allowShell:false; the shell really runs", async () => {
  await withHost({ allowShell: false, onSpawnRequest: () => true }, async (client) => {
    const s = client.createSession({ kind: "shell", cmd: "/bin/cat", pty: false }, { pollMs: 5 });
    const chunks: Buffer[] = [];
    s.on("data", (b) => chunks.push(Buffer.from(b)));
    try {
      await s.ready;
      s.sendData("policy says yes\n");
      await waitFor(() => Buffer.concat(chunks).toString().includes("policy says yes"), "shell to echo under hook-granted spawn");
    } finally {
      await s.close();
    }
  });
});

test("a throwing policy denies — fail-safe, never fail-open", async () => {
  await withHost(
    {
      onSpawnRequest: () => {
        throw new Error("policy service unreachable");
      },
    },
    async (client) => {
      const s = client.createSession({ kind: "echo" }, { pollMs: 5 });
      try {
        await assert.rejects(s.ready, (e: unknown) => {
          assert.ok(e instanceof RpcError);
          assert.equal(e.code, RpcErrors.SPAWN_DENIED);
          return true;
        });
      } finally {
        await s.close();
      }
    }
  );
});

test("validity precedes policy: unknown kind is 1003 and the hook is never consulted", async () => {
  let consulted = 0;
  await withHost(
    {
      onSpawnRequest: () => {
        consulted++;
        return true;
      },
    },
    async (client) => {
      const s = client.createSession({ kind: "quantum" }, { pollMs: 5 });
      try {
        await assert.rejects(s.ready, (e: unknown) => {
          assert.ok(e instanceof RpcError);
          assert.equal(e.code, RpcErrors.UNKNOWN_KIND);
          return true;
        });
        assert.equal(consulted, 0, "an unknown kind must not reach the policy");
      } finally {
        await s.close();
      }
    }
  );
});

// ---------------------------------------------- registered kinds (D13)

test("registerKind: DATA roundtrip, custom RPC method, extra spawn-result fields", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsio-b1-"));
  const server = new HostServer({ root });
  // A kind is RPC methods + a DATA sink/source (D13): reverse every line,
  // answer `sum`, advertise a motd in the spawn result.
  server.registerKind("rev", (ctx) => ({
    result: { motd: `hello ${String(ctx.spec.client)}` },
    onData: (bytes) => {
      const line = Buffer.from(bytes).toString().trimEnd();
      ctx.write([...line].reverse().join("") + "\n");
    },
    methods: {
      sum: (params) => ({ total: ((params as { xs: number[] }).xs ?? []).reduce((a, b) => a + b, 0) }),
    },
  }));
  await server.start();
  const client = new FsioClient(new ShimDirectory(root));
  try {
    await client.connect();
    const s = client.createSession({ kind: "rev", client: "b1-kind" }, { pollMs: 5 });
    const chunks: Buffer[] = [];
    s.on("data", (b) => chunks.push(Buffer.from(b)));
    try {
      const info = await s.ready;
      assert.equal(info.kind, "rev");
      assert.equal(info["motd"], "hello b1-kind"); // kind result fields reach ready
      s.sendData("stressed\n");
      await waitFor(() => Buffer.concat(chunks).toString().includes("desserts"), "reversed line back");
      const { result } = await s.request<{ total: number }>("sum", { xs: [1, 2, 3] }, { timeoutMs: 5000 });
      assert.equal(result.total, 6);
      // builtin ping still answers on custom kinds (transport diagnostic);
      // undefined methods still -32601.
      await s.request<PingResult>("ping", { t0: now() }, { timeoutMs: 5000 });
      await assert.rejects(s.request("no-such", {}, { timeoutMs: 5000 }), (e: unknown) => {
        assert.ok(e instanceof RpcError);
        assert.equal(e.code, RpcErrors.METHOD_NOT_FOUND);
        return true;
      });
    } finally {
      await s.close();
    }
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("registered kinds pass the spawn policy; handler throw fails the spawn with 1002", async () => {
  const judged: string[] = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsio-b1-"));
  const server = new HostServer({
    root,
    onSpawnRequest: (_spec, info) => {
      judged.push(info.kind);
      return info.kind !== "vetoed"; // policy sees registered kinds too (D12+D13)
    },
  });
  server.registerKind("vetoed", () => ({}));
  server.registerKind("broken", () => {
    throw new Error("no backing store");
  });
  await server.start();
  const client = new FsioClient(new ShimDirectory(root));
  try {
    await client.connect();
    const denied = client.createSession({ kind: "vetoed" }, { pollMs: 5 });
    await assert.rejects(denied.ready, (e: unknown) => {
      assert.ok(e instanceof RpcError);
      assert.equal(e.code, RpcErrors.SPAWN_DENIED);
      return true;
    });
    await denied.close();
    const broken = client.createSession({ kind: "broken" }, { pollMs: 5 });
    await assert.rejects(broken.ready, (e: unknown) => {
      assert.ok(e instanceof RpcError);
      assert.equal(e.code, RpcErrors.SPAWN_FAILED);
      assert.match(e.message, /no backing store/);
      return true;
    });
    await broken.close();
    assert.deepEqual(judged, ["vetoed", "broken"]);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("kind exit() reaches the client as an exited status; onClose fires on client close", async () => {
  let closed = 0;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsio-b1-"));
  const server = new HostServer({ root, timings: { closeDelayMs: 50 } });
  server.registerKind("oneshot", (ctx) => ({
    methods: {
      finish: () => {
        ctx.exit(7);
        return {};
      },
    },
    onClose: () => closed++,
  }));
  await server.start();
  const client = new FsioClient(new ShimDirectory(root));
  try {
    await client.connect();
    const s = client.createSession({ kind: "oneshot" }, { pollMs: 5 });
    try {
      await s.ready;
      await s.request("finish", {}, { timeoutMs: 5000 });
      const st = await s.waitForStatus((x) => x.state === "exited");
      assert.equal(st.exitCode, 7);
    } finally {
      await s.close();
    }
    const dir = path.join(root, ".fsio", "sessions", s.id);
    await waitFor(() => !fs.existsSync(dir), "host to remove the closed kind session dir");
    // exit() already detached the kind session; close teardown is for live
    // sessions only — onClose after exit would be a double-teardown.
    assert.equal(closed, 0, "onClose must not fire after the kind's own exit()");
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("registerKind guards its namespace: shell and duplicates are refused", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsio-b1-"));
  try {
    const server = new HostServer({ root }); // never started — registration is pre-start config
    server.registerKind("mine", () => ({}));
    assert.throws(() => server.registerKind("mine", () => ({})), /already registered/);
    assert.throws(() => server.registerKind("shell", () => ({})), /already registered/);
    assert.throws(() => server.registerKind("echo", () => ({})), /already registered/); // echo IS the registry
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// -------------------------------------------- workspaces (D22, hub mode)
//
// The resolver hook is what makes folders session *parameters* instead of
// transport (D19/D22). fsiod supplies the registry (#71); these tests pin
// the rules the library owns: refuse rather than substitute, contain `cwd`,
// and never put a path on the wire.

/** A workspace fixture: a resolver over a fixed name→dir table. */
function workspaceFixture(names: string[]): { root: string; dirs: Record<string, string>; resolve: WorkspaceResolver; cleanup: () => void } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fsio-ws-"));
  const dirs: Record<string, string> = {};
  for (const n of names) fs.mkdirSync((dirs[n] = path.join(base, n)));
  return {
    root: base,
    dirs,
    resolve: (name) => {
      if (!name) return names.length === 1 ? { root: dirs[names[0]!]!, name: names[0]! } : { error: "name a workspace" };
      const dir = dirs[name];
      return dir ? { root: dir, name } : { error: `unknown workspace: ${name}` };
    },
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

test("a named workspace is where the child runs; the policy sees the same cwd (D22)", async () => {
  const ws = workspaceFixture(["alpha", "beta"]);
  const seen: SpawnRequestInfo[] = [];
  try {
    await withHost(
      {
        allowShell: true,
        workspaces: ws.resolve,
        onSpawnRequest: (_spec, info) => (seen.push(info), true),
      },
      async (client) => {
        const s = client.createSession({ kind: "shell", cmd: "/bin/pwd", workspace: "beta", pty: false }, { pollMs: 5 });
        let out = "";
        s.on("data", (d: Uint8Array) => (out += new TextDecoder().decode(d)));
        try {
          await s.ready;
          await waitFor(() => out.includes("beta") && out, "pwd output");
          assert.equal(fs.realpathSync(out.trim()), fs.realpathSync(ws.dirs["beta"]!));
          // The judged cwd and the executed cwd are one value (#6).
          assert.equal(seen[0]!.workspace, "beta");
          assert.equal(seen[0]!.cwd, ws.dirs["beta"]);
        } finally {
          await s.close();
        }
      }
    );
  } finally {
    ws.cleanup();
  }
});

test("an unresolvable workspace is 1006 and never reaches the policy (D22)", async () => {
  const ws = workspaceFixture(["alpha", "beta"]);
  let consulted = 0;
  try {
    await withHost(
      { allowShell: true, workspaces: ws.resolve, onSpawnRequest: () => (consulted++, true) },
      async (client) => {
        const s = client.createSession({ kind: "shell", workspace: "gamma", pty: false }, { pollMs: 5 });
        try {
          await assert.rejects(s.ready, (e: unknown) => {
            assert.ok(e instanceof RpcError);
            assert.equal(e.code, RpcErrors.UNKNOWN_WORKSPACE);
            return true;
          });
          // Subject before policy: there is nothing coherent to judge when
          // the host does not know what the session would act on.
          assert.equal(consulted, 0);
        } finally {
          await s.close();
        }
      }
    );
  } finally {
    ws.cleanup();
  }
});

test("omitting the workspace where one is required is 1006, not workspace zero (D22)", async () => {
  const ws = workspaceFixture(["alpha", "beta"]);
  try {
    await withHost({ allowShell: true, workspaces: ws.resolve }, async (client, root) => {
      const s = client.createSession({ kind: "shell", cmd: "/bin/pwd", pty: false }, { pollMs: 5 });
      try {
        await assert.rejects(s.ready, (e: unknown) => {
          assert.ok(e instanceof RpcError);
          assert.equal(e.code, RpcErrors.UNKNOWN_WORKSPACE);
          return true;
        });
        // Emphatically NOT the fallback the one-folder host would use: a
        // client told "ok" would believe it ran somewhere it did not.
        const status = readStatus(path.join(root, ".fsio", "sessions", s.id));
        assert.equal(status?.state, "error");
      } finally {
        await s.close();
      }
    });
  } finally {
    ws.cleanup();
  }
});

test("cwd is workspace-relative and cannot escape the root (D22)", async () => {
  const ws = workspaceFixture(["alpha"]);
  fs.mkdirSync(path.join(ws.dirs["alpha"]!, "sub"));
  try {
    await withHost({ allowShell: true, workspaces: ws.resolve }, async (client) => {
      const inside = client.createSession({ kind: "shell", cmd: "/bin/pwd", workspace: "alpha", cwd: "sub", pty: false }, { pollMs: 5 });
      let out = "";
      inside.on("data", (d: Uint8Array) => (out += new TextDecoder().decode(d)));
      try {
        await inside.ready;
        await waitFor(() => out.includes("sub") && out, "pwd output");
        assert.equal(fs.realpathSync(out.trim()), fs.realpathSync(path.join(ws.dirs["alpha"]!, "sub")));
      } finally {
        await inside.close();
      }
      const escaping = client.createSession(
        { kind: "shell", cmd: "/bin/pwd", workspace: "alpha", cwd: "../beta", pty: false },
        { pollMs: 5 }
      );
      try {
        await assert.rejects(escaping.ready, (e: unknown) => {
          assert.ok(e instanceof RpcError);
          assert.equal(e.code, RpcErrors.INVALID_PARAMS);
          assert.match(e.message, /escapes the workspace/);
          return true;
        });
      } finally {
        await escaping.close();
      }
    });
  } finally {
    ws.cleanup();
  }
});

test("a symlink inside the workspace is not an escape hatch (D22)", async () => {
  const ws = workspaceFixture(["alpha"]);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "fsio-outside-"));
  fs.symlinkSync(outside, path.join(ws.dirs["alpha"]!, "out"));
  try {
    await withHost({ allowShell: true, workspaces: ws.resolve }, async (client) => {
      const s = client.createSession({ kind: "shell", cmd: "/bin/pwd", workspace: "alpha", cwd: "out", pty: false }, { pollMs: 5 });
      try {
        await assert.rejects(s.ready, (e: unknown) => {
          assert.ok(e instanceof RpcError);
          assert.equal(e.code, RpcErrors.INVALID_PARAMS);
          return true;
        });
      } finally {
        await s.close();
      }
    });
  } finally {
    ws.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("one-folder mode is a registry of one: no name = the shared dir, a foreign name is still 1006 (D22)", async () => {
  // The hub rules are additive and optional (spec: Hub deployment) — a host
  // with no registry serves specs that name nothing exactly as it did
  // before D22. But "ignore the field" would be the substitution D22
  // forbids, so an unadvertised name is refused here too.
  await withHost({ allowShell: true }, async (client, root) => {
    const s = client.createSession({ kind: "shell", cmd: "/bin/pwd", pty: false }, { pollMs: 5 });
    let out = "";
    s.on("data", (d: Uint8Array) => (out += new TextDecoder().decode(d)));
    try {
      await s.ready;
      await waitFor(() => out.trim() && out, "pwd output");
      assert.equal(fs.realpathSync(out.trim()), fs.realpathSync(root));
    } finally {
      await s.close();
    }
    const foreign = client.createSession({ kind: "shell", cmd: "/bin/pwd", workspace: "elsewhere", pty: false }, { pollMs: 5 });
    try {
      await assert.rejects(foreign.ready, (e: unknown) => {
        assert.ok(e instanceof RpcError);
        assert.equal(e.code, RpcErrors.UNKNOWN_WORKSPACE);
        return true;
      });
    } finally {
      await foreign.close();
    }
  });
});

test("workspaceName: the name a one-folder host advertises resolves to its shared dir (D22)", async () => {
  await withHost({ allowShell: true, workspaceName: "here" }, async (client, root) => {
    const s = client.createSession({ kind: "shell", cmd: "/bin/pwd", workspace: "here", pty: false }, { pollMs: 5 });
    let out = "";
    s.on("data", (d: Uint8Array) => (out += new TextDecoder().decode(d)));
    try {
      await s.ready;
      await waitFor(() => out.trim() && out, "pwd output");
      assert.equal(fs.realpathSync(out.trim()), fs.realpathSync(root));
    } finally {
      await s.close();
    }
  });
});

test("a hostile workspace name does not reach status.json intact (control chars, length)", async () => {
  await withHost({ allowShell: true }, async (client, root) => {
    const nasty = `\u001b[2J\u0007${"x".repeat(300)}`;
    const s = client.createSession({ kind: "shell", workspace: nasty, pty: false }, { pollMs: 5 });
    try {
      await assert.rejects(s.ready, (e: unknown) => {
        assert.ok(e instanceof RpcError);
        assert.equal(e.code, RpcErrors.UNKNOWN_WORKSPACE);
        assert.ok(!/[\u001b\u0007]/.test(e.message), "escape sequences must not survive the echo");
        assert.ok(e.message.length < 128, `error must stay bounded, got ${e.message.length}`);
        return true;
      });
      const status = readStatus(path.join(root, ".fsio", "sessions", s.id));
      assert.ok(!/[\u001b\u0007]/.test(status?.error ?? ""), "nor into the file a human cats");
    } finally {
      await s.close();
    }
  });
});

// ---------------------------------- host introspection: listSessions (D14)

test("listSessions: phases pending → running → gone; fields for a confirmation UI", async () => {
  // Q4 of #26 — the surface #16's host-side confirmation reads. Explicit
  // plumbing instead of withHost: the test needs the server handle.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsio-b1-"));
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => (release = r));
  const server = new HostServer({
    root,
    timings: { closeDelayMs: 50 },
    onSpawnRequest: async () => {
      await gate; // hold the session in the pending phase
      return true;
    },
  });
  await server.start();
  const client = new FsioClient(new ShimDirectory(root));
  try {
    await client.connect();
    const s = client.createSession({ kind: "echo", client: "b1-list" }, { pollMs: 5 });
    // Poll for the phase, don't snapshot the first sighting: a session is
    // listed from dir-adoption on, and "adopted" (spawn.json not yet read)
    // precedes "pending" — CI caught that window (run 30232116904). The
    // gated policy makes "pending" sticky, so waiting for it is sound.
    const pending = await waitFor(() => {
      const x = server.listSessions().find((i) => i.id === s.id);
      return x?.phase === "pending" ? x : null;
    }, "session to reach the pending phase");
    assert.equal(pending.kind, "echo");
    assert.equal(pending.client, "b1-list");
    release!();
    await s.ready;
    const running = server.listSessions().find((x) => x.id === s.id)!;
    assert.equal(running.phase, "running");
    assert.equal(running.pid, process.pid); // in-process kind
    await s.close();
    // Host-owned cleanup also drops the in-memory entry — before D14 the
    // sessions map grew for the life of the host.
    await waitFor(() => !server.listSessions().some((x) => x.id === s.id), "session entry GC'd with its dir");
  } finally {
    void server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------- origin stamping (D15)

test("origin: library-stamped from location, overrides a spoofed caller value, visible to policy and listSessions (D15)", async () => {
  // Spec "Session kinds": the reference client stamps `location.origin`
  // itself — a page cannot claim a foreign origin through the API — and
  // the host surfaces it on both displays (D12 policy info, D14
  // listSessions). Node has no `location`; simulate the browser reality.
  const g = globalThis as { location?: { origin: string } };
  g.location = { origin: "https://demo.example" };
  try {
    // Explicit plumbing instead of withHost: the test needs the server
    // handle for listSessions (same reasoning as the phases test above).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsio-b1-"));
    let policySaw: string | undefined;
    const server = new HostServer({
      root,
      onSpawnRequest: (_spec, info) => {
        policySaw = info.origin;
        return true;
      },
    });
    await server.start();
    const client = new FsioClient(new ShimDirectory(root));
    try {
      await client.connect();
      const s = client.createSession({ kind: "echo", origin: "https://spoofed.example" }, { pollMs: 5 });
      await s.ready;
      assert.equal(policySaw, "https://demo.example", "policy must see the stamped origin, not the caller's claim");
      const listed = server.listSessions().find((x) => x.id === s.id)!;
      assert.equal(listed.origin, "https://demo.example");
      await s.close();
    } finally {
      void server.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  } finally {
    delete g.location;
  }
});

// ------------------------------------------- pty injection (D14, Q6 of #26)

test("injected PtyModule: the pty branch runs under CI — spawn result, data, resize, kill", async () => {
  // The one startShell path B1 could never reach: CI has no node-pty. A
  // fake PtyModule makes the branch testable end-to-end.
  const calls: { resize: [number, number][]; killed: string[]; spawned: string[] } = { resize: [], killed: [], spawned: [] };
  const makeFakePty = () => {
    const dataCbs: ((d: string) => void)[] = [];
    const exitCbs: ((e: { exitCode: number }) => void)[] = [];
    return {
      pid: 4242,
      write: (data: string) => {
        for (const cb of dataCbs) cb(`fake-pty:${data}`);
      },
      resize: (cols: number, rows: number) => calls.resize.push([cols, rows]),
      kill: (signal?: string) => {
        calls.killed.push(signal ?? "SIGTERM");
        for (const cb of exitCbs) cb({ exitCode: 0 });
      },
      pause: () => {},
      resume: () => {},
      onData: (cb: (d: string) => void) => dataCbs.push(cb),
      onExit: (cb: (e: { exitCode: number }) => void) => exitCbs.push(cb),
    };
  };
  const fakeModule: PtyModule = {
    spawn: (file, _args, _opts) => {
      calls.spawned.push(file);
      return makeFakePty();
    },
  };
  await withHost({ allowShell: true, pty: fakeModule }, async (client) => {
    const s = client.createSession({ kind: "shell", cmd: "fakesh" }, { pollMs: 5 });
    const chunks: Buffer[] = [];
    s.on("data", (b) => chunks.push(Buffer.from(b)));
    try {
      const info = await s.ready;
      assert.equal(info.pty, true);
      assert.equal(info.pid, 4242);
      assert.deepEqual(calls.spawned, ["fakesh"]);
      s.sendData("hello");
      await waitFor(() => Buffer.concat(chunks).toString().includes("fake-pty:hello"), "data through the fake pty");
      s.notify("resize", { cols: 132, rows: 43 });
      await waitFor(() => calls.resize.length > 0, "resize to reach the pty");
      assert.deepEqual(calls.resize[0], [132, 43]);
    } finally {
      await s.close();
    }
    await waitFor(() => calls.killed.length > 0, "close to kill the pty");
  });
});

// ------------------------------------- listener exception isolation (D11)

test("a throwing listener routes to the error event and loses no frames", async () => {
  await withHost({ allowShell: true }, async (client) => {
    const s = client.createSession({ kind: "shell", cmd: "/bin/cat", pty: false }, { pollMs: 5 });
    const errors: Error[] = [];
    const chunks: Buffer[] = [];
    s.on("error", (e) => errors.push(e));
    s.on("data", () => {
      throw new Error("hostile listener");
    });
    s.on("data", (b) => chunks.push(Buffer.from(b)));
    try {
      await s.ready;
      s.sendData("first\n");
      await waitFor(() => Buffer.concat(chunks).toString().includes("first"), "first line despite the throwing listener");
      s.sendData("second\n");
      await waitFor(() => Buffer.concat(chunks).toString().includes("second"), "second line despite the throwing listener");
      assert.ok(errors.length >= 1, "listener exceptions should surface on the error event");
      assert.match(errors[0]!.message, /hostile listener/);
    } finally {
      await s.close();
    }
  });
});

// ------------------------------ service directory (D24/D25, spec: Hub deployment)
//
// The capability document is how a page discovers what a host can do —
// and, in hub mode, that a workspace exists at all. Three rules carry the
// weight: the heartbeat is the doorbell and the document is the state (D3's
// split, so a 2 s beat never re-parses a growing file); it advertises names
// and never paths (D22/D20 — one file serves every co-tenant); and clients
// feature-detect on capability names, never on a `protocol` range (D25).

test("the service directory is published at start and the heartbeat points at it (D24)", async () => {
  await withHost({ allowShell: true }, async (client, root) => {
    const doc = (await client.services())!;
    assert.ok(doc, "services.json should exist once the host has started");
    assert.ok(doc.rev >= 1, `rev should start at 1, got ${doc.rev}`);
    assert.equal(doc.protocol, 0, "the hub chapter is additive: protocol stays 0 (D25)");
    assert.deepEqual(
      doc.kinds.map((k) => k.name).sort(),
      ["echo", "shell"],
      "kinds is D13's registry surfaced to pages"
    );
    assert.ok(doc.capabilities.includes("attach"), `attach should be advertised (got ${doc.capabilities.join(",")})`);

    // The doorbell: host.json's servicesRev names the revision on disk, so
    // a client already statting the heartbeat knows when to re-read.
    const host = await client.hostInfo();
    assert.equal(host.info!.servicesRev, doc.rev);
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, ".fsio", "services.json"), "utf8"));
    assert.equal(onDisk.rev, doc.rev);
  });
});

test("services.json is temp+renamed only when its content changes (D24)", async () => {
  // The whole reason it is a separate file from the 2 s heartbeat.
  await withHost({ timings: { heartbeatMs: 20 } }, async (client, root) => {
    const file = path.join(root, ".fsio", "services.json");
    const before = fs.statSync(file).mtimeMs;
    const beat0 = (await client.hostInfo()).info!.seq;
    await sleep(200); // ~10 beats
    const beat1 = (await client.hostInfo()).info!.seq;
    assert.ok(beat1 > beat0 + 3, `heartbeat should have moved (${beat0} → ${beat1})`);
    assert.equal(fs.statSync(file).mtimeMs, before, "a heartbeat must not rewrite the capability document");
    assert.equal((await client.services())!.rev, 1, "rev moves on content change, not on time");
  });
});

test("a workspace appearing moves the rev and the doorbell; the client re-reads only then (D24)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsio-b1-"));
  const server = new HostServer({ root, workspaceName: "here" });
  await server.start();
  const client = new FsioClient(new ShimDirectory(root, {}));
  try {
    await client.connect();
    const rev0 = (await client.services())!.rev;

    server.setServices({ workspaces: [{ name: "alpha", label: "Project Alpha" }] });
    const beat = (await client.hostInfo()).info!;
    assert.equal(beat.servicesRev, rev0 + 1, "the rev bump rides the heartbeat immediately, not the next beat");

    // Handed a stale rev, the client answers from cache — that is what the
    // doorbell buys. Handed the new one, it re-reads.
    assert.deepEqual((await client.services(rev0))!.workspaces, undefined, "a stale rev must not force a re-read");
    const fresh = (await client.services(beat.servicesRev))!;
    assert.deepEqual(fresh.workspaces, [{ name: "alpha", label: "Project Alpha" }]);

    // Republishing the same content is a no-op: no rewrite, no rev bump.
    server.setServices({ workspaces: [{ name: "alpha", label: "Project Alpha" }] });
    assert.equal((await client.hostInfo()).info!.servicesRev, fresh.rev);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the directory advertises workspace names, never paths (D22/D24)", async () => {
  const ws = workspaceFixture(["alpha", "beta"]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsio-b1-"));
  const server = new HostServer({
    root,
    allowShell: true,
    workspaces: ws.resolve,
    // The registry has two entries; the user marked one advertisable. One
    // file serves every co-tenant, so the other name is not in it either.
    services: { workspaces: [{ name: "alpha" }], needsGrant: ["shell"] },
  });
  await server.start();
  const client = new FsioClient(new ShimDirectory(root, {}));
  try {
    await client.connect();
    const raw = fs.readFileSync(path.join(root, ".fsio", "services.json"), "utf8");
    const doc = (await client.services())!;
    assert.deepEqual(doc.workspaces, [{ name: "alpha" }]);
    assert.ok(!raw.includes(ws.dirs["alpha"]!), "a path must never reach the hub folder (D20/D22)");
    assert.ok(!raw.includes("beta"), "an unadvertised name must not leak to every tenant");
    assert.ok(doc.capabilities.includes("workspaces"), "a host with a registry advertises the capability");
    assert.deepEqual(
      doc.kinds.find((k) => k.name === "shell"),
      { name: "shell", needsGrant: true },
      "a process-spawning kind declares that it needs a grant (D23 rule 1)"
    );
    assert.deepEqual(doc.kinds.find((k) => k.name === "echo"), { name: "echo" }, "hub-confined kinds are served ungranted");
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
    ws.cleanup();
  }
});

test("capabilities are feature-detected names, and an unknown one is not fatal (D25)", async () => {
  // A host that will not serve shells does not advertise the name; a client
  // gates on the name rather than on a version range, and asking about a
  // name nobody implements is an ordinary false.
  await withHost({ allowShell: false }, async (client) => {
    const doc = (await client.services())!;
    assert.ok(!doc.capabilities.includes("shell"), `shell must not be advertised by a host that refuses it: ${doc.capabilities}`);
    assert.deepEqual(doc.kinds.map((k) => k.name), ["echo"]);
    assert.ok(!doc.capabilities.includes("workspaces"), "a one-folder host with no name resolves none (D22)");
    assert.equal(await client.hasCapability("teleportation"), false, "an unknown capability name is a no, not a throw");
    assert.equal(await client.hasCapability("attach"), true);
  });
});

test("a kind's embedder detail is transcribed verbatim and never interpreted (D31)", async () => {
  // The acp demo's agent roster (#102) is the first consumer: the embedder
  // knows what a roster is, the library knows only that it is a JSON object
  // it must carry unchanged and republish when it changes.
  const roster = { agents: [{ name: "pi-acp", installed: true, asks: false }] };
  await withHost({ services: { kindDetail: { echo: roster, ghost: { x: 1 } } } }, async (client, root) => {
    const doc = (await client.services())!;
    assert.deepEqual(doc.kinds.find((k) => k.name === "echo")?.detail, roster, "detail rides the kind it describes");
    assert.ok(!doc.kinds.some((k) => k.name === "ghost"), "detail for a kind nobody serves advertises nothing");
    // On disk as written, not as some canonical re-encoding of ours: a page
    // parsing this must see exactly the object the embedder handed over.
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, ".fsio", "services.json"), "utf8"));
    assert.deepEqual(onDisk.kinds.find((k: { name: string }) => k.name === "echo").detail, roster);
  });
});

test("detail moves the revision when it changes, and only then (D24/D31)", async () => {
  // The doorbell is what makes a live roster cost nothing: the helper
  // re-scans PATH on a timer, and a scan that finds no news writes nothing.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsio-b1-"));
  const server = new HostServer({ root });
  const client = new FsioClient(new ShimDirectory(root, {}));
  try {
    await server.start();
    await client.connect();
    const detail = (installed: boolean) => ({ kindDetail: { echo: { agents: [{ name: "pi-acp", installed }] } } });

    server.setServices(detail(false));
    const rev0 = server.services().rev;
    server.setServices(detail(false));
    assert.equal(server.services().rev, rev0, "an unchanged re-scan must not move the doorbell");

    server.setServices(detail(true));
    const rev1 = server.services().rev;
    assert.equal(rev1, rev0 + 1, "an agent appearing is news");
    const fresh = (await client.services((await client.hostInfo()).info!.servicesRev))!;
    assert.equal(fresh.rev, rev1);
    assert.deepEqual(fresh.kinds.find((k) => k.name === "echo")?.detail, { agents: [{ name: "pi-acp", installed: true }] });

    // Not an object is not detail. The document has one shape for every
    // reader, and the library is the last place that can hold that line.
    server.setServices({ kindDetail: { echo: ["pi-acp"] as unknown as Record<string, unknown> } });
    assert.equal(server.services().kinds.find((k) => k.name === "echo")?.detail, undefined);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a kind registered after start() is advertised (D13/D24)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsio-b1-"));
  const server = new HostServer({ root });
  await server.start();
  try {
    const rev0 = server.services().rev;
    server.registerKind("weather", () => ({}));
    const doc = server.services();
    assert.deepEqual(doc.kinds.map((k) => k.name), ["echo", "weather"]);
    assert.equal(doc.rev, rev0 + 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".fsio", "host.json"), "utf8")).servicesRev, doc.rev);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a co-tenant scribble on services.json never rewinds the revision (D20/D24)", async () => {
  // Everything in the hub is writable by every granted origin, so the
  // document is not a security mechanism — but a client that cached rev 99
  // must not be told "rev 1" and keep its stale copy forever.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsio-b1-"));
  try {
    const first = new HostServer({ root });
    await first.start();
    await first.close();
    const file = path.join(root, ".fsio", "services.json");
    fs.writeFileSync(file, JSON.stringify({ rev: 99, capabilities: "not-an-array", kinds: null, junk: true }));

    const second = new HostServer({ root, takeover: true });
    await second.start();
    try {
      const doc = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(doc.rev, 100, "the revision carries forward, it never rewinds");
      assert.deepEqual(doc.kinds, [{ name: "echo" }], "a garbage document is repaired, not inherited");
      assert.ok(!("junk" in doc), "unknown fields are ignored, not propagated (D25)");
    } finally {
      await second.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an unchanged document survives a restart without ringing the doorbell (D24)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsio-b1-"));
  try {
    const first = new HostServer({ root, allowShell: true });
    await first.start();
    const rev = first.services().rev;
    const mtime = fs.statSync(path.join(root, ".fsio", "services.json")).mtimeMs;
    await first.close();

    const second = new HostServer({ root, allowShell: true, takeover: true });
    await second.start();
    try {
      assert.equal(second.services().rev, rev, "a restart that changes nothing must not invalidate cached copies");
      assert.equal(fs.statSync(path.join(root, ".fsio", "services.json")).mtimeMs, mtime, "…and must not rewrite the file");
    } finally {
      await second.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
