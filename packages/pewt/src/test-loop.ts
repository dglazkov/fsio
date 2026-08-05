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
import { HostServer } from "@fsio/host";
import { call, CallError } from "./call.js";
import { pewtKind } from "./kind.js";
import { NodeDirectory } from "./node-fs.js";
import { pewterAt, type Pewter } from "./pewter.js";

const silent = { info: () => {}, warn: () => {}, error: () => {} };

/** A pewter with a host running on it, torn down afterwards. Temp is fine:
 *  F9 is Chrome's file observer, and nothing here opens a browser. */
async function withHost(fn: (ctx: { p: Pewter; host: HostServer; call: (m: string, params?: unknown) => Promise<unknown> }) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pewt-loop-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "p", pewter: {} }));
  const p = pewterAt(root)!;
  const host = new HostServer({ root, logger: silent, pty: false, timings: { heartbeatMs: 100, safetyPollMs: 25 } });
  host.registerKind("pewt", pewtKind(p, silent));
  await host.start();
  try {
    await fn({
      p,
      host,
      call: (method, params) => call(new NodeDirectory(root), method, params ?? {}, { timeoutMs: 5000, pollMs: 5 }),
    });
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
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
