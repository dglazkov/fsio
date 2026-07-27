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
import { HostServer, type HostServerOptions, type SpawnRequestInfo, type PtyModule } from "@fsio/host";
import { RpcErrors } from "@fsio/common";
import { FsioClient, RpcError, now, type PingResult } from "@fsio/client";
import { ShimDirectory } from "./fs-shim.js";

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

async function withHost(opts: Omit<HostServerOptions, "root">, fn: (client: FsioClient, root: string) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsio-b1-"));
  const server = new HostServer({ root, ...opts });
  await server.start();
  const client = new FsioClient(new ShimDirectory(root));
  try {
    await client.connect();
    await fn(client, root);
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
    const pending = await waitFor(() => server.listSessions().find((x) => x.id === s.id), "session to appear");
    assert.equal(pending.phase, "pending"); // policy hasn't answered (D12)
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
