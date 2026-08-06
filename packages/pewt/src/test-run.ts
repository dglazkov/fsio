// A run, end to end, without a browser.
//
// Real HostServer, real spawn policy, real child process, real FsioClient over
// real files — `runOnHost()` is the same function `pewt run` calls. What is
// left for the cooperative loop (TESTING.md) is the shell's half: the message
// channel and the events an extension's `onOutput` sees.
//
// Every test here spawns npm, so they are slower than the rest of the suite
// and there are deliberately few of them: one per claim NARRATIVE.md makes
// about running things.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HostServer } from "@fsio/host";
import { spawnGate, type Asker } from "./ask.js";
import { CallError } from "./call.js";
import { pewtKind } from "./kind.js";
import { Router } from "./router.js";
import { NodeDirectory } from "./node-fs.js";
import { pewterAt, type Pewter } from "./pewter.js";
import { planRun, RunError, runKind } from "./run.js";
import { runOnHost, type RunOutcome } from "./stream.js";

const silent = { info: () => {}, warn: () => {}, error: () => {} };

/** An asker that answers without a terminal. `null` is the shape of a host
 *  that cannot ask at all — a rig, CI, a background task. */
const answers = (reply: string): Asker => ({ ask: async () => reply });
const cannotAsk: Asker = { ask: null };

interface Ctx {
  p: Pewter;
  run(spec: Record<string, unknown>): Promise<{ outcome: RunOutcome; out: string[]; err: string[] }>;
}

/** A pewter with scripts in it, a host on it, and one run away from a child
 *  process. Temp is fine: F9 is Chrome's file observer, and nothing here
 *  opens a browser. */
async function withHost(
  opts: { scripts?: Record<string, string>; asker?: Asker; allowRuns?: boolean },
  fn: (ctx: Ctx) => Promise<void>
): Promise<void> {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pewt-run-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "p", pewter: {}, scripts: opts.scripts ?? {} }));
  const p = pewterAt(root)!;
  const host = new HostServer({
    root,
    logger: silent,
    pty: false,
    timings: { heartbeatMs: 100, safetyPollMs: 25 },
    onSpawnRequest: spawnGate(p, { asker: opts.asker ?? answers("y"), ...(opts.allowRuns ? { allowRuns: true } : {}) }, silent),
  });
  host.registerKind("pewt", pewtKind(p, new Router(), silent));
  host.registerKind("run", runKind(p, silent));
  await host.start();
  try {
    await fn({
      p,
      run: async (spec) => {
        const out: string[] = [];
        const err: string[] = [];
        const outcome = await runOnHost(new NodeDirectory(root), "run", spec, {
          pollMs: 5,
          onLine: (line, stream) => (stream === "out" ? out : err).push(line),
        });
        return { outcome, out, err };
      },
    });
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("a script the project declares runs, and its output arrives in order", async () => {
  await withHost({ scripts: { greet: "node -e \"console.log('one'); console.log('two')\"" } }, async ({ run }) => {
    const { outcome, out } = await run({ script: "greet" });
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.ended, "exit");
    // npm writes its own banner lines to stderr, so stdout is the script's.
    assert.deepEqual(out.filter((l) => l === "one" || l === "two"), ["one", "two"]);
  });
});

test("the script's exit code is the run's exit code", async () => {
  await withHost({ scripts: { fail: "node -e \"process.exit(7)\"" } }, async ({ run }) => {
    const { outcome } = await run({ script: "fail" });
    assert.equal(outcome.exitCode, 7);
  });
});

test("the two streams stay two streams", async () => {
  await withHost({ scripts: { both: "node -e \"console.log('to stdout'); console.error('to stderr')\"" } }, async ({ run }) => {
    const { out, err } = await run({ script: "both" });
    assert.ok(out.includes("to stdout"), `stdout was ${JSON.stringify(out)}`);
    assert.ok(err.includes("to stderr"), `stderr was ${JSON.stringify(err)}`);
  });
});

