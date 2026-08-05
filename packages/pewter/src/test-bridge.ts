// The extension's end of the channel, without a browser.
//
// Node has MessageChannel, so both ends of the real thing run here: the
// extension's `Channel` on one port, a stand-in shell on the other. What is
// left for the cooperative loop is the iframe and the window message that
// delivers the port.
import assert from "node:assert/strict";
import test from "node:test";
import { apiFor, Channel, PewtError } from "./api.js";
import { answer, asCall, event, refusal, WIRE_VERSION } from "./wire.js";

/** The shell, as these tests play it: answer every call with `reply`. */
function shell(port: MessagePort, reply: (method: string, params: unknown) => unknown): string[] {
  const seen: string[] = [];
  port.onmessage = (event: MessageEvent) => {
    const call = asCall(event.data);
    if (!call) return;
    seen.push(call.method);
    try {
      port.postMessage(answer(call.id, reply(call.method, call.params)));
    } catch (e) {
      port.postMessage(refusal(call.id, { code: "no", message: (e as Error).message, hint: "try something else" }));
    }
  };
  port.start();
  return seen;
}

test("a call travels, and its answer comes back", async () => {
  const { port1, port2 } = new MessageChannel();
  shell(port2, () => ({ repos: [{ name: "site", git: true }] }));
  const channel = new Channel();
  channel.attach(port1);
  const pewt = apiFor(channel);
  assert.deepEqual(await pewt.repos.list(), { repos: [{ name: "site", git: true }] });
  port1.close();
  port2.close();
});

test("calls made before the port arrives are queued, not lost", async () => {
  const channel = new Channel();
  const pewt = apiFor(channel);
  // An extension's first line runs before the shell's message lands. This is
  // the race the queue exists for, so it is the one under test.
  const pending = Promise.all([pewt.repos.list(), pewt.ext.bundle({ name: "repos" })]);
  assert.equal(channel.attached, false);

  const { port1, port2 } = new MessageChannel();
  const seen = shell(port2, (method) => (method === "repos.list" ? { repos: [] } : { name: "repos", path: ".pewter/build/repos.html" }));
  channel.attach(port1);

  const [repos, bundle] = await pending;
  assert.deepEqual(repos, { repos: [] });
  assert.equal((bundle as { name: string }).name, "repos");
  assert.deepEqual(seen, ["repos.list", "ext.bundle"]);
  port1.close();
  port2.close();
});

test("a refusal arrives as a thrown error carrying the operation's own code", async () => {
  const { port1, port2 } = new MessageChannel();
  shell(port2, () => {
    throw new Error("extensions/nope/ has no index.html");
  });
  const channel = new Channel();
  channel.attach(port1);
  await assert.rejects(
    () => apiFor(channel).ext.bundle({ name: "nope" }),
    (e: unknown) => e instanceof PewtError && e.code === "no" && e.hint === "try something else"
  );
  port1.close();
  port2.close();
});

test("two calls in flight get their own answers", async () => {
  const { port1, port2 } = new MessageChannel();
  shell(port2, (_method, params) => params);
  const channel = new Channel();
  channel.attach(port1);
  const [a, b] = await Promise.all([channel.call("ext.bundle", { name: "one" }), channel.call("ext.bundle", { name: "two" })]);
  assert.deepEqual(a, { name: "one" });
  assert.deepEqual(b, { name: "two" });
  port1.close();
  port2.close();
});

test("a frame from another build is dropped rather than answered", async () => {
  const { port1, port2 } = new MessageChannel();
  const channel = new Channel();
  channel.attach(port1);
  const pending = channel.call("repos.list");
  let settled = false;
  void pending.then(
    () => (settled = true),
    () => (settled = true)
  );
  // Right id, wrong version: a shell that has moved on from this extension's
  // vocabulary. Dropping it leaves the call outstanding, which is honest —
  // answering it with a guess would not be.
  port2.postMessage({ v: WIRE_VERSION + 1, id: 1, ok: true, result: {} });
  port2.postMessage("not even an object");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settled, false);
  port1.close();
  port2.close();
});

test("a run's output arrives while it is still running, then its answer", async () => {
  const { port1, port2 } = new MessageChannel();
  const order: string[] = [];
  port2.onmessage = (e: MessageEvent) => {
    const call = asCall(e.data)!;
    // The shape the shell produces (pewter-shell/web/bridge.ts): events keyed
    // to the call, then one answer.
    port2.postMessage(event(call.id, { o: "compiling" }));
    port2.postMessage(event(call.id, { e: "one warning" }));
    port2.postMessage(answer(call.id, { exitCode: 0 }));
  };
  port2.start();

  const channel = new Channel();
  channel.attach(port1);
  const result = await apiFor(channel).run("build", {
    repo: "site",
    onOutput: (line, stream) => order.push(`${stream}: ${line}`),
  });
  assert.deepEqual(result, { exitCode: 0 });
  assert.deepEqual(order, ["out: compiling", "err: one warning"]);
  port1.close();
  port2.close();
});

test("an extension's own callback throwing does not lose the run's answer", async () => {
  const { port1, port2 } = new MessageChannel();
  port2.onmessage = (e: MessageEvent) => {
    const call = asCall(e.data)!;
    port2.postMessage(event(call.id, { o: "a line" }));
    port2.postMessage(answer(call.id, { exitCode: 2 }));
  };
  port2.start();
  const channel = new Channel();
  channel.attach(port1);
  const result = await apiFor(channel).run("build", {
    onOutput: () => {
      throw new Error("the extension has a bug");
    },
  });
  assert.deepEqual(result, { exitCode: 2 });
  port1.close();
  port2.close();
});

test("an event for a call that already ended is dropped", async () => {
  const { port1, port2 } = new MessageChannel();
  port2.onmessage = (e: MessageEvent) => {
    const call = asCall(e.data)!;
    port2.postMessage(answer(call.id, { exitCode: 0 }));
    port2.postMessage(event(call.id, { o: "too late" }));
  };
  port2.start();
  const channel = new Channel();
  channel.attach(port1);
  const seen: string[] = [];
  await apiFor(channel).run("build", { onOutput: (line) => seen.push(line) });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen, []);
  port1.close();
  port2.close();
});

test("a channel takes one port, once", () => {
  const { port1, port2 } = new MessageChannel();
  const channel = new Channel();
  channel.attach(port1);
  assert.throws(() => channel.attach(port2));
  port1.close();
  port2.close();
});
