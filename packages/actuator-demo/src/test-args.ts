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
  for (const line of ["shells list", "tabs frobnicate", "tabs list --loudly", "files frobnicate", "files list --loudly"]) {
    const parsed = parse(line);
    assert.equal(parsed.kind, "error", line);
  }
});

test("open sends the path relative to the granted folder, whichever way it was typed", () => {
  const wanted = { method: "files.open", params: { path: "notes/plan.md" } };
  for (const [line, cwd] of [
    ["--dir /work open notes/plan.md", "/work"],
    ["--dir /work open /work/notes/plan.md", "/work"],
    // The folder is the subject, not the shell's cwd: the same command
    // means the same thing typed from anywhere.
    ["--dir /work open notes/plan.md", "/elsewhere"],
    ["open notes/plan.md", "/work"],
  ] as const) {
    const parsed = parseArgs(line.split(" "), cwd);
    assert.equal(parsed.kind, "run", `${line} from ${cwd}`);
    assert.deepEqual(parsed.kind === "run" && parsed.op, wanted, `${line} from ${cwd}`);
  }
});

test("a path outside the granted folder is refused here, with fling offered", () => {
  const parsed = parseArgs(["--dir", "/work", "open", "/etc/passwd"], "/work");
  assert.equal(parsed.kind, "error");
  assert.match(parsed.kind === "error" ? parsed.message : "", /not inside \/work/);
  assert.match(parsed.kind === "error" ? parsed.message : "", /actuator fling/);
  assert.equal(parse("open").kind, "error", "and it needs a path at all");
});

test("fling parses to an intent, absolute, because cli.ts still has to read the file", () => {
  const parsed = parseArgs(["fling", "pic.png"], "/home/me");
  assert.deepEqual(parsed, { kind: "fling", path: "/home/me/pic.png", open: true, dir: "/home/me", json: false });

  const quiet = parseArgs(["--dir", "/work", "fling", "/tmp/x.bin", "--no-open"], "/home/me");
  assert.deepEqual(quiet, { kind: "fling", path: "/tmp/x.bin", open: false, dir: "/work", json: false });

  assert.equal(parse("fling").kind, "error");
  assert.equal(parse("fling a.txt --loudly").kind, "error");
});

test("files show and drop take one id; list takes none", () => {
  assert.deepEqual(parse("files show file-1").kind === "run" && parse("files show file-1"), {
    kind: "run",
    dir: "/cwd",
    json: false,
    op: { method: "files.show", params: { id: "file-1" } },
  });
  assert.deepEqual(parse("files drop file-1").kind === "run" && parse("files drop file-1"), {
    kind: "run",
    dir: "/cwd",
    json: false,
    op: { method: "files.drop", params: { id: "file-1" } },
  });
  assert.equal(parse("files drop").kind, "error");
  assert.equal(parse("files list").kind, "run");
});
