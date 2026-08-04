// argv parsing. Every exit code the CLI can produce for a bad invocation is
// decided here, so this is where they are pinned.
import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, USAGE } from "./args.js";

const parse = (line: string): ReturnType<typeof parseArgs> => parseArgs(line.split(" ").filter(Boolean), "/cwd");

test("no arguments, or help, prints usage", () => {
  for (const line of ["", "help", "--help", "-h"]) {
    const parsed = parse(line);
    assert.equal(parsed.kind, "help");
    assert.equal(parsed.kind === "help" && parsed.text, USAGE);
  }
});

test("tabs add needs both a title and a message", () => {
  assert.equal(parse("tabs add --title Build").kind, "error");
  assert.equal(parse("tabs add --message running").kind, "error");
  const parsed = parse("tabs add --title Build --message running");
  assert.deepEqual(parsed, {
    kind: "run",
    dir: "/cwd",
    json: false,
    op: { method: "tabs.add", params: { title: "Build", message: "running", activate: true } },
  });
});

test("--no-activate turns off activation; --json and --dir are global", () => {
  const parsed = parse("--dir /work --json tabs add --title B --message m --no-activate");
  assert.equal(parsed.kind, "run");
  if (parsed.kind !== "run") return;
  assert.equal(parsed.dir, "/work");
  assert.equal(parsed.json, true);
  assert.deepEqual(parsed.op.params, { title: "B", message: "m", activate: false });
});

test("a flag with no value is an error, not a silently missing field", () => {
  assert.equal(parse("--dir tabs list").kind, "error");
  assert.equal(parse("tabs add --title --message m").kind, "error");
});

test("remove and activate take one id", () => {
  assert.deepEqual(parse("tabs remove tab-1").kind === "run" && parse("tabs remove tab-1"), {
    kind: "run",
    dir: "/cwd",
    json: false,
    op: { method: "tabs.remove", params: { id: "tab-1" } },
  });
  assert.equal(parse("tabs remove").kind, "error");
  assert.equal(parse("tabs activate --json").kind, "error");
});

test("update needs an id and at least one field", () => {
  assert.equal(parse("tabs update tab-1").kind, "error");
  const parsed = parse("tabs update tab-1 --message done");
  assert.equal(parsed.kind, "run");
  assert.deepEqual(parsed.kind === "run" && parsed.op, {
    method: "tabs.update",
    params: { id: "tab-1", message: "done" },
  });
});

test("unknown commands, actions and options are refused by name", () => {
  for (const line of ["shells list", "tabs frobnicate", "tabs list --loudly"]) {
    const parsed = parse(line);
    assert.equal(parsed.kind, "error", line);
  }
});
