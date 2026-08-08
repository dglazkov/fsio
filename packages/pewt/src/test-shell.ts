// A shell, end to end, without a browser.
//
// Real HostServer, real node-pty, real spawn policy, real FsioClient over real
// files. `shellOnHost()` is the same function `pewt shell` calls and
// `attachTerminal()` is what wires a terminal to it, so what is tested is what
// ships. What is left for the cooperative loop (TESTING.md) is the page's
// half: the message channel, and an extension holding a live shell.
//
// Every test here spawns a shell, so there are deliberately few of them: one
// per claim NARRATIVE.md makes about opening a terminal.
//
// `/bin/sh` rather than `$SHELL`: a test that depends on which shell the
// machine running it prefers, and on that shell's startup files, measures the
// machine. The spec's `cmd` is what a client would leave out — and one test
// below leaves it out, because the default is a claim too.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { HostServer } from "@fsio/host";
import { shellSpec } from "pewter";
import { spawnGate, type Asker } from "./ask.js";
import { CallError } from "./call.js";
import { NodeDirectory } from "./node-fs.js";
import { pewterAt, type Pewter } from "./pewter.js";
import { shellOnHost, type ShellAttachment } from "./stream.js";
import { attachTerminal } from "./terminal.js";

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const answers = (reply: string): Asker => ({ ask: async () => reply });
const cannotAsk: Asker = { ask: null };

/** How long a test waits for a shell to say something. Generous: it is a
 *  process starting, a prompt being drawn, and two poll intervals. */
const PATIENCE_MS = 10_000;

interface Ctx {
  p: Pewter;
  /** open a shell and collect everything it prints. */
  open(spec: Record<string, unknown>): Promise<{ shell: ShellAttachment; said: () => string }>;
  dir: NodeDirectory;
}

