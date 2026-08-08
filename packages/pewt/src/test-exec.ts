// `exec` — a program, its output, and an exit code.
//
// The primitive an agent went without (#210): it wanted one fact from git,
// had only a keyboard, and wrote a marker protocol over a pty to get it.
// These cover what makes this not-a-shell: argv reaches the OS unsplit, no
// rc file runs, stderr stays apart from stdout, and the exit code is the
// answer rather than something to parse out of a stream.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HostServer } from "@fsio/host";
import { describeGrant } from "pewter";
import { spawnGate, type Asker } from "./ask.js";
import { execKind, planExec, ExecError } from "./exec.js";
import { pewtKind } from "./kind.js";
import { NodeDirectory } from "./node-fs.js";
import { pewterAt, type Pewter } from "./pewter.js";
import { Router } from "./router.js";
import { runOnHost } from "./stream.js";

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const answers = (a: string): Asker => ({ ask: async () => a });

interface Ctx {
  p: Pewter;
  exec: (spec: Record<string, unknown>) => Promise<{ exitCode: number | null; out: string[]; err: string[] }>;
}

async function withHost(opts: { asker?: Asker; allowExec?: boolean }, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pewt-exec-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "p", pewter: {} }));
  fs.mkdirSync(path.join(root, "repos", "site"), { recursive: true });
  const p = pewterAt(root)!;
  const host = new HostServer({
    root,
    logger: silent,
    pty: false,
    timings: { heartbeatMs: 100, safetyPollMs: 25 },
    onSpawnRequest: spawnGate(p, { asker: opts.asker ?? answers("y"), ...(opts.allowExec ? { allowExec: true } : {}) }, silent),
  });
  host.registerKind("pewt", pewtKind(p, new Router(), silent));
  host.registerKind("exec", execKind(p, silent));
  await host.start();
  try {
    await fn({
      p,
      exec: async (spec) => {
        const out: string[] = [];
        const err: string[] = [];
        const outcome = await runOnHost(new NodeDirectory(root), "exec", spec, {
          pollMs: 5,
          onLine: (line, stream) => (stream === "out" ? out : err).push(line),
        });
        return { exitCode: outcome.exitCode, out, err };
      },
    });
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("a program runs and what it printed comes back", async () => {
  await withHost({}, async ({ exec }) => {
    const { exitCode, out } = await exec({ cmd: "echo", args: ["hello", "from", "exec"] });
    assert.equal(exitCode, 0);
    assert.deepEqual(out, ["hello from exec"]);
  });
});

test("argv reaches the program unsplit — there is no shell to re-parse it", async () => {
  // The whole argument for argv over a command string. Every one of these
  // would need quoting through a shell, and two of them would not survive it.
  await withHost({}, async ({ exec }) => {
    const awkward = ["a b", "$HOME", "*", "'", '"', "a;b", "a|b", "$(whoami)"];
    const { out } = await exec({ cmd: "printf", args: ["%s\n", ...awkward] });
    assert.deepEqual(out, awkward, "each argument arrives as itself");
  });
});

test("stderr stays apart from stdout, and the exit code is the answer", async () => {
  await withHost({}, async ({ exec }) => {
    const { exitCode, out, err } = await exec({
      cmd: "sh",
      args: ["-c", "echo to-out; echo to-err >&2; exit 3"],
    });
    assert.equal(exitCode, 3);
    assert.deepEqual(out, ["to-out"]);
    assert.deepEqual(err, ["to-err"]);
  });
});

test("--repo runs it in that project", async () => {
  await withHost({}, async ({ p, exec }) => {
    const { out } = await exec({ cmd: "pwd", args: [], repo: "site" });
    assert.equal(out[0], fs.realpathSync(path.join(p.root, "repos", "site")));
  });
});

test("a program this machine does not have says so, rather than hanging", async () => {
  await withHost({}, async ({ exec }) => {
    const { exitCode, err } = await exec({ cmd: "definitely-not-a-program-here", args: [] });
    assert.equal(exitCode, 127);
    assert.match(err.join("\n"), /is not on this machine's PATH/);
  });
});

test("nothing is on its stdin, so a program that would prompt ends instead", async () => {
  // A pty gives a child a terminal to ask at, and an extension driving one
  // has to remember to turn every prompt off. There is nothing to turn off
  // here: `read` gets EOF immediately.
  await withHost({}, async ({ exec }) => {
    const { exitCode } = await exec({ cmd: "sh", args: ["-c", "read line; echo got:$line"] });
    assert.notEqual(exitCode, null);
  });
});

test("a path is not a program name", async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pewt-exec-plan-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "p", pewter: {} }));
  const p = pewterAt(root)!;
  // The page is never trusted with a path (spec/PROTOCOL.md, threat model),
  // and a program named with a separator in it is naming one.
  for (const cmd of ["../../bin/sh", "/bin/sh", "./x", "a/b"]) {
    assert.throws(() => planExec(p, { cmd }), (e: unknown) => e instanceof ExecError && e.code === "bad_program", cmd);
  }
  // And arguments have to be strings, because they go to the OS as they are.
  assert.throws(() => planExec(p, { cmd: "echo", args: [1, 2] }), (e: unknown) => e instanceof ExecError);
  fs.rmSync(root, { recursive: true, force: true });
});

test("`always` remembers the program and the project, not everything", async () => {
  // What an argv buys over a shell: the thing allowed has a name, so the
  // grant can say it and a person can read it back.
  const asked: string[] = [];
  const asker: Asker = { ask: async (q) => (asked.push(q), "a") };
  await withHost({ asker }, async ({ p, exec }) => {
    await exec({ cmd: "echo", args: ["one"], repo: "site" });
    assert.equal(asked.length, 1);
    const grants = JSON.parse(fs.readFileSync(p.grants, "utf8")) as { grants: { kind: "exec"; cmd?: string; repo?: string }[] };
    assert.deepEqual(grants.grants.map((g) => [g.kind, g.cmd, g.repo]), [["exec", "echo", "site"]]);
    assert.equal(describeGrant(grants.grants[0]!), "echo in site");

    // The same program in the same project is remembered.
    await exec({ cmd: "echo", args: ["two"], repo: "site" });
    assert.equal(asked.length, 1, "the second echo in site must not ask");

    // A different program is a different question, which is the point of
    // naming it — a grant on `echo` is not a grant on anything else.
    await exec({ cmd: "true", args: [], repo: "site" });
    assert.equal(asked.length, 2, "a different program must ask");

    // And so is the same program somewhere else.
    await exec({ cmd: "echo", args: ["three"] });
    assert.equal(asked.length, 3, "the same program in another place must ask");
  });
});

test("--allow-exec answers yes without a terminal, and does not cover a shell", async () => {
  await withHost({ asker: { ask: null }, allowExec: true }, async ({ exec }) => {
    const { exitCode, out } = await exec({ cmd: "echo", args: ["unattended"] });
    assert.equal(exitCode, 0);
    assert.deepEqual(out, ["unattended"]);
  });
});
