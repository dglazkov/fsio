// Unit tests: JSON-RPC control plane (spec/PROTOCOL.md "Control plane", D10).
// The correlation rules here were hand-rolled three times before rpc.ts
// existed; these tests are why there won't be a fourth.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RpcEndpoint,
  RpcError,
  rpcRequest,
  rpcNotification,
  rpcResult,
  rpcError,
  type RpcRequestMsg,
  type RpcNotificationMsg,
} from "./rpc.js";

function endpoint() {
  const sent: (RpcRequestMsg | RpcNotificationMsg)[] = [];
  const ep = new RpcEndpoint((msg) => sent.push(msg));
  return { ep, sent };
}

test("envelope builders omit params when undefined", () => {
  assert.deepEqual(rpcRequest(1, "ping"), { jsonrpc: "2.0", id: 1, method: "ping" });
  assert.deepEqual(rpcNotification("close"), { jsonrpc: "2.0", method: "close" });
  assert.deepEqual(rpcRequest(1, "ping", { t0: 5 }).params, { t0: 5 });
});

test("rpcError defaults a missing id to null (unroutable per JSON-RPC)", () => {
  assert.equal(rpcError(undefined, -32700, "parse error").id, null);
});

test("request resolves {result, rx} from a matching response", async () => {
  const { ep, sent } = endpoint();
  const p = ep.request<{ ok: boolean }>("ping", { t0: 1 });
  const req = sent[0] as RpcRequestMsg;
  assert.equal(req.method, "ping");
  assert.equal(ep.handleMessage(rpcResult(req.id, { ok: true }), 1234), true);
  assert.deepEqual(await p, { result: { ok: true }, rx: 1234 });
});

test("error response rejects with RpcError carrying code and data", async () => {
  const { ep, sent } = endpoint();
  const p = ep.request("spawn");
  const req = sent[0] as RpcRequestMsg;
  ep.handleMessage(rpcError(req.id, 1001, "not allowed", { detail: 1 }));
  const err = (await p.then(() => null, (e: unknown) => e)) as RpcError;
  assert.ok(err instanceof RpcError);
  assert.equal(err.code, 1001);
  assert.deepEqual(err.data, { detail: 1 });
});

test("duplicate and unknown responses are consumed silently (spec: MUST ignore)", async () => {
  const { ep, sent } = endpoint();
  const p = ep.request("ping");
  const req = sent[0] as RpcRequestMsg;
  ep.handleMessage(rpcResult(req.id, 1));
  // Duplicate (host restart re-answering) and never-asked ids: consumed, no throw.
  assert.equal(ep.handleMessage(rpcResult(req.id, 2)), true);
  assert.equal(ep.handleMessage(rpcResult(999, 3)), true);
  assert.deepEqual((await p).result, 1); // first answer wins
});

test("requests and notifications are NOT consumed — caller dispatches them", () => {
  const { ep } = endpoint();
  assert.equal(ep.handleMessage(rpcRequest(5, "ping")), false);
  assert.equal(ep.handleMessage(rpcNotification("resize", { cols: 80 })), false);
  assert.equal(ep.handleMessage(null), false);
  assert.equal(ep.handleMessage("nonsense"), false);
});

test("timeout rejects, cleans up, and a late response is ignored", async () => {
  const { ep, sent } = endpoint();
  const p = ep.request("ping", undefined, { timeoutMs: 10 });
  const err = (await p.then(() => null, (e: unknown) => e)) as Error;
  assert.match(err.message, /timeout/);
  const req = sent[0] as RpcRequestMsg;
  assert.equal(ep.handleMessage(rpcResult(req.id, "late")), true); // ignored, no unhandled rejection
});

test("a throwing send() rejects the request instead of leaking a pending entry", async () => {
  const ep = new RpcEndpoint(() => {
    throw new Error("transport closed");
  });
  const err = (await ep.request("ping").then(() => null, (e: unknown) => e)) as Error;
  assert.match(err.message, /transport closed/);
});

test("expect() correlates out-of-band requests (the spawn.json pattern)", async () => {
  const { ep } = endpoint();
  const p = ep.expect<{ pid: number }>(0); // request rode a file, not a frame
  ep.handleMessage(rpcResult(0, { pid: 42 }), 7);
  assert.deepEqual(await p, { result: { pid: 42 }, rx: 7 });
});

test("failAll rejects everything in flight", async () => {
  const { ep } = endpoint();
  const ps = [ep.request("a"), ep.request("b"), ep.expect(0)];
  ep.failAll(new Error("session closed"));
  for (const p of ps) {
    const err = (await p.then(() => null, (e: unknown) => e)) as Error;
    assert.match(err.message, /session closed/);
  }
});
