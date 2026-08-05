// The operation table, and the two front ends that read it.
//
// The claim under test is NARRATIVE.md's: the spellings differ, the
// operations do not. So every operation is checked for both spellings, and
// a new one with only half of them fails here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "./args.js";
import { byArgv, byMethod, OPERATIONS, OpError } from "./ops.js";

test("every operation has both spellings and a summary", () => {
  for (const op of OPERATIONS) {
    assert.match(op.method, /^[a-z]+\.[a-z]+$/, `${op.method} is not a wire name`);
    assert.ok(op.cli.length > 0, `${op.method} has no command-line spelling`);
    assert.ok(op.summary, `${op.method} has no summary`);
    assert.equal(byMethod(op.method), op);
    assert.equal(byArgv([...op.cli, "x"])?.op, op);
  }
});

test("no two operations share a wire name or a command line", () => {
  assert.equal(new Set(OPERATIONS.map((o) => o.method)).size, OPERATIONS.length);
  assert.equal(new Set(OPERATIONS.map((o) => o.cli.join(" "))).size, OPERATIONS.length);
});

test("the longest command-line match wins", () => {
  const found = byArgv(["ext", "bundle", "repos"]);
  assert.equal(found?.op.method, "ext.bundle");
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

test("a missing argument is a usage error, not a call", () => {
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
});

test("an empty pewter's project list explains itself", () => {
  const rendered = byMethod("repos.list")!.render({ repos: [] });
  assert.match(rendered, /no projects yet/);
  assert.match(byMethod("repos.list")!.render({ repos: [{ name: "site", git: true }] }), /site/);
});
