// The whole channel, end to end, without a browser.
//
// Real HostServer, real kinds, real FsioClient on both ends, real files in
// a real folder — the only stand-in is the page, which is here a few lines
// of Node doing what web/session.ts does in Chrome. That makes the
// interesting half of this demo testable per push: what is left for the
// cooperative loop (TESTING.md) is the page's own behavior, not the
// transport it rides.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FsioClient, type FsioSession } from "@fsio/client";
import { HostServer } from "@fsio/host";
import { actuate, CliError } from "./actuate.js";
import { actuatorKinds } from "./kinds.js";
import { asOperation, decodeDownstream, encode, receipt, refusal } from "./messages.js";
import { apply, AppError, initialState, type AppState, type Operation } from "./model.js";
import { NodeDirectory } from "./node-fs.js";
import { Router } from "./router.js";

const silent = { info: () => {}, warn: () => {}, error: () => {} };

/** The page, as the test plays it: hold state, apply what arrives, answer. */
class FakePage {
  state: AppState = initialState();
  session!: FsioSession;
  applied: string[] = [];
  displaced = false;

  constructor(private readonly root: string) {}

  async open(): Promise<void> {
    const client = new FsioClient(new NodeDirectory(this.root));
    await client.connect();
    const s = client.createSession({ kind: "actuator", client: "fake-page" }, { pollMs: 5 });
    this.session = s;
    s.on("data", (bytes) => {
      const msg = decodeDownstream(bytes);
      if (!msg) return;
      if (msg.type === "displaced") {
        this.displaced = true;
        return;
      }
      const op = asOperation(msg);
      if (!op) return void s.sendData(encode(refusal(msg.id, { code: "bad_command", message: "unsupported" })));
      try {
        const next = apply(this.state, op);
        this.state = next.state;
        this.applied.push(op.method);
        s.sendData(encode(receipt(msg.id, next.result)));
      } catch (e) {
        const err = e as AppError;
        s.sendData(encode(refusal(msg.id, { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) })));
      }
    });
    await s.ready;
  }

  async close(): Promise<void> {
    await this.session.close();
  }
}

interface Rig {
  root: string;
  host: HostServer;
  router: Router;
  run: (op: Operation) => ReturnType<typeof actuate>;
}

async function withRig(fn: (rig: Rig) => Promise<void>, opts: { start?: boolean } = {}): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsio-actuator-"));
  const router = new Router();
  const kinds = actuatorKinds(router, silent);
  const host = new HostServer({ root, logger: silent, timings: { heartbeatMs: 100, safetyPollMs: 25 } });
  host.registerKind("actuator", kinds.actuator);
  host.registerKind("actuate", kinds.actuate);
  if (opts.start !== false) await host.start();
  try {
    await fn({
      root,
      host,
      router,
      run: (op) => actuate(new NodeDirectory(root), op, { timeoutMs: 5000, pollMs: 5 }),
    });
  } finally {
    router.close();
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("no helper in the folder: the CLI says so before writing anything", async () => {
  await withRig(
    async (rig) => {
      await assert.rejects(rig.run({ method: "tabs.list", params: {} }), (e: unknown) => {
        assert.ok(e instanceof CliError);
        assert.equal(e.reason, "no_helper");
        return true;
      });
    },
    { start: false }
  );
});

test("helper but no page: the session opens, says nobody is home, and the CLI names the missing half", async () => {
  await withRig(async (rig) => {
    await assert.rejects(rig.run({ method: "tabs.list", params: {} }), (e: unknown) => {
      assert.ok(e instanceof CliError);
      assert.equal(e.reason, "no_page");
      assert.match(e.hint ?? "", /open the actuator page/);
      return true;
    });
  });
});

test("a command travels CLI → folder → page, and its result comes back", async () => {
  await withRig(async (rig) => {
    const page = new FakePage(rig.root);
    await page.open();

    const added = await rig.run({ method: "tabs.add", params: { title: "Build", message: "CI is running" } });
    assert.equal(added.ok, true);
    assert.ok(added.ok && typeof added.result["id"] === "string");
    const id = added.ok ? String(added.result["id"]) : "";

    // The page applied it — and the page is where the state lives.
    assert.equal(page.state.tabs.length, 2);
    assert.equal(page.state.activeId, id);
    assert.equal(page.state.tabs.at(-1)!.title, "Build");

    const listed = await rig.run({ method: "tabs.list", params: {} });
    assert.ok(listed.ok);
    assert.deepEqual(listed.ok ? (listed.result["tabs"] as { id: string }[]).map((t) => t.id) : [], ["welcome", id]);

    const updated = await rig.run({ method: "tabs.update", params: { id, message: "CI passed" } });
    assert.ok(updated.ok);
    assert.equal(page.state.tabs.at(-1)!.message, "CI passed");

    const activated = await rig.run({ method: "tabs.activate", params: { id: "welcome" } });
    assert.ok(activated.ok);
    assert.equal(page.state.activeId, "welcome");

    const removed = await rig.run({ method: "tabs.remove", params: { id } });
    assert.ok(removed.ok);
    assert.deepEqual(page.state.tabs.map((t) => t.id), ["welcome"]);

    assert.deepEqual(page.applied, ["tabs.add", "tabs.list", "tabs.update", "tabs.activate", "tabs.remove"]);
    await page.close();
  });
});

test("the page's refusal comes back as an app error, distinct from a channel one", async () => {
  await withRig(async (rig) => {
    const page = new FakePage(rig.root);
    await page.open();
    const answer = await rig.run({ method: "tabs.remove", params: { id: "nope" } });
    assert.equal(answer.ok, false);
    if (answer.ok) return;
    assert.equal(answer.error.kind, "app");
    assert.equal(answer.error.code, "tab_not_found");
    assert.match(answer.error.hint ?? "", /actuator tabs list/);
    await page.close();
  });
});

test("the page closing puts the folder back to nobody-home", async () => {
  await withRig(async (rig) => {
    const page = new FakePage(rig.root);
    await page.open();
    assert.ok((await rig.run({ method: "tabs.list", params: {} })).ok);

    await page.close();
    // The host's close handling is what detaches the page; give it a beat.
    for (let i = 0; i < 100 && rig.router.attached; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(rig.router.attached, false);

    await assert.rejects(rig.run({ method: "tabs.list", params: {} }), (e: unknown) => {
      assert.equal((e as CliError).reason, "no_page");
      return true;
    });
  });
});

test("a second page takes over, and the first is told", async () => {
  await withRig(async (rig) => {
    const first = new FakePage(rig.root);
    await first.open();
    const second = new FakePage(rig.root);
    await second.open();

    for (let i = 0; i < 100 && !first.displaced; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(first.displaced, true, "the displaced page was told");

    const added = await rig.run({ method: "tabs.add", params: { title: "Second", message: "x" } });
    assert.ok(added.ok);
    assert.equal(second.state.tabs.length, 2, "the newest page is the one being driven");
    assert.equal(first.state.tabs.length, 1, "the displaced page was left alone");
    await first.close();
    await second.close();
  });
});