test("a run in a project runs in that project, with pewt on its PATH", async () => {
  await withHost({}, async ({ p, run }) => {
    // The project is an ordinary npm project that knows nothing about Pewter
    // — NARRATIVE.md's claim that a repo with a `build` script works here and
    // works for somebody who has never heard of this.
    const site = path.join(p.repos, "site");
    fs.mkdirSync(site, { recursive: true });
    fs.writeFileSync(
      path.join(site, "package.json"),
      JSON.stringify({ name: "site", scripts: { where: 'node -e "console.log(process.cwd()); console.log(process.env.PATH)"' } })
    );

    const { outcome, out } = await run({ script: "where", repo: "site" });
    assert.equal(outcome.exitCode, 0);
    // npm's own banner and blank lines are on this stream too — it is the
    // child's stdout verbatim, which is the point.
    const said = out.filter((l) => l.startsWith("/"));
    assert.equal(said[0], fs.realpathSync(site));
    // `pewt` lives in the pewter's own node_modules/.bin, so a script that
    // calls back in finds it, and finds this pewter by walking up from its
    // cwd. npm puts the project's own .bin first; both are there.
    assert.ok(said[1]?.split(path.delimiter).includes(path.join(p.root, "node_modules", ".bin")), `PATH was ${said[1]}`);
  });
});

test("a script the project does not declare never starts", async () => {
  await withHost({ scripts: { build: "node -e 0" } }, async ({ run }) => {
    await assert.rejects(
      () => run({ script: "deploy" }),
      (e: unknown) => e instanceof CallError && e.reason === "refused" && /declares no script/.test(e.message) && /it declares: build/.test(e.message)
    );
  });
});

test("a project name that could climb out of repos/ is refused", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pewt-plan-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "p", pewter: {}, scripts: { build: "true" } }));
  const p = pewterAt(root)!;
  for (const repo of ["../..", "a/b", ".hidden", ""]) {
    assert.throws(() => planRun(p, { script: "build", repo }), (e: unknown) => e instanceof RunError && /not a project name|no project named/.test(e.message));
  }
  assert.throws(() => planRun(p, { script: "build", repo: "nope" }), (e: unknown) => e instanceof RunError && e.code === "no_repo");
  fs.rmSync(root, { recursive: true, force: true });
});

test("no at the host's terminal is no, and it says so", async () => {
  await withHost({ scripts: { build: "node -e 0" }, asker: answers("n") }, async ({ run }) => {
    await assert.rejects(
      () => run({ script: "build" }),
      (e: unknown) => e instanceof CallError && e.reason === "refused" && /denied at the host's terminal/.test(e.message)
    );
  });
});

test("a host with no terminal to ask in denies, and names the flag", async () => {
  await withHost({ scripts: { build: "node -e 0" }, asker: cannotAsk }, async ({ run }) => {
    await assert.rejects(
      () => run({ script: "build" }),
      (e: unknown) => e instanceof CallError && e.reason === "refused" && /--allow-runs/.test(e.message)
    );
  });
});

test("--allow-runs answers yes without a terminal", async () => {
  await withHost({ scripts: { build: "node -e \"console.log('built')\"" }, asker: cannotAsk, allowRuns: true }, async ({ run }) => {
    const { outcome, out } = await run({ script: "build" });
    assert.equal(outcome.exitCode, 0);
    assert.ok(out.includes("built"));
  });
});

test("output written just before the child dies still arrives", async () => {
  // The race the in-band `end` frame exists to remove: status.json and
  // out.log are separate files with no ordering between them, so a client
  // that finished on the status could return before this line.
  await withHost({ scripts: { last: "node -e \"console.log('the last line'); process.exit(3)\"" } }, async ({ run }) => {
    const { outcome, out } = await run({ script: "last" });
    assert.equal(outcome.exitCode, 3);
    assert.ok(out.includes("the last line"), `stdout was ${JSON.stringify(out)}`);
  });
});
