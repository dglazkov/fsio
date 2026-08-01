// Agent-sandbox posture tests. The profile IS the security posture of this
// demo (#16's ledger, inherited): review it like protocol code, and test
// every layer — including the ones that differ from the shell profile,
// since "an agent is not a shell" is the claim (#18's scope note).
//
// The suite runs the exact argv sessions use (sandboxArgv — no drift)
// against /usr/bin/sandbox-exec, so the confinement tests need macOS; on
// other platforms they skip and the two text-level tests still run.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentProfile, profileSummary } from "./profile.js";
import { scratchDirs, type AgentEntry } from "./agents.js";
import { sandboxArgv, type SandboxConfig } from "./sandbox.js";

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

// A scratch world: ROOT (with .fsio), a scratch TMP, a state dir standing in
// for an agent's dotdir, and an OUTSIDE dir that appears in no rule.
const mk = (name: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));
const root = mk("fsio-acp-sbx-root-");
const tmp = mk("fsio-acp-sbx-tmp-");
const state = mk("fsio-acp-sbx-state-");
const outside = mk("fsio-acp-sbx-outside-");
const fsio = path.join(root, ".fsio");
fs.mkdirSync(fsio);
const profilePath = path.join(fsio, "agent.sb");
fs.writeFileSync(profilePath, agentProfile({ stateDirs: [state], agent: "test-agent" }));
const cfg: SandboxConfig = { profilePath, root, fsio, tmp };

/** Run `sh -c script` under the agent profile exactly as a session would. */
const sandboxedSh = (script: string): Promise<{ code: number; out: string }> =>
  new Promise((resolve) => {
    const { file, args } = sandboxArgv(cfg, "/bin/sh", ["-c", script]);
    execFile(file, args, { cwd: root }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === "number" ? err.code : err ? 1 : 0, out: stdout + stderr });
    });
  });

test("agent sandbox: writes inside the shared folder succeed (the granted folder)", { skip: !darwin }, async () => {
  const r = await sandboxedSh(`echo hi > "${root}/w-root"`);
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(path.join(root, "w-root"), "utf8"), "hi\n");
});

test("agent sandbox: writes outside the folder are denied (the wall)", { skip: !darwin }, async () => {
  const r = await sandboxedSh(`echo x > "${outside}/w-out"`);
  assert.notEqual(r.code, 0);
  assert.ok(!fs.existsSync(path.join(outside, "w-out")));
});

test("agent sandbox: .fsio stays host-owned even though ROOT is writable (D6, last-match-wins)", { skip: !darwin }, async () => {
  // The load-bearing SBPL assumption. If Seatbelt's last-match-wins ever
  // changed, this test — not a corrupted transport carrying the human's
  // permission answers — is where it would show up.
  const r = await sandboxedSh(`echo x > "${fsio}/w-fsio"`);
  assert.notEqual(r.code, 0);
  assert.ok(!fs.existsSync(path.join(fsio, "w-fsio")));
});

test("agent sandbox: the declared state dir is writable, and only it (F26's posture)", { skip: !darwin }, async () => {
  const ok = await sandboxedSh(`echo s > "${state}/session.json"`);
  assert.equal(ok.code, 0, ok.out);
  // A sibling of the carved dir gets nothing: the carve is a named dir, not
  // a neighborhood.
  const sibling = path.join(path.dirname(state), "not-carved");
  fs.mkdirSync(sibling, { recursive: true });
  const denied = await sandboxedSh(`echo s > "${sibling}/x"`);
  assert.notEqual(denied.code, 0, "a dir next to the state dir must not inherit its carve");
  fs.rmSync(sibling, { recursive: true, force: true });
});

test("agent sandbox: the scratch dir (TMPDIR) is writable", { skip: !darwin }, async () => {
  const r = await sandboxedSh(`echo t > "${tmp}/w-tmp"`);
  assert.equal(r.code, 0, r.out);
});

