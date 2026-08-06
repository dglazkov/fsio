// The whole path, end to end, without a browser.
//
// Real HostServer, real kind, real FsioClient over real files in a real
// folder — `call()` is the same function `pewt repos` runs. What is left for
// the cooperative loop (TESTING.md) is the shell's own behavior: the iframe,
// the message channel, and the grant. Everything below the page is here.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FsioClient } from "@fsio/client";
import { HostServer } from "@fsio/host";
import { applyTabs, asCommand, asTabCommand, encodeControl, noTabs, receipt, receiptError, TabError, type TabsState } from "pewter";
import { call, CallError } from "./call.js";
import { pewtKind } from "./kind.js";
import { NodeDirectory } from "./node-fs.js";
import { pewterAt, type Pewter } from "./pewter.js";
import { Router } from "./router.js";

const silent = { info: () => {}, warn: () => {}, error: () => {} };

interface Ctx {
  p: Pewter;
  host: HostServer;
  call: (m: string, params?: unknown) => Promise<unknown>;
  /** A page attaches to this folder and answers what only a page can. */
  page: () => Promise<FakePage>;
}

/** A pewter with a host running on it, torn down afterwards. Temp is fine:
 *  F9 is Chrome's file observer, and nothing here opens a browser. */
async function withHost(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pewt-loop-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "p", pewter: {} }));
  const p = pewterAt(root)!;
  const host = new HostServer({ root, logger: silent, pty: false, timings: { heartbeatMs: 100, safetyPollMs: 25 } });
  host.registerKind("pewt", pewtKind(p, new Router(), silent));
  await host.start();
  const pages: FakePage[] = [];
  try {
    await fn({
      p,
      host,
      call: (method, params) => call(new NodeDirectory(root), method, params ?? {}, { timeoutMs: 5000, pollMs: 5 }),
      page: async () => {
        const page = await attachPage(root);
        pages.push(page);
        return page;
      },
    });
  } finally {
    for (const page of pages) await page.close();
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

interface FakePage {
  close(): Promise<void>;
  /** what the page is holding, as the page sees it. */
  state(): TabsState;
}

/** A page, as the folder sees one.
 *
 *  Everything the shell does about commands and nothing it does about
 *  browsers: it opens the same session with the same `page: true`, decodes the
 *  same frames, applies the same shared function, and sends the same receipts.
 *  What is missing is the half a browser is needed for — building the
 *  extension, and the iframe — and that half is what `npm run pewter-rig`
 *  covers. Everything below the page is here. */
async function attachPage(root: string): Promise<FakePage> {
  const client = new FsioClient(new NodeDirectory(root));
  await client.connect();
  const session = client.createSession({ kind: "pewt", client: "fake-page", page: true }, { pollMs: 5 });
  let state = noTabs();
  let n = 0;
  session.on("data", (bytes) => {
    const command = asCommand(bytes);
    if (!command) return;
    try {
      const parsed = asTabCommand(command.method, command.params);
      if (!parsed) throw new TabError("bad_params", `${command.method} did not get the parameters it needs`);
      const applied = applyTabs(state, parsed, { makeId: () => `tab-${++n}` });
      state = applied.state;
      session.sendData(encodeControl(receipt(command.id, applied.result)));
    } catch (e) {
      const err = e as TabError;
      session.sendData(encodeControl(receiptError(command.id, { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) })));
    }
  });
  await session.ready;
  return { close: () => session.close().catch(() => {}), state: () => state };
}

test("repos.list travels the folder and comes back", async () => {
  await withHost(async ({ p, call }) => {
    fs.mkdirSync(path.join(p.repos, "site", ".git"), { recursive: true });
    fs.mkdirSync(path.join(p.repos, "atlas"), { recursive: true });
    assert.deepEqual(await call("repos.list"), {
      repos: [
        { name: "atlas", git: false },
        { name: "site", git: true },
      ],
    });
  });
});

test("ext.bundle builds through the session, and the bytes are in the folder", async () => {
  await withHost(async ({ p, call }) => {
    const dir = path.join(p.extensions, "repos");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), `<body><script type="module" src="./main.ts"></script></body>`);
    fs.writeFileSync(path.join(dir, "main.ts"), `document.title = "projects";\n`);

    const b = (await call("ext.bundle", { name: "repos" })) as { path: string; hash: string; rebuilt: boolean };
    assert.equal(b.rebuilt, true);
    // The shell reads this path through the grant it already holds, so the
    // answer has to be a path the *page* can walk: relative, forward slashes.
    assert.equal(b.path, ".pewter/build/repos.html");
    const html = fs.readFileSync(path.join(p.root, b.path), "utf8");
    assert.match(html, /projects/);
    assert.equal(b.hash.length, 12);
  });
});