async function withHost(
  opts: { asker?: Asker; allowRuns?: boolean; allowShells?: boolean },
  fn: (ctx: Ctx) => Promise<void>
): Promise<void> {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pewt-shell-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "p", pewter: {} }));
  const p = pewterAt(root)!;
  const host = new HostServer({
    root,
    logger: silent,
    timings: { heartbeatMs: 100, safetyPollMs: 25 },
    onSpawnRequest: spawnGate(
      p,
      {
        asker: opts.asker ?? answers("y"),
        ...(opts.allowRuns ? { allowRuns: true } : {}),
        ...(opts.allowShells ? { allowShells: true } : {}),
      },
      silent
    ),
  });
  await host.start();
  // A pipe fallback is not a terminal, and a test that quietly measured one
  // would pass while proving nothing about the thing being built.
  assert.ok(host.ptyAvailable, "node-pty is not installed, so there is no shell to test");
  const dir = new NodeDirectory(root);
  try {
    await fn({
      p,
      dir,
      open: async (spec) => {
        let said = "";
        const shell = await shellOnHost(dir, spec, { onData: (chunk) => (said += chunk), pollMs: 5 });
        return { shell, said: () => said };
      },
    });
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Wait until a shell has said something, or give up loudly. Polling rather
 *  than a promise per frame: what arrives is a stream of bytes with no
 *  boundaries in it, so "has it said this yet" is the only question there is. */
async function until(said: () => string, want: RegExp): Promise<string> {
  const deadline = Date.now() + PATIENCE_MS;
  for (;;) {
    if (want.test(said())) return said();
    if (Date.now() > deadline) assert.fail(`waited ${PATIENCE_MS} ms for ${want}; the shell said ${JSON.stringify(said())}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("a shell takes what you type and exits with the code you give it", async () => {
  await withHost({}, async ({ open }) => {
    const { shell, said } = await open({ cmd: "/bin/sh" });
    shell.write("echo hello-from-the-pty\n");
    await until(said, /hello-from-the-pty/);
    shell.write("exit 7\n");
    const outcome = await shell.exit;
    assert.equal(outcome.exitCode, 7);
    assert.equal(outcome.ended, "exit");
  });
});

test("a shell has no `always`, and typing one is denied rather than downgraded", async () => {
  // The one question with two answers instead of three. A shell is
  // unconfined — its own prompt says so — so an "always" would be "always,
  // anything", and there is nothing in the question to scope it with. Almost
  // everybody typing `a` here has just typed `a` at a run, so being told what
  // happened matters more than being quietly given the narrower thing.
  const asked: string[] = [];
  const asker: Asker = { ask: async (q) => (asked.push(q), "a") };
  await withHost({ asker }, async ({ p, open }) => {
    await assert.rejects(
      () => open({ cmd: "/bin/sh" }),
      (e: unknown) => e instanceof CallError && e.reason === "refused" && /a shell has no standing grant/.test(e.message)
    );
    assert.match(asked[0]!, /allow once \/ deny {2}\[y\/N\]/);
    assert.equal(fs.existsSync(p.grants), false, "a denied shell must write nothing down");
  });
});

test("a shell with no cmd is the shell you use, on a real pty", async () => {
  // The spec a client actually sends: `pewt shell` and `pewt.shell()` name no
  // program. What it gets is $SHELL, applied by the host, and the host says
  // so in the spawn result — which is where a front end reads it rather than
  // guessing.
  await withHost({}, async ({ dir }) => {
    let started: Record<string, unknown> = {};
    let said = "";
    const shell = await shellOnHost(dir, {}, { onData: (chunk) => (said += chunk), onStart: (info) => (started = info), pollMs: 5 });
    assert.equal(started["cmd"], process.env["SHELL"] ?? "/bin/bash");
    assert.equal(started["pty"], true);
    shell.write("exit 0\n");
    await shell.exit;
    assert.ok(said.length > 0, "a shell that printed nothing at all is not a shell anybody would use");
  });
});

test("--repo opens the shell in that project", async () => {
  await withHost({}, async ({ p, open }) => {
    const site = path.join(p.repos, "site");
    fs.mkdirSync(site, { recursive: true });

    const { shell, said } = await open({ ...shellSpec({ repo: "site" }), cmd: "/bin/sh" });
    shell.write("pwd\n");
    await until(said, new RegExp(fs.realpathSync(site).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    shell.write("exit\n");
    await shell.exit;
  });
});

test("a project that is not there never opens a shell", async () => {
  await withHost({}, async ({ open }) => {
    await assert.rejects(
      () => open(shellSpec({ repo: "nope" })),
      (e: unknown) => e instanceof CallError && e.reason === "refused" && /no project named nope/.test(e.message)
    );
  });
});

test("a working directory that climbs out of the pewter is refused", async () => {
  // The host's own containment (D22), not this package's: a spec is checked
  // before any policy sees it, so a client cannot ask for a shell outside the
  // folder somebody granted.
  await withHost({}, async ({ open }) => {
    await assert.rejects(
      () => open({ cwd: "../.." }),
      (e: unknown) => e instanceof CallError && e.reason === "refused" && /escapes/.test(e.message)
    );
  });
});

test("the size travels, and so does a later resize", async () => {
  await withHost({}, async ({ open }) => {
    const { shell, said } = await open({ cmd: "/bin/sh", cols: 100, rows: 30 });
    shell.write("stty size\n");
    await until(said, /30 100/);
    shell.resize(120, 40);
    shell.write("stty size\n");
    await until(said, /40 120/);
    shell.write("exit\n");
    await shell.exit;
  });
});

test("no at the host's terminal is no, and it says so", async () => {
  await withHost({ asker: answers("n") }, async ({ open }) => {
    await assert.rejects(
      () => open({ cmd: "/bin/sh" }),
      (e: unknown) => e instanceof CallError && e.reason === "refused" && /denied at the host's terminal/.test(e.message)
    );
  });
});

test("a host with no terminal to ask in denies, and names the flag", async () => {
  await withHost({ asker: cannotAsk }, async ({ open }) => {
    await assert.rejects(
      () => open({ cmd: "/bin/sh" }),
      (e: unknown) => e instanceof CallError && e.reason === "refused" && /--allow-shells/.test(e.message)
    );
  });
});

test("--allow-runs does not allow a shell", async () => {
  // P3: a distinct capability is a distinct rung with a distinct gesture. A
  // rig told it could build a project has not been told it can do anything,
  // and one flag covering both is exactly how that would happen.
  await withHost({ asker: cannotAsk, allowRuns: true }, async ({ open }) => {
    await assert.rejects(
      () => open({ cmd: "/bin/sh" }),
      (e: unknown) => e instanceof CallError && e.reason === "refused" && /--allow-shells/.test(e.message)
    );
  });
});

test("--allow-shells answers yes without a terminal", async () => {
  await withHost({ asker: cannotAsk, allowShells: true }, async ({ open }) => {
    const { shell, said } = await open({ cmd: "/bin/sh" });
    shell.write("echo allowed\n");
    await until(said, /allowed/);
    shell.write("exit 0\n");
    assert.equal((await shell.exit).exitCode, 0);
  });
});

test("closing a live shell stops what the host started", async () => {
  await withHost({}, async ({ open }) => {
    const { shell, said } = await open({ cmd: "/bin/sh" });
    shell.write("echo up\n");
    await until(said, /up/);
    await shell.close();
    // No exit code: nobody asked it to exit, we stopped listening and the
    // host reaped it (D6 — the host owns cleanup).
    assert.equal((await shell.exit).exitCode, null);
  });
});

test("a terminal that is not a terminal still works", async () => {
  // `echo "exit 4" | pewt shell` — no raw mode, no SIGWINCH. This drives
  // `attachTerminal`, the function `pewt shell` calls, against streams that
  // are not a tty.
  await withHost({}, async ({ dir }) => {
    const input = new PassThrough();
    let out = "";
    const output = new PassThrough();
    output.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));

    const attached = attachTerminal(dir, { cwd: "." }, {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    });
    input.write("echo piped-in\n");
    input.write("exit 4\n");
    const outcome = await attached;
    assert.equal(outcome.exitCode, 4);
    assert.match(out, /piped-in/);
  });
});

test("stdin ending leaves the shell, and lets it finish first", async () => {
  // The pipe that does not say `exit`. A pty has no end-of-file to pass on,
  // so a run that ended the session on stdin's end would cut the command off
  // before it had run — and one that did nothing at all would hang here
  // forever. What it sends is the keystroke that means the same thing.
  await withHost({}, async ({ dir }) => {
    const input = new PassThrough();
    let out = "";
    const output = new PassThrough();
    output.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));

    // `/bin/sh` for the same reason as everywhere else here, through a
    // variable because `cmd` is a session field the client-facing spec does
    // not offer: an extension picking the program is not this operation.
    const spec: Record<string, unknown> = { cmd: "/bin/sh" };
    const attached = attachTerminal(dir, spec, {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    });
    input.write("echo before-the-end\n");
    input.end();
    const outcome = await attached;
    assert.match(out, /before-the-end/);
    assert.equal(outcome.exitCode, 0);
  });
});

test("a burst bigger than the terminal's input queue arrives whole (#210)", async () => {
  // The bug an extension found by hand: a terminal's input queue is a fixed
  // buffer in the line discipline, and what does not fit is *discarded* — no
  // error, no short write, just a shell that ran the first third of a script.
  // Measured before the fix: 3,690 bytes in one write arrived as 83 of 200
  // lines with the child at a prompt. The host now chunks under the limit
  // (host-server.ts `toPty`), so the same burst arrives complete.
  await withHost({}, async ({ open }) => {
    const { shell, said } = await open({ cmd: "/bin/sh" });
    // Echo off, so a marker in the output is the command having run rather
    // than the pty repeating what it was handed.
    shell.write("stty -echo\n");
    const LINES = 200;
    let burst = "";
    for (let i = 0; i < LINES; i++) burst += `printf 'M%d\\n' ${i}\n`;
    assert.ok(burst.length > 3000, "the burst has to exceed the queue to be testing anything");
    // One call, the way an extension writes it.
    shell.write(burst);
    // Settle rather than `until`, so the failure names the damage. Waiting on
    // the last marker would time out with "never saw M199", which is true and
    // says nothing about how much of the script ran.
    const last = new RegExp(`M${LINES - 1}(?=\\r?\\n)`);
    const deadline = Date.now() + PATIENCE_MS;
    while (!last.test(said()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    const seen = new Set([...said().matchAll(/M(\d+)(?=\r?\n)/g)].map((m) => Number(m[1])));
    const missing = [];
    for (let i = 0; i < LINES; i++) if (!seen.has(i)) missing.push(i);
    assert.deepEqual(missing, [], `${missing.length} of ${LINES} lines were swallowed by the pty`);
    shell.write("exit 0\n");
    await shell.exit;
  });
});