test("agent sandbox: /private/tmp is NOT writable by default (only a declared scratch entry opens it)", { skip: !darwin }, async () => {
  // terminal-demo allows /private/tmp because shell tools hardcode /tmp.
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

test("agent sandbox: reads outside the folder still succeed — it is a WRITE wall (F24)", { skip: !darwin }, async () => {
  // Not an oversight being pinned: the demo's sentence says so out loud,
  // because the dishonest version ("the agent is sandboxed") is the one
  // F24 made a MUST against.
  const r = await sandboxedSh(`head -1 /etc/hosts > "${root}/r-ok" && cat "${outside}" > /dev/null 2>&1; echo done`);
  assert.equal(r.code, 0, r.out);
  assert.ok(fs.statSync(path.join(root, "r-ok")).size > 0);
});

test("agent sandbox: the agent cannot rewrite its own policy", { skip: !darwin }, async () => {
  const r = await sandboxedSh(`echo '(allow default)' > "${profilePath}"`);
  assert.notEqual(r.code, 0);
  assert.match(fs.readFileSync(profilePath, "utf8"), /deny file-write\*/);
});

// -------------------------------------------------- text-level (any platform)

test("profile: a placed posture opens no hole at all (R4/R17)", () => {
  const text = agentProfile({ stateDirs: [], agent: "placed" });
  assert.ok(!text.includes("(allow file-write* (subpath \""), "a placed agent's profile must carry no literal-path carve");
  assert.match(text, /state is \*placed\* by env/);
});

test("profile: embedded state paths are escaped (a path with a quote is not an injection)", () => {
  const text = agentProfile({ stateDirs: ['/tmp/we"ird\\dir'], agent: "x" });
  assert.match(text, /\(subpath "\/tmp\/we\\"ird\\\\dir"\)/);
});

test("profile summary: one honest line — what it writes, and what it does not bound (R15/F24)", () => {
  const s = profileSummary("my-project", ["/Users/x/.pi"]);
  assert.match(s, /writes: my-project\//);
  assert.match(s, /\/Users\/x\/\.pi/);
  assert.match(s, /reads: everything you can read/);
  assert.match(s, /network: on/);
});

// ------------------------------------------------------- declared scratch (F30)
//
// An agent's own tooling can hardcode paths outside $HOME and outside the
// granted folder. F30 measured two on one agent: a per-workspace dir under
// /tmp/claude-<uid>/, and a per-call marker file /tmp/claude-<random>-cwd.
// Both are holes in the wall, so both are declared per-agent and tested for
// *shape* — the point is that they open what was measured and nothing wider.

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

test("profile: a scratch pattern carrying a quote is refused, not escaped (it would silently widen the wall)", () => {
  assert.throws(() => agentProfile({ stateDirs: [], agent: "x", scratchPatterns: ['^/private/tmp/a"b$'] }), /refusing a scratch pattern/);
  assert.throws(() => agentProfile({ stateDirs: [], agent: "x", scratchPatterns: ["^/private/tmp/a\\\\b$"] }), /refusing a scratch pattern/);
});

test("profile: scratch dirs and patterns are separate sections, so a human reads them as different things", () => {
  const text = agentProfile({ stateDirs: [], agent: "x", scratchDirs: ["/private/tmp/thing"], scratchPatterns: ["^/private/tmp/m-[0-9]+$"] });
  assert.match(text, /\(allow file-write\* \(subpath "\/private\/tmp\/thing"\)\)/);
  assert.match(text, /\(allow file-write\* \(regex #"\^\/private\/tmp\/m-\[0-9\]\+\$"\)\)/);
  assert.match(text, /tooling hardcodes/, "the dir section says whose tooling and why");
  assert.match(text, /F30/, "the hole cites the measurement that earned it");
});

test("profile summary: a hole outside the granted folder is named, never summarised away (R15)", () => {
  const s = profileSummary("proj", ["/Users/x/.claude"], ["/private/tmp/claude-501/-Users-x-proj"]);
  assert.match(s, /\/Users\/x\/\.claude/);
  assert.match(s, /\/private\/tmp\/claude-501\/-Users-x-proj/, "the scratch hole is spelled out");
  assert.match(s, /reads: everything you can read/, "still says what it does NOT bound (F24)");
});

test("agent sandbox: a declared scratch dir is writable, and the rest of /private/tmp is not", { skip: !darwin }, async () => {
  const allowed = fs.realpathSync(fs.mkdtempSync(path.join("/private/tmp", "fsio-f30-ok-")));
  const p = path.join(fsio, "f30-dirs.sb");
  fs.writeFileSync(p, agentProfile({ stateDirs: [], agent: "f30", scratchDirs: [allowed] }));
  const run = (script: string) =>
    new Promise<number>((resolve) => {
      const { file, args } = sandboxArgv({ ...cfg, profilePath: p }, "/bin/sh", ["-c", script]);
      execFile(file, args, { cwd: root }, (err) => resolve(err ? 1 : 0));
    });
  assert.equal(await run(`echo x > "${allowed}/inside"`), 0, "the declared dir is open");
  assert.equal(await run(`echo x > "/private/tmp/fsio-f30-nope-${process.pid}"`), 1, "the rest of /private/tmp stays shut");
  fs.rmSync(allowed, { recursive: true, force: true });
  fs.rmSync(`/private/tmp/fsio-f30-nope-${process.pid}`, { force: true });
});

test("agent sandbox: a scratch pattern matches its filename shape and nothing adjacent", { skip: !darwin }, async () => {
  const p = path.join(fsio, "f30-pat.sb");
  fs.writeFileSync(p, agentProfile({ stateDirs: [], agent: "f30", scratchPatterns: [`^/private/tmp/fsio-f30-[0-9A-Fa-f]+-cwd$`] }));
  const run = (script: string) =>
    new Promise<number>((resolve) => {
      const { file, args } = sandboxArgv({ ...cfg, profilePath: p }, "/bin/sh", ["-c", script]);
      execFile(file, args, { cwd: root }, (err) => resolve(err ? 1 : 0));
    });
  const ok = "/private/tmp/fsio-f30-beef-cwd";
  const near = "/private/tmp/fsio-f30-beef-cwd-extra"; // suffix past the anchor
  const other = "/private/tmp/fsio-f30-beef";          // no -cwd
  assert.equal(await run(`echo x > "${ok}"`), 0, "the measured shape is open");
  assert.equal(await run(`echo x > "${near}"`), 1, "anchored: no writing past the shape");
  assert.equal(await run(`echo x > "${other}"`), 1, "a near-miss name gets nothing");
  for (const f of [ok, near, other]) fs.rmSync(f, { force: true });
});

process.on("exit", () => {
  for (const d of [root, tmp, state, outside]) fs.rmSync(d, { recursive: true, force: true });
});
