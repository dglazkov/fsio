// An agent, end to end, without a browser and without a model.
//
// Real HostServer, real spawn policy, real child process, real FsioClient over
// real files. `agentOnHost()` is the same function `pewt agent` calls and
// `pipeAgent()` is what joins a terminal to it, so what is tested is what
// ships. What is left for the cooperative loop (TESTING.md) is the message
// channel and an extension holding an agent.
//
// The adapter is a fixture: a script written into the pewter's own
// `node_modules/.bin` under a roster name. That is not a shortcut around the
// roster — it is the roster's actual rule, which is "is this adapter's binary
// linked in this pewter". Nothing here calls a model, opens a socket, or
// costs anything.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { HostServer } from "@fsio/host";
import { agentKind, agentEnv, AgentError, planAgent } from "./agent.js";
import { ADAPTERS, roster } from "./agents.js";
import { spawnGate, type Asker } from "./ask.js";
import { CallError } from "./call.js";
import { NodeDirectory } from "./node-fs.js";
import { pewterAt, type Pewter } from "./pewter.js";
import { pipeAgent } from "./pipe.js";
import { agentOnHost, type AgentAttachment } from "./stream.js";

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const answers = (reply: string): Asker => ({ ask: async () => reply });
const cannotAsk: Asker = { ask: null };

/** The roster name the fixtures are installed under. Real: it is one of the
 *  two adapters this build knows, so the lookup under test is the real one. */
const NAME = ADAPTERS[0]!.name;
const PKG = ADAPTERS[0]!.pkg;

/** A well-behaved ACP speaker: it answers what it is asked, and it leaves
 *  when told. Small on purpose — the framing contract is what is under test,
 *  not anybody's protocol conformance. */
const ECHO = `#!/usr/bin/env node
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  for (;;) {
    const at = buf.indexOf("\\n");
    if (at === -1) break;
    const line = buf.slice(0, at);
    buf = buf.slice(at + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "leave") process.exit(msg.params?.code ?? 0);
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { saw: msg.method, cwd: process.cwd(), env: Object.keys(process.env).sort() } }) + "\\n");
  }
});
`;

/** A bad citizen: junk on stdout before anything else, and a line on stderr.
 *  What a version notice or npm chatter looks like from the host's side. */
const NOISY = `#!/usr/bin/env node
process.stdout.write("Update available! 1.2.3 -> 1.2.4\\n");
process.stdout.write("[]\\n");
process.stderr.write("could not authenticate: run \`claude login\`\\n");
process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { text: "hello" } }) + "\\n");
setTimeout(() => process.exit(7), 50);
`;

interface Ctx {
  p: Pewter;
  dir: NodeDirectory;
  open(spec: Record<string, unknown>): Promise<{ agent: AgentAttachment; seen: unknown[] }>;
}

/** A pewter with an adapter "installed" in it, a host on it, and one call
 *  away from an agent. Temp is fine: F9 is Chrome's file observer, and
 *  nothing here opens a browser. */
