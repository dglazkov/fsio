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
import { HostServer, type HostServerOptions } from "@fsio/host";
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
