// What this demo's profile adds to @fsio/confine, and nothing the library
// already tests. The wall itself — the granted folder writable, .fsio denied
// under last-match-wins, the outside denied, reads unbounded, the three
// posture properties, carve and pattern mechanics — lives in
// packages/confine/src/test-posture.ts, run against the same sandbox-exec.
//
// What is this demo's own is the claim "an agent is not a shell" (#18's
// scope note): which holes it opens, which it deliberately does not, and how
// an agent declares one. Each of those is measured here, against the real
// profile a session would get.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sandboxArgv, type SandboxConfig } from "@fsio/confine";
import { agentProfile } from "./profile.js";
import { scratchDirs, type AgentEntry } from "./agents.js";

const darwin = process.platform === "darwin";

/** A minimal entry the scratch tests vary one field at a time. */
const BASE: AgentEntry = {
  name: "f30-fixture",
  bin: "/nonexistent",
  args: [],
  title: "scratch fixture",
  install: "(built with this repo)",
  asks: false,
  state: { mode: "place", env: "F30_STATE", why: "fixture keeps no state" },
};

// A scratch world: ROOT (with .fsio), a scratch TMP, and a state dir standing
// in for an agent's dotdir.
const mk = (name: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));
const root = mk("fsio-acp-sbx-root-");
const tmp = mk("fsio-acp-sbx-tmp-");
const state = mk("fsio-acp-sbx-state-");
const fsio = path.join(root, ".fsio");
fs.mkdirSync(fsio);
const profilePath = path.join(fsio, "agent.sb");
fs.writeFileSync(profilePath, agentProfile({ stateDirs: [state], agent: "test-agent" }));
const cfg: SandboxConfig = { profilePath, root, fsio, tmp };

/** Run `sh -c script` under the agent profile exactly as a session would. */
const sandboxedSh = (script: string, over: Partial<SandboxConfig> = {}): Promise<{ code: number; out: string }> =>
  new Promise((resolve) => {
    const { file, args } = sandboxArgv({ ...cfg, ...over }, "/bin/sh", ["-c", script]);
    execFile(file, args, { cwd: root }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === "number" ? err.code : err ? 1 : 0, out: stdout + stderr });
    });
  });

test("agent profile: a declared state dir is writable, and only it", { skip: !darwin }, async () => {
  const ok = await sandboxedSh(`echo s > "${state}/session.json"`);
  assert.equal(ok.code, 0, ok.out);
  // A sibling of the carved dir gets nothing: the carve is a named dir, not
  // a neighbourhood. (The library pins the general property; this pins that
  // agentProfile actually routes `stateDirs` into it.)
  const sibling = path.join(path.dirname(state), "not-carved");
  fs.mkdirSync(sibling, { recursive: true });
  const denied = await sandboxedSh(`echo s > "${sibling}/x"`);
  assert.notEqual(denied.code, 0, "a dir next to the state dir must not inherit its carve");
  fs.rmSync(sibling, { recursive: true, force: true });
});

test("agent profile: /private/tmp is NOT writable — only a declared scratch entry opens it", { skip: !darwin }, async () => {
  // terminal-demo's profile allows /private/tmp wholesale because shell
  // tools hardcode /tmp; this one does not, and that difference is the
  // "an agent is not a shell" claim in its most testable form.
  //
  // This comment used to say a hardcoded /tmp write is "a bug in the child,
  // not a hole this profile owes it," on the theory that an agent gets one
  // scratch dir and is told its name (TMPDIR). F30 measured that false: the
  // Claude adapter's Bash tool mkdirs under /tmp and never reads TMPDIR, so
  // the denial broke every Bash call. The default is still closed — what
  // changed is that an agent can now *declare* the exact paths it needs
  // (`scratch` / `scratchPatterns` in agents.ts), which is a named hole with
  // a measurement behind it rather than a blanket allowance.
  const target = path.join("/private/tmp", `fsio-acp-sbx-${process.pid}`);
  const r = await sandboxedSh(`echo x > "${target}"`);
  assert.notEqual(r.code, 0);
  assert.ok(!fs.existsSync(target));
  fs.rmSync(target, { force: true });
});