async function withHost(
  opts: { script?: string; version?: string; asker?: Asker; allowAgents?: boolean; allowRuns?: boolean; install?: boolean },
  fn: (ctx: Ctx) => Promise<void>
): Promise<void> {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pewt-agent-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "p", pewter: {} }));
  const p = pewterAt(root)!;

  if (opts.install !== false) {
    // Exactly what `npm i <adapter>` leaves behind: the package, and its
    // binary linked into `node_modules/.bin`. The roster reads both.
    const pkgDir = path.join(root, "node_modules", ...PKG.split("/"));
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: PKG, version: opts.version ?? ADAPTERS[0]!.measured }));
    const bin = path.join(root, "node_modules", ".bin", ADAPTERS[0]!.bin);
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, opts.script ?? ECHO);
    fs.chmodSync(bin, 0o755);
  }

  const host = new HostServer({
    root,
    logger: silent,
    pty: false,
    timings: { heartbeatMs: 100, safetyPollMs: 25 },
    onSpawnRequest: spawnGate(
      p,
      { asker: opts.asker ?? answers("y"), ...(opts.allowAgents ? { allowAgents: true } : {}), ...(opts.allowRuns ? { allowRuns: true } : {}) },
      silent
    ),
  });
  host.registerKind("agent", agentKind(p, silent));
  await host.start();
  const dir = new NodeDirectory(root);
  try {
    await fn({
      p,
      dir,
      open: async (spec) => {
        const seen: unknown[] = [];
        const agent = await agentOnHost(dir, spec, { onMessage: (m) => seen.push(m), pollMs: 5 });
        return { agent, seen };
      },
    });
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const PATIENCE_MS = 10_000;

async function until<T>(get: () => T[], n: number): Promise<T[]> {
  const deadline = Date.now() + PATIENCE_MS;
  for (;;) {
    if (get().length >= n) return get();
    if (Date.now() > deadline) assert.fail(`waited ${PATIENCE_MS} ms for ${n} message(s); saw ${JSON.stringify(get())}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("a message goes out and one comes back, whole", async () => {
  await withHost({}, async ({ open }) => {
    const { agent, seen } = await open({});
    agent.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
    const [first] = await until(() => seen, 1);
    assert.deepEqual((first as { result: { saw: string } }).result.saw, "initialize");
    agent.send({ jsonrpc: "2.0", method: "leave", params: { code: 0 } });
    assert.equal((await agent.exit).exitCode, 0);
    await agent.close();
  });
});

test("the adapter's exit code is the session's", async () => {
  await withHost({}, async ({ open }) => {
    const { agent } = await open({});
    agent.send({ jsonrpc: "2.0", method: "leave", params: { code: 4 } });
    assert.equal((await agent.exit).exitCode, 4);
    await agent.close();
  });
});

test("--repo starts the agent in that project", async () => {
  await withHost({}, async ({ p, open }) => {
    const site = path.join(p.repos, "site");
    fs.mkdirSync(site, { recursive: true });
    const { agent, seen } = await open({ repo: "site" });
    agent.send({ jsonrpc: "2.0", id: 1, method: "where" });
    const [first] = await until(() => seen, 1);
    assert.equal((first as { result: { cwd: string } }).result.cwd, fs.realpathSync(site));
    agent.send({ jsonrpc: "2.0", method: "leave" });
    await agent.exit;
    await agent.close();
  });
});

test("the agent gets a synthesized environment, with pewt on its PATH", async () => {
  // Not confinement — nothing Pewter starts is confined (#170). It is the
  // difference between a wall and not handing over a key: full inheritance
  // was measured to carry SSH_AUTH_SOCK, and nobody is sitting at an agent.
  await withHost({}, async ({ p, open }) => {
    const { agent, seen } = await open({});
    agent.send({ jsonrpc: "2.0", id: 1, method: "env" });
    const [first] = await until(() => seen, 1);
    const names = (first as { result: { env: string[] } }).result.env;
    assert.ok(!names.includes("SSH_AUTH_SOCK"), `the agent was handed ${names.join(", ")}`);
    assert.ok(names.includes("PATH") && names.includes("HOME"));
    agent.send({ jsonrpc: "2.0", method: "leave" });
    await agent.exit;
    await agent.close();

    // And the claim NARRATIVE.md makes about it: the agent works through
    // `pewt` exactly as you would, which it can only do if `pewt` is there.
    const env = agentEnv(p, { PATH: "/usr/bin", SSH_AUTH_SOCK: "/private/tmp/agent.sock" });
    assert.ok(env["PATH"]!.split(path.delimiter).includes(path.join(p.root, "node_modules", ".bin")));
    assert.equal(env["SSH_AUTH_SOCK"], undefined);
    assert.equal(env["TERM"], "dumb");
  });
});

test("junk on stdout is diverted, never delivered, and stderr is kept", async () => {
  await withHost({ script: NOISY }, async ({ open }) => {
    const { agent, seen } = await open({});
    const [only] = await until(() => seen, 1);
    assert.equal((only as { method: string }).method, "session/update");
    // Asked while it is still alive, which is the only time it answers
    // (#98, below). Two junk lines: a version notice that is not JSON, and a
    // line that is JSON but not an object. Both are shapes a real adapter
    // produces, and neither is a message anybody can route.
    const said = await agent.diagnostics();
    assert.equal(said.junkLines, 2, `junk was ${said.junkLines}`);
    assert.ok(
      said.stderr.some((l) => l.includes("could not authenticate")),
      `stderr was ${JSON.stringify(said.stderr)}`
    );
    assert.equal((await agent.exit).exitCode, 7);
    assert.equal(seen.length, 1, `delivered ${JSON.stringify(seen)}`);
    await agent.close();
  });
});

test("after the agent exits, its diagnostics are gone — the known gap, pinned", async () => {
  // https://github.com/dglazkov/fsio/issues/98: `ctx.exit()` drops the kind
  // (D13), so the method carrying the stderr answers -32601 from the moment
  // there is anything worth asking about. Three remedies were written down
  // and none chosen, so this slice does not choose one either — it pins the
  // edge, as `acp-demo` does, and the kind logs every stderr line to the
  // host's terminal so a dead agent's last words are legible somewhere.
  //
  // When #98 is settled, this test is the one that should start failing.
  await withHost({ script: NOISY }, async ({ open }) => {
    const { agent } = await open({});
    assert.equal((await agent.exit).exitCode, 7);
    await assert.rejects(() => agent.diagnostics(), /unknown method|-32601/);
    await agent.close();
  });
});

test("the roster is read from the pewter's own package.json, not the machine", async () => {
  await withHost({ version: "0.0.1-not-the-measured-one" }, async ({ p }) => {
    const listed = roster(p);
    assert.equal(listed.length, ADAPTERS.length, "every adapter is listed, installed or not");
    const installed = listed.filter((a) => a.installed);
    assert.deepEqual(installed.map((a) => a.name), [NAME]);
    assert.equal(installed[0]!.version, "0.0.1-not-the-measured-one");
    // A version nobody measured says so: `asks` is then a claim about a
    // different build, and a column that is quietly about other software is
    // worse than no column.
    assert.equal(installed[0]!.unmeasured, true);
    // No paths on a roster line — it answers an operation any extension calls.
    assert.equal(JSON.stringify(listed).includes(p.root), false);
  });
});

test("a pewter with no adapter refuses, and says what to install", async () => {
  await withHost({ install: false }, async ({ p, open }) => {
    assert.deepEqual(roster(p).filter((a) => a.installed), []);
    await assert.rejects(
      () => open({}),
      (e: unknown) => e instanceof CallError && e.reason === "refused" && /no ACP adapter installed/.test(e.message) && /npm i /.test(e.message)
    );
  });
});

test("a name nobody lists never starts, and a project that is not there does not either", async () => {
  await withHost({}, async ({ open }) => {
    await assert.rejects(
      () => open({ agent: "totally-not-an-agent" }),
      (e: unknown) => e instanceof CallError && e.reason === "refused" && /no adapter named/.test(e.message)
    );
    await assert.rejects(
      () => open({ repo: "nope" }),
      (e: unknown) => e instanceof CallError && e.reason === "refused" && /no project named nope/.test(e.message)
    );
  });
});

test("a project name that could climb out of repos/ is refused", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pewt-agent-plan-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "p", pewter: {} }));
  const p = pewterAt(root)!;
  for (const repo of ["../..", "a/b", ".hidden", ""]) {
    assert.throws(() => planAgent(p, { repo }), (e: unknown) => e instanceof AgentError && /not a project name|no project named/.test(e.message));
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("an adapter in package.json but never installed is listed and refused", async () => {
  // `git clone` with no `npm i`: the dependency is declared and the binary is
  // not there. What runs is the binary, so it is the one that decides.
  await withHost({ install: false }, async ({ open }) => {
    await assert.rejects(
      () => open({ agent: NAME }),
      (e: unknown) => e instanceof CallError && e.reason === "refused" && /not installed in this pewter/.test(e.message)
    );
  });
});

test("no at the host's terminal is no, and a host with no terminal names the flag", async () => {
  await withHost({ asker: answers("n") }, async ({ open }) => {
    await assert.rejects(
      () => open({}),
      (e: unknown) => e instanceof CallError && e.reason === "refused" && /denied at the host's terminal/.test(e.message)
    );
  });
  await withHost({ asker: cannotAsk }, async ({ open }) => {
    await assert.rejects(
      () => open({}),
      (e: unknown) => e instanceof CallError && e.reason === "refused" && /--allow-agents/.test(e.message)
    );
  });
});

test("--allow-runs does not allow an agent", async () => {
  // P3, for the third time: a distinct capability is a distinct rung with a
  // distinct gesture. A rig told it could build a project has not been told
  // it can run a coding agent on one.
  await withHost({ asker: cannotAsk, allowRuns: true }, async ({ open }) => {
    await assert.rejects(
      () => open({}),
      (e: unknown) => e instanceof CallError && e.reason === "refused" && /--allow-agents/.test(e.message)
    );
  });
});

test("--allow-agents answers yes without a terminal", async () => {
  await withHost({ asker: cannotAsk, allowAgents: true }, async ({ open }) => {
    const { agent, seen } = await open({});
    agent.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
    await until(() => seen, 1);
    agent.send({ jsonrpc: "2.0", method: "leave" });
    await agent.exit;
    await agent.close();
  });
});

test("the pipe carries one message per line, both ways, and refuses anything else", async () => {
  // `pewt agent` itself: stdin in, the agent's messages out, its stderr
  // forwarded at the end. This drives `pipeAgent`, the function the command
  // line calls.
  await withHost({}, async ({ dir }) => {
    const input = new PassThrough();
    let out = "";
    let err = "";
    const output = new PassThrough();
    output.on("data", (c: Buffer) => (out += c.toString("utf8")));
    const errors = new PassThrough();
    errors.on("data", (c: Buffer) => (err += c.toString("utf8")));

    const piped = pipeAgent(dir, {}, {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      errors,
    });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
    input.write("not json at all\n");
    input.write("[1,2,3]\n");
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "leave", params: { code: 3 } })}\n`);

    const outcome = await piped;
    assert.equal(outcome.exitCode, 3);
    // One line out, one message, and the two malformed lines never left.
    const lines = out.trim().split("\n");
    assert.equal(lines.length, 1, `stdout was ${JSON.stringify(out)}`);
    assert.equal((JSON.parse(lines[0]!) as { result: { saw: string } }).result.saw, "initialize");
    assert.match(err, /not JSON/);
    assert.match(err, /a JSON object/);
  });
});

test("the pipe says where the agent's last words went, rather than pretending it has them", async () => {
  // The honest half of https://github.com/dglazkov/fsio/issues/98. An agent
  // that dies in under a second dies before the pipe's first snapshot, so
  // there is nothing to forward and the only correct thing to print is where
  // to look. A message claiming to be the agent's stderr, that is sometimes
  // empty for reasons nobody can see, is worse than a pointer.
  await withHost({ script: NOISY }, async ({ dir }) => {
    const input = new PassThrough();
    let err = "";
    const output = new PassThrough();
    output.resume();
    const errors = new PassThrough();
    errors.on("data", (c: Buffer) => (err += c.toString("utf8")));

    const outcome = await pipeAgent(dir, {}, {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      errors,
    });
    assert.equal(outcome.exitCode, 7);
    assert.match(err, /pewt serve/);
    assert.match(err, /issues\/98/);
  });
});