test("an operation's refusal arrives as a refusal, with its own code and its hint", async () => {
  await withHost(async ({ call }) => {
    await assert.rejects(
      () => call("ext.bundle", { name: "nope" }),
      (e: unknown) => e instanceof CallError && e.reason === "refused" && e.code === "no_extension" && !!e.hint
    );
  });
});

test("bad parameters are refused by the host, not by the sender", async () => {
  await withHost(async ({ call }) => {
    await assert.rejects(
      () => call("ext.bundle", { name: 42 }),
      (e: unknown) => e instanceof CallError && e.reason === "refused" && e.code === "bad_params"
    );
  });
});

test("a method this host does not serve is not a crash", async () => {
  await withHost(async ({ call }) => {
    await assert.rejects(() => call("repos.create", { name: "x" }), (e: unknown) => e instanceof CallError);
  });
});

// ---- the operations the page answers
//
// The command goes down one session and comes back up another, and nothing in
// between knows what a tab is. These are the tests that the two-answerer path
// works at all; what a tab *means* is packages/pewter's test-tabs.ts.

test("a tab command typed in a terminal is answered by the page", async () => {
  await withHost(async ({ call, page }) => {
    const open = await page();
    const added = (await call("tabs.add", { name: "repos" })) as { id: string; name: string; active: boolean };
    assert.deepEqual(added, { id: "tab-1", name: "repos", title: "repos", active: true });
    // The page is where it landed — not the host, which never learns what the
    // answer meant.
    assert.deepEqual(open.state(), { tabs: [{ id: "tab-1", title: "repos", body: { kind: "extension", name: "repos" } }], activeId: "tab-1" });
    assert.deepEqual(await call("tabs.list"), open.state());
  });
});

test("the page's refusal keeps the page's own code and hint", async () => {
  await withHost(async ({ call, page }) => {
    await page();
    await assert.rejects(
      () => call("tabs.focus", { id: "tab-nope" }),
      (e: unknown) => e instanceof CallError && e.reason === "refused" && e.code === "tab_not_found" && /pewt tabs/.test(e.hint ?? "")
    );
  });
});

test("a page operation with no page open is exit 4, and says to open one", async () => {
  await withHost(async ({ call }) => {
    await assert.rejects(
      () => call("tabs.list"),
      (e: unknown) => e instanceof CallError && e.reason === "no_page" && e.code === "no_page" && /allow it/.test(e.hint ?? "")
    );
  });
});

test("a page that closes stops being the one commands go to", async () => {
  await withHost(async ({ call, page }) => {
    const open = await page();
    await call("tabs.add", { name: "repos" });
    await open.close();
    await assert.rejects(() => call("tabs.list"), (e: unknown) => e instanceof CallError && e.reason === "no_page");
  });
});

test("a client learns on connect whether anybody is there to answer for the page", async () => {
  await withHost(async ({ p, page }) => {
    // The fact rather than the failure: a spawn result can carry it (D13) and
    // a kind handler cannot raise a code of its own, so this is what a client
    // reads to say "no page" before it asks for anything.
    const client = new FsioClient(new NodeDirectory(p.root));
    await client.connect();
    const before = client.createSession({ kind: "pewt", client: "test" }, { pollMs: 5 });
    assert.equal((await before.ready)["page"], false);
    await before.close();

    await page();
    const after = client.createSession({ kind: "pewt", client: "test" }, { pollMs: 5 });
    assert.equal((await after.ready)["page"], true);
    await after.close();
  });
});

test("no host in the pewter is exit 3, and says what to start", async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pewt-nohost-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "p", pewter: {} }));
  await assert.rejects(
    () => call(new NodeDirectory(root), "repos.list", {}, { timeoutMs: 2000 }),
    (e: unknown) => e instanceof CallError && e.reason === "no_host" && /npm start/.test(e.hint ?? "")
  );
  // Probing must not leave the plumbing of a host that was never there.
  assert.equal(fs.existsSync(path.join(root, ".fsio")), false);
  fs.rmSync(root, { recursive: true, force: true });
});
