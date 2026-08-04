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
import { fromBase64 } from "./bytes.js";
import { flingOp, FlingError } from "./fling.js";
import { actuatorKinds } from "./kinds.js";
import { asOperation, decodeDownstream, encode, receipt, refusal } from "./messages.js";
import { apply, AppError, initialState, safeRelPath, type AppState, type Operation } from "./model.js";
import { NodeDirectory } from "./node-fs.js";
import { Router } from "./router.js";

const silent = { info: () => {}, warn: () => {}, error: () => {} };

/** The page, as the test plays it: hold state, apply what arrives, answer.
 *
 *  It plays the two things the real page does that the reducer cannot: it
 *  reads a file out of the granted folder before opening a tab on it
 *  (web/run.ts), and it stores a flung file's bytes under the id the
 *  reducer minted (web/db.ts). Without those, "the page reads it" and "the
 *  bytes arrived" would both be assertions about nothing. */
class FakePage {
  state: AppState = initialState();
  session!: FsioSession;
  applied: string[] = [];
  displaced = false;
  /** what the page has custody of, playing IndexedDB's blob store. */
  blobs = new Map<string, Uint8Array>();

  constructor(private readonly root: string) {}

  /** The page's own read, through its folder grant — not the CLI's. */
  #readLocal(rel: string): Buffer {
    const safe = safeRelPath(rel);
    if (!safe) throw new AppError("bad_path", `${rel} is not inside the granted folder`);
    try {
      return fs.readFileSync(path.join(this.root, ...safe.split("/")));
    } catch {
      throw new AppError("file_not_found", `no file at ${JSON.stringify(rel)} in the granted folder`);
    }
  }

  /** The half of applying an operation that is not the reducer's. */
  #sideEffects(op: Operation, result: Record<string, unknown>): void {
    if (op.method === "files.fling") {
      this.blobs.set(String(result["fileId"]), fromBase64(op.params.data));
      const superseded = result["superseded"];
      if (typeof superseded === "string") this.blobs.delete(superseded);
    }
    if (op.method === "files.drop") this.blobs.delete(op.params.id);
  }

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
        // A tab onto a file the page cannot see would be a window onto
        // nothing, so the read happens before the reducer, and its failure
        // is the page's refusal.
        if (op.method === "files.open") this.#readLocal(op.params.path);
        const next = apply(this.state, op);
        this.#sideEffects(op, next.result);
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
    assert.deepEqual(page.state.tabs.at(-1)!.body, { kind: "message", message: "CI passed" });

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

test("open sends a path; the page is what reads the file", async () => {
  await withRig(async (rig) => {
    const page = new FakePage(rig.root);
    await page.open();
    fs.mkdirSync(path.join(rig.root, "notes"));
    fs.writeFileSync(path.join(rig.root, "notes", "plan.md"), "# ship it\n");

    const opened = await rig.run({ method: "files.open", params: { path: "notes/plan.md" } });
    assert.ok(opened.ok);
    const tab = page.state.tabs.at(-1)!;
    assert.deepEqual(tab.body, { kind: "local", path: "notes/plan.md" }, "the tab holds a path, not the file");
    assert.equal(page.blobs.size, 0, "and the page took no copy");

    // The command that travelled carried no bytes either — which is the
    // difference from a fling, stated as a size.
    const missing = await rig.run({ method: "files.open", params: { path: "notes/nope.md" } });
    assert.equal(missing.ok, false);
    if (missing.ok) return;
    assert.equal(missing.error.kind, "app");
    assert.equal(missing.error.code, "file_not_found");
    await page.close();
  });
});

test("fling carries the bytes across, and the page ends up holding them", async () => {
  await withRig(async (rig) => {
    const page = new FakePage(rig.root);
    await page.open();

    // Deliberately outside the granted folder: the page could never have
    // read this one, which is the whole reason fling exists.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "fsio-fling-"));
    const source = path.join(outside, "graph.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    fs.writeFileSync(source, bytes);

    try {
      const flung = await rig.run(await flingOp(source));
      assert.ok(flung.ok);
      if (!flung.ok) return;
      const fileId = String(flung.result["fileId"]);
      assert.equal(flung.result["type"], "image/png", "typed from the name, by the side holding the file");
      assert.deepEqual([...page.blobs.get(fileId)!], [...bytes], "the bytes arrived intact");
      assert.deepEqual(page.state.tabs.at(-1)!.body, { kind: "held", fileId });
      assert.equal(page.state.held.at(-1)!.from, source, "and it remembers where it came from");

      // Fling it again after an edit: one copy per source, and the tab
      // showing it follows the new one.
      fs.writeFileSync(source, Buffer.concat([bytes, Buffer.from([9])]));
      const again = await rig.run(await flingOp(source));
      assert.ok(again.ok);
      if (!again.ok) return;
      assert.equal(again.result["superseded"], fileId);
      assert.equal(page.state.held.length, 1);
      assert.equal(page.blobs.size, 1, "the superseded copy was let go");
      assert.equal(page.blobs.get(String(again.result["fileId"]))!.length, bytes.length + 1);

      // And the page can let go of it entirely, closing the tab with it.
      const dropped = await rig.run({ method: "files.drop", params: { id: String(again.result["fileId"]) } });
      assert.ok(dropped.ok);
      assert.equal(page.blobs.size, 0);
      assert.deepEqual(page.state.held, []);
      assert.equal(page.state.tabs.some((t) => t.body.kind === "held"), false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
    await page.close();
  });
});

test("a file the terminal cannot read never becomes a command", async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "fsio-fling-"));
  try {
    await assert.rejects(flingOp(path.join(outside, "nope.bin")), (e: unknown) => {
      assert.ok(e instanceof FlingError);
      assert.equal(e.reason, "missing");
      return true;
    });
    await assert.rejects(flingOp(outside), (e: unknown) => {
      assert.equal((e as FlingError).reason, "directory");
      return true;
    });
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
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
