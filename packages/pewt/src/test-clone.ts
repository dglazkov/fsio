// A clone, end to end, without a browser and without a network.
//
// Real HostServer, real spawn policy, real git, real FsioClient over real
// files — `runOnHost(…, "repos.clone", …)` is the same function `pewt repos
// clone` calls. The repository being cloned is a fixture made here, so no
// test reaches the network: what a url has to be is "something git can
// fetch", and a local path is one.
//
// The claims pinned are #189's: the name is derived from the url, a
// collision is refused before anything spawns, **nothing asks** — the host
// in these tests has no asker at all — and a dead clone leaves no half-repo.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HostServer } from "@fsio/host";
import { spawnGate, type Asker } from "./ask.js";
import { deriveName, planClone, CloneError, cloneKind } from "./clone.js";
import { NodeDirectory } from "./node-fs.js";
import { pewterAt, type Pewter } from "./pewter.js";
import { runOnHost, type RunOutcome } from "./stream.js";

const silent = { info: () => {}, warn: () => {}, error: () => {} };

/** The shape of a host nobody can ask: a rig, CI, a background task. A clone
 *  succeeding under it is the no-question decision, pinned. */
const cannotAsk: Asker = { ask: null };

function pewter(): Pewter {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pewt-clone-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "p", pewter: {} }));
  return pewterAt(root)!;
}

/** A repository worth cloning: one commit, one file. */
function fixtureRepo(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pewt-clone-src-"));
  const git = (...args: string[]): void => void execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "--quiet");
  fs.writeFileSync(path.join(dir, "README.md"), "cloned\n");
  git("add", "README.md");
  git("-c", "user.name=pewt-test", "-c", "user.email=pewt@test", "commit", "--quiet", "-m", "one");
  return dir;
}

async function withHost(fn: (ctx: { p: Pewter; clone(spec: Record<string, unknown>): Promise<{ outcome: RunOutcome; err: string[] }> }) => Promise<void>): Promise<void> {
  const p = pewter();
  const host = new HostServer({
    root: p.root,
    logger: silent,
    pty: false,
    timings: { heartbeatMs: 100, safetyPollMs: 25 },
    onSpawnRequest: spawnGate(p, { asker: cannotAsk }, silent),
  });
  host.registerKind("repos.clone", cloneKind(p, silent));
  await host.start();
  try {
    await fn({
      p,
      clone: async (spec) => {
        const err: string[] = [];
        const outcome = await runOnHost(new NodeDirectory(p.root), "repos.clone", spec, {
          pollMs: 5,
          onLine: (line, stream) => {
            if (stream === "err") err.push(line);
          },
        });
        return { outcome, err };
      },
    });
  } finally {
    await host.close();
    fs.rmSync(p.root, { recursive: true, force: true });
  }
}

// ---- the plan: everything refused before anything spawns

test("the project name a url implies, in git's three spellings", () => {
  assert.equal(deriveName("https://github.com/dglazkov/fsio.git"), "fsio");
  assert.equal(deriveName("https://github.com/dglazkov/fsio"), "fsio");
  assert.equal(deriveName("git@github.com:dglazkov/fsio.git"), "fsio");
  assert.equal(deriveName("/somewhere/on/disk/atlas"), "atlas");
  assert.equal(deriveName("https://github.com/dglazkov/fsio/"), "fsio");
  // Nothing nameable at the end: the caller is told to name it.
  assert.equal(deriveName("https://example.com/"), null);
  assert.equal(deriveName(""), null);
});

test("a url with whitespace is a quoting accident, refused in our words not git's", () => {
  const p = pewter();
  assert.throws(() => planClone(p, { url: "https://x.test/a b" }), (e: unknown) => e instanceof CloneError && e.code === "bad_url");
  assert.throws(() => planClone(p, { url: "" }), (e: unknown) => e instanceof CloneError && e.code === "bad_url");
});

test("a collision is refused by name, before anything is spawned", () => {
  const p = pewter();
  fs.mkdirSync(path.join(p.repos, "fsio"), { recursive: true });
  assert.throws(
    () => planClone(p, { url: "https://github.com/dglazkov/fsio.git" }),
    (e: unknown) => e instanceof CloneError && e.code === "exists"
  );
  // The same url under a different name is a different plan, and fine.
  assert.equal(planClone(p, { url: "https://github.com/dglazkov/fsio.git", name: "fsio2" }).name, "fsio2");
});

// ---- the session: real git, no asker, no network

test("a clone lands in repos/, named by its url, with nobody asked", async () => {
  const src = fixtureRepo();
  try {
    await withHost(async ({ p, clone }) => {
      const { outcome, err } = await clone({ url: src });
      assert.equal(outcome.exitCode, 0);
      const name = path.basename(src);
      assert.equal(fs.readFileSync(path.join(p.repos, name, "README.md"), "utf8"), "cloned\n");
      // git narrates on stderr; a caller watching progress saw something.
      assert.ok(err.length > 0, "git said something while cloning");
    });
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test("a clone that fails leaves no half-repo in the list", async () => {
  await withHost(async ({ p, clone }) => {
    const gone = path.join(fs.realpathSync(os.tmpdir()), "pewt-no-such-repo");
    const { outcome, err } = await clone({ url: gone, name: "ghost" });
    assert.notEqual(outcome.exitCode, 0);
    assert.ok(!fs.existsSync(path.join(p.repos, "ghost")), "nothing left behind");
    assert.ok(err.some((line) => line.length > 0), "the failure arrived in git's own words");
  });
});

test("a second clone of the same url is refused as the spawn, with the collision named", async () => {
  const src = fixtureRepo();
  try {
    await withHost(async ({ clone }) => {
      const first = await clone({ url: src });
      assert.equal(first.outcome.exitCode, 0);
      await assert.rejects(clone({ url: src }), (e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        return msg.includes("already a project named");
      });
    });
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
  }
});
