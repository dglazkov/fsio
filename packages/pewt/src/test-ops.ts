// The operation table, and the two front ends that read it.
//
// The claim under test is NARRATIVE.md's: the spellings differ, the
// operations do not. So every operation is checked for both spellings, and
// a new one with only half of them fails here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "./args.js";
import { byArgv, byMethod, OPERATIONS, OpError, processByMethod, PROCESSES } from "./ops.js";

const asOp = (found: ReturnType<typeof byArgv>) => (found && "op" in found ? found.op : null);

test("every operation has both spellings and a summary", () => {
  for (const op of OPERATIONS) {
    assert.match(op.method, /^[a-z]+\.[a-z]+$/, `${op.method} is not a wire name`);
    assert.ok(op.cli.length > 0, `${op.method} has no command-line spelling`);
    assert.ok(op.summary, `${op.method} has no summary`);
    assert.equal(byMethod(op.method), op);
    assert.equal(asOp(byArgv([...op.cli, "x"])), op);
  }
});

test("every process operation has both spellings too", () => {
  for (const op of PROCESSES) {
    assert.match(op.method, /^[a-z]+$/, `${op.method} is not a wire name`);
    assert.ok(op.cli.length > 0, `${op.method} has no command-line spelling`);
    assert.ok(op.summary, `${op.method} has no summary`);
    assert.equal(processByMethod(op.method), op);
    const found = byArgv([...op.cli, "x"]);
    assert.equal(found && "process" in found ? found.process : null, op);
  }
});

test("no two operations share a wire name or a command line", () => {
  const all = [...OPERATIONS, ...PROCESSES];
  assert.equal(new Set(all.map((o) => o.method)).size, all.length);
  assert.equal(new Set(all.map((o) => o.cli.join(" "))).size, all.length);
});

test("the longest command-line match wins", () => {
  const found = byArgv(["ext", "bundle", "repos"]);
  assert.equal(asOp(found)?.method, "ext.bundle");
  assert.deepEqual(found?.rest, ["repos"]);
});

test("pewt repos is repos.list, with no parameters", () => {
  const parsed = parseArgs(["repos"]);
  assert.equal(parsed.kind, "op");
  assert.equal(parsed.kind === "op" && parsed.method, "repos.list");
  assert.deepEqual(parsed.kind === "op" && parsed.params, {});
});

test("pewt ext bundle carries the name the wire expects", () => {
  const parsed = parseArgs(["ext", "bundle", "repos"]);
  assert.equal(parsed.kind === "op" && parsed.method, "ext.bundle");
  assert.deepEqual(parsed.kind === "op" && parsed.params, { name: "repos" });
});

test("pewt run carries the script and the project the wire expects", () => {
  const parsed = parseArgs(["run", "build", "--repo", "site"]);
  assert.equal(parsed.kind, "process");
  assert.equal(parsed.kind === "process" && parsed.method, "run");
  assert.deepEqual(parsed.kind === "process" && parsed.spec, { script: "build", repo: "site" });
  // No --repo means the pewter itself, which is an absent field rather than
  // an empty one: the host reads "no repo" and never a repo named "".
  const bare = parseArgs(["run", "build"]);
  assert.deepEqual(bare.kind === "process" && bare.spec, { script: "build" });
});

test("pewt shell carries the working directory the wire expects", () => {
  // The spelling is `--repo`, on both front ends. What travels is
  // @fsio/host's own spec, because a shell is its session kind — so this is
  // where the command line lands on the same translation an extension uses
  // (packages/pewter/src/shell.ts).
  const parsed = parseArgs(["shell", "--repo", "site"]);
  assert.equal(parsed.kind, "process");
  assert.equal(parsed.kind === "process" && parsed.method, "shell");
  assert.deepEqual(parsed.kind === "process" && parsed.spec, { cwd: "repos/site" });
  // No --repo means the pewter itself, which is an absent field rather than a
  // working directory this side invented.
  assert.deepEqual(parseArgs(["shell"]).kind === "process" && (parseArgs(["shell"]) as { spec: unknown }).spec, {});
  assert.equal(parseArgs(["shell", "bash"]).kind, "error");
});