test("agent profile: a declared scratch dir opens, and the rest of /private/tmp stays shut (F30)", { skip: !darwin }, async () => {
  const allowed = fs.realpathSync(fs.mkdtempSync(path.join("/private/tmp", "fsio-f30-ok-")));
  const p = path.join(fsio, "f30-dirs.sb");
  fs.writeFileSync(p, agentProfile({ stateDirs: [], agent: "f30", scratchDirs: [allowed] }));
  assert.equal((await sandboxedSh(`echo x > "${allowed}/inside"`, { profilePath: p })).code, 0, "the declared dir is open");
  assert.notEqual(
    (await sandboxedSh(`echo x > "/private/tmp/fsio-f30-nope-${process.pid}"`, { profilePath: p })).code,
    0,
    "the rest of /private/tmp stays shut"
  );
  fs.rmSync(allowed, { recursive: true, force: true });
  fs.rmSync(`/private/tmp/fsio-f30-nope-${process.pid}`, { force: true });
});

// -------------------------------------------------- text-level (any platform)

test("agent profile: a placed posture opens no hole at all", () => {
  const text = agentProfile({ stateDirs: [], agent: "placed" });
  assert.ok(!text.includes('(allow file-write* (subpath "'), "a placed agent's profile must carry no literal-path carve");
  assert.match(text, /state is \*placed\* by env/, "and it says so in the file, rather than leaving a silence");
});

test("agent profile: no tty carve — this child is on a pipe (the shell profile's rule, deliberately absent)", () => {
  const text = agentProfile({ stateDirs: [], agent: "x" });
  assert.ok(!text.includes("/dev/tty"), "an agent nobody is watching has no terminal to draw on");
});

test("agent profile: state and hardcoded-scratch are separate sections, so a human reads them as different things", () => {
  const text = agentProfile({ stateDirs: [state], agent: "x", scratchDirs: ["/private/tmp/thing"], scratchPatterns: ["^/private/tmp/m-[0-9]+$"] });
  assert.match(text, /\(allow file-write\* \(subpath "\/private\/tmp\/thing"\)\)/);
  assert.match(text, /\(allow file-write\* \(regex #"\^\/private\/tmp\/m-\[0-9\]\+\$"\)\)/);
  assert.match(text, /the state dirs x declares/, "the state section says whose state it is");
  assert.match(text, /tooling hardcodes/, "the scratch section says whose tooling and why");
  assert.match(text, /F30/, "the hole cites the measurement that earned it");
});

// ------------------------------------------------------- declared scratch (F30)
//
// An agent's own tooling can hardcode paths outside $HOME and outside the
// granted folder. F30 measured two on one agent: a per-workspace dir under
// /tmp/claude-<uid>/, and a per-call marker file /tmp/claude-<random>-cwd.

test("scratchDirs: resolves {uid} and {cwdSlug}, creates the dir, returns a realpath", () => {
  const cwd = "/Users/nobody/proj";
  const entry: AgentEntry = { ...BASE, scratch: [`${os.tmpdir()}/fsio-f30-{uid}/{cwdSlug}`] };
  const dirs = scratchDirs(entry, cwd, 4242);
  assert.equal(dirs.length, 1);
  assert.match(dirs[0]!, /fsio-f30-4242\/-Users-nobody-proj$/);
  assert.equal(fs.existsSync(dirs[0]!), true, "created, because the agent expects to mkdir inside it");
  assert.equal(dirs[0]!, fs.realpathSync(dirs[0]!), "realpath'd — Seatbelt matches kernel-real paths");
  fs.rmSync(path.dirname(dirs[0]!), { recursive: true, force: true });
});

test("scratchDirs: an entry that declares nothing opens nothing", () => {
  assert.deepEqual(scratchDirs(BASE, "/Users/nobody/proj", 4242), []);
});

process.on("exit", () => {
  for (const d of [root, tmp, state]) fs.rmSync(d, { recursive: true, force: true });
});
