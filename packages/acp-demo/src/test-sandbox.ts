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
import { sandboxArgv, type SandboxConfig } from "./sandbox.js";

const darwin = process.platform === "darwin";

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

test("agent sandbox: /private/tmp is NOT writable (the shell profile's habit, dropped)", { skip: !darwin }, async () => {
  // terminal-demo allows /private/tmp because shell tools hardcode /tmp. An
  // agent gets one scratch dir and is told its name (TMPDIR) — a hardcoded
  // /tmp write is a bug in the child, not a hole this profile owes it.
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

process.on("exit", () => {
  for (const d of [root, tmp, state, outside]) fs.rmSync(d, { recursive: true, force: true });
});