test("pewt agents and pewt agent are different commands, and neither eats the other", () => {
  // One is a request with an answer, the other starts a process, and they
  // differ by one letter. The longest-match rule keeps them apart; this is
  // where that stays true.
  const listed = parseArgs(["agents"]);
  assert.equal(listed.kind, "op");
  assert.equal(listed.kind === "op" && listed.method, "agents.list");

  const started = parseArgs(["agent", "pi-acp", "--repo", "site"]);
  assert.equal(started.kind, "process");
  assert.equal(started.kind === "process" && started.method, "agent");
  assert.deepEqual(started.kind === "process" && started.spec, { agent: "pi-acp", repo: "site" });
  // Naming none is the common case: a page cannot know what is installed, so
  // the host chooses from its own roster.
  assert.deepEqual(parseArgs(["agent"]).kind === "process" && (parseArgs(["agent"]) as { spec: unknown }).spec, {});
  assert.equal(parseArgs(["agent", "one", "two"]).kind, "error");
  assert.equal(parseArgs(["agents", "--repo", "site"]).kind, "error");
});

test("--repo and --dry-run are refused by commands that start nothing", () => {
  assert.equal(parseArgs(["repos", "--repo", "site"]).kind, "error");
  assert.equal(parseArgs(["repos", "--dry-run"]).kind, "error");
  const dry = parseArgs(["run", "build", "--dry-run"]);
  assert.equal(dry.kind === "process" && dry.dryRun, true);
});

test("a missing argument is a usage error, not a call", () => {
  assert.equal(parseArgs(["run"]).kind, "error");
  assert.equal(parseArgs(["run", "a", "b"]).kind, "error");
  assert.equal(parseArgs(["ext", "bundle"]).kind, "error");
  assert.equal(parseArgs(["ext", "bundle", "a", "b"]).kind, "error");
});

test("flags are read anywhere, and an unknown one stops the command", () => {
  const parsed = parseArgs(["--json", "repos", "--dir", "/tmp/x"]);
  assert.equal(parsed.kind === "op" && parsed.json, true);
  assert.equal(parsed.kind === "op" && parsed.dir, "/tmp/x");
  assert.equal(parseArgs(["repos", "--nope"]).kind, "error");
  assert.equal(parseArgs(["--dir"]).kind, "error");
});

test("no arguments prints usage rather than doing something", () => {
  assert.equal(parseArgs([]).kind, "help");
  assert.equal(parseArgs(["--help"]).kind, "help");
});

test("serve is a command, not an operation — it is the host, not a call", () => {
  assert.equal(byArgv(["serve"]), null);
  const parsed = parseArgs(["serve", "--no-open"]);
  assert.equal(parsed.kind, "serve");
  assert.equal(parsed.kind === "serve" && parsed.open, false);
  assert.equal(parseArgs(["serve", "extra"]).kind, "error");
});

test("what arrives on the wire is checked, whichever front end sent it", () => {
  const bundle = byMethod("ext.bundle")!;
  assert.deepEqual(bundle.parse({ name: "repos" }), { name: "repos" });
  for (const bad of [{}, { name: 42 }, { name: "" }, null]) {
    assert.throws(() => bundle.parse(bad), (e: unknown) => e instanceof OpError && e.code === "bad_params");
  }

  const run = processByMethod("run")!;
  assert.deepEqual(run.parse({ script: "build" }), { script: "build" });
  assert.deepEqual(run.parse({ script: "build", repo: "site" }), { script: "build", repo: "site" });
  for (const bad of [{}, { script: 1 }, { script: "" }, { script: "build", repo: "" }, { script: "build", repo: 7 }, null]) {
    assert.throws(() => run.parse(bad), (e: unknown) => e instanceof OpError && e.code === "bad_params");
  }

  const shell = processByMethod("shell")!;
  assert.deepEqual(shell.parse({}), {});
  assert.deepEqual(shell.parse({ repo: "site" }), { cwd: "repos/site" });
  for (const bad of [{ repo: "" }, { repo: 7 }]) {
    assert.throws(() => shell.parse(bad), (e: unknown) => e instanceof OpError && e.code === "bad_params");
  }
});

test("an empty pewter's project list explains itself", () => {
  const rendered = byMethod("repos.list")!.render({ repos: [] });
  assert.match(rendered, /no projects yet/);
  assert.match(byMethod("repos.list")!.render({ repos: [{ name: "site", git: true }] }), /site/);
});
