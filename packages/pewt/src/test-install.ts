// An install, end to end, without a browser and without a network.
//
// Real HostServer, real spawn gate, real `npm install` — against a manifest
// whose one dependency is a `file:` path inside the fixture, so nothing
// reaches a registry. The claims pinned are #193's: install IS asked, the
// refusal names `--allow-runs`, and a standing `run/<project>` grant —
// the run rung — answers the install question too.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HostServer } from "@fsio/host";
import { spawnGate, type Asker } from "./ask.js";
import { recordGrant } from "./grants.js";
import { installKind, planInstall, InstallError } from "./install.js";
import { NodeDirectory } from "./node-fs.js";
import { pewterAt, type Pewter } from "./pewter.js";
import { projectAt } from "./repos.js";
import { runOnHost, type RunOutcome } from "./stream.js";

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const answers = (reply: string): Asker => ({ ask: async () => reply });
const cannotAsk: Asker = { ask: null };

function pewter(): Pewter {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pewt-install-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "p", pewter: {} }));
  return pewterAt(root)!;
}

/** A project whose install needs no network: one `file:` dependency on a
 *  package sitting beside it in the fixture. */
function projectNeedingInstall(p: Pewter, name: string): string {
  const thing = path.join(p.root, "local-thing");
  fs.mkdirSync(thing, { recursive: true });
  fs.writeFileSync(path.join(thing, "package.json"), JSON.stringify({ name: "local-thing", version: "1.0.0" }));
  const dir = path.join(p.repos, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, dependencies: { "local-thing": "file:../../local-thing" } }));
  return dir;
}

async function withHost(opts: { asker: Asker }, fn: (ctx: { p: Pewter; install(name: string): Promise<RunOutcome> }) => Promise<void>): Promise<void> {
  const p = pewter();
  const host = new HostServer({
    root: p.root,
    logger: silent,
    pty: false,
    timings: { heartbeatMs: 100, safetyPollMs: 25 },
    onSpawnRequest: spawnGate(p, { asker: opts.asker }, silent),
  });
  host.registerKind("repos.install", installKind(p, silent));
  await host.start();
  try {
    await fn({
      p,
      install: async (name) => runOnHost(new NodeDirectory(p.root), "repos.install", { name }, { pollMs: 5 }),
    });
  } finally {
    await host.close();
    fs.rmSync(p.root, { recursive: true, force: true });
  }
}

test("a project with no manifest has nothing to install, said before any question", () => {
  const p = pewter();
  fs.mkdirSync(path.join(p.repos, "bare"), { recursive: true });
  assert.throws(() => planInstall(p, { name: "bare" }), (e: unknown) => e instanceof InstallError && e.code === "no_manifest");
  assert.throws(() => planInstall(p, { name: "ghost" }), (e: unknown) => e instanceof InstallError && e.code === "no_repo");
});

test("an install is asked about, and yes runs npm to completion", async () => {
  await withHost({ asker: answers("y") }, async ({ p, install }) => {
    const dir = projectNeedingInstall(p, "site");
    const outcome = await install("site");
    assert.equal(outcome.exitCode, 0);
    assert.ok(fs.existsSync(path.join(dir, "node_modules", "local-thing")), "the dependency landed");
    assert.equal((await projectAt(p, "site")).installed, true, "the row's fact flipped");
  });
});

test("a host that cannot ask refuses an install, naming the run flag — the rung", async () => {
  await withHost({ asker: cannotAsk }, async ({ p, install }) => {
    projectNeedingInstall(p, "site");
    await assert.rejects(install("site"), (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      return msg.includes("--allow-runs");
    });
    assert.equal((await projectAt(p, "site")).installed, false, "nothing ran");
  });
});

test("a standing run/<project> grant answers the install question too (#193)", async () => {
  await withHost({ asker: cannotAsk }, async ({ p, install }) => {
    projectNeedingInstall(p, "site");
    // The grant a human records by answering `a` to a *run* question — and
    // the decision under test is that it covers this install, on a host
    // that cannot ask at all.
    recordGrant(p, { kind: "run", repo: "site" });
    const outcome = await install("site");
    assert.equal(outcome.exitCode, 0);
    assert.equal((await projectAt(p, "site")).installed, true);
  });
});
