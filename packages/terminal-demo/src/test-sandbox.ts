// Sandbox posture tests (#16 ledger: "the profile IS the security
// posture — review and test it like protocol code").
//
// Each test cites the profile layer it pins. The suite runs the exact
// argv sessions use (sandboxArgv — no drift) against /usr/bin/sandbox-exec,
// so it needs macOS; on other platforms every test skips (CI's ubuntu leg
// stays green, same posture as the F-findings being macOS-measured).
import test from "node:test";
import assert from "node:assert";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SANDBOX_PROFILE } from "./profile.js";
import { sandboxArgv, sandboxedPty, type SandboxConfig } from "./sandbox.js";
import type { PtyModule } from "@fsio/host";

const darwin = process.platform === "darwin";

// A scratch world: ROOT (with .fsio), a designated TMP, and an OUTSIDE dir
// that appears in no parameter — all under os.tmpdir(), all realpath'd.
// (Running the *sandboxed processes'* cwd from ROOT, not /tmp: F9 is about
// Chrome observers, which are not in play here.)
const mk = (name: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));
const root = mk("fsio-sbx-root-");
const tmp = mk("fsio-sbx-tmp-");
const outside = mk("fsio-sbx-outside-");
const fsio = path.join(root, ".fsio");
fs.mkdirSync(fsio);
const profilePath = path.join(fsio, "sandbox.sb");
fs.writeFileSync(profilePath, SANDBOX_PROFILE);
const cfg: SandboxConfig = { profilePath, root, fsio, tmp };

/** Run `sh -c script` under the sandbox exactly as a session would. */
const sandboxedSh = (script: string): Promise<{ code: number; out: string }> =>
  new Promise((resolve) => {
    const { file, args } = sandboxArgv(cfg, "/bin/sh", ["-c", script]);
    execFile(file, args, { cwd: root }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === "number" ? err.code : err ? 1 : 0, out: stdout + stderr });
    });
  });

test("sandbox: write inside ROOT succeeds (the allow layer)", { skip: !darwin }, async () => {
  const r = await sandboxedSh(`echo hi > "${root}/w-root" && cat "${root}/w-root"`);
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(path.join(root, "w-root"), "utf8"), "hi\n");
});

test("sandbox: write into .fsio denied — last-match-wins holds (D6 layer)", { skip: !darwin }, async () => {
  // This is the load-bearing SBPL assumption: the .fsio deny is written
  // AFTER the ROOT allow and must override it. If Seatbelt semantics ever
  // change, this test — not a corrupted transport — is where it shows up.
  const r = await sandboxedSh(`echo x > "${fsio}/w-fsio"`);
  assert.notEqual(r.code, 0, "write into .fsio should be denied");
  assert.ok(!fs.existsSync(path.join(fsio, "w-fsio")));
});

test("sandbox: write outside ROOT denied (the wall)", { skip: !darwin }, async () => {
  const r = await sandboxedSh(`echo x > "${outside}/w-out"`);
  assert.notEqual(r.code, 0, "write outside ROOT should be denied");
  assert.ok(!fs.existsSync(path.join(outside, "w-out")));
});

test("sandbox: TMP param dir writable (shells need scratch)", { skip: !darwin }, async () => {
  const r = await sandboxedSh(`echo t > "${tmp}/w-tmp"`);
  assert.equal(r.code, 0, r.out);
});

test("sandbox: /dev/null writable, reads outside ROOT allowed", { skip: !darwin }, async () => {
  const r = await sandboxedSh(`echo x > /dev/null && head -1 /etc/hosts > "${root}/r-ok"`);
  assert.equal(r.code, 0, r.out);
  assert.ok(fs.existsSync(path.join(root, "r-ok")));
});

test("sandbox: profile file itself is shell-unwritable (self-protection)", { skip: !darwin }, async () => {
  const r = await sandboxedSh(`echo '(allow default)' > "${profilePath}"`);
  assert.notEqual(r.code, 0, "the sandboxed shell must not be able to rewrite its own policy");
  assert.equal(fs.readFileSync(profilePath, "utf8"), SANDBOX_PROFILE);
});

// The three properties D29 is built on, measured in F23 by
// scripts/confinement-lab.mjs and pinned here so a profile change that
// quietly loses one fails CI rather than a design review.

test("sandbox: confinement is inherited by descendants and survives detachment (F23, D29 rule 2)", { skip: !darwin }, async () => {
  // A marker inside ROOT proves the descendant actually ran — without it, a
  // child that never executed would pass this test by doing nothing.
  const marker = path.join(root, "grandchild-ran");
  const canary = path.join(outside, "grandchild-escaped");
  const r = await sandboxedSh(`/bin/sh -c '/bin/sh -c "touch \\"${marker}\\"; touch \\"${canary}\\""'`);
  assert.ok(fs.existsSync(marker), `the grandchild must have run: ${r.out}`);
  assert.ok(!fs.existsSync(canary), "a grandchild must not write outside ROOT");

  const dMarker = path.join(root, "detached-ran");
  const dCanary = path.join(outside, "detached-escaped");
  await sandboxedSh(`(/bin/sh -c 'sleep 0.3; touch "${dMarker}"; touch "${dCanary}"' &) ; exit 0`);
  for (let i = 0; i < 40 && !fs.existsSync(dMarker); i++) await new Promise((res) => setTimeout(res, 100));
  assert.ok(fs.existsSync(dMarker), "the detached child must have run after its parent exited");
  assert.ok(!fs.existsSync(dCanary), "a detached child must not write outside ROOT");
});

test("sandbox: a confined child cannot re-enter sandbox-exec — in either direction (F23, D29 rule 1)", { skip: !darwin }, async () => {
  // Widening is the security claim; narrowing failing too is the *design*
  // claim — it is why profiles must compose into one policy before the
  // spawn, and why a sandboxed fsio host cannot confine its own children.
  const canary = path.join(outside, "renter-escaped");
  const widen = await sandboxedSh(`/usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/touch "${canary}"`);
  assert.notEqual(widen.code, 0, "re-entering with a permissive profile must fail");
  assert.ok(!fs.existsSync(canary));
  assert.match(widen.out, /sandbox_apply/, `expected sandbox_apply to refuse: ${widen.out}`);

  const narrow = await sandboxedSh(`/usr/bin/sandbox-exec -p '(version 1)(deny default)' /usr/bin/true`);
  assert.notEqual(narrow.code, 0, "even self-narrowing must fail — layering is unavailable (D29)");
});

test("sandbox: setuid binaries do not execute (F23 — Seatbelt's own rule, not this profile's)", { skip: !darwin }, async () => {
  const r = await sandboxedSh(`/usr/bin/sudo -n true 2>&1 | head -1`);
  assert.match(r.out, /Operation not permitted/, `setuid exec should be denied: ${r.out}`);
  // Control: a non-setuid binary in the same directory runs, so the denial
  // is about the setuid bit and not about exec or PATH.
  const ok = await sandboxedSh(`/usr/bin/whoami > "${root}/whoami-out"`);
  assert.equal(ok.code, 0, ok.out);
});

test("sandboxedPty: fail-closed — wrapper failure yields dead pty, never an unsandboxed spawn", async () => {
  // Platform-independent: verifies the deadPty contract that keeps
  // HostServer's pipe fallback (startShell) from ever running a shell
  // outside the sandbox when something in the chain breaks.
  let realSpawnCalled = false;
  const throwing: PtyModule = {
    spawn() {
      realSpawnCalled = true;
      throw new Error("boom");
    },
  };
  const broken: SandboxConfig = { ...cfg, profilePath: path.join(root, "does-not-exist.sb") };
  const p = sandboxedPty(throwing, broken).spawn("/bin/sh", [], {
    name: "xterm",
    cols: 80,
    rows: 24,
    cwd: root,
    env: process.env,
  });
  const exit = await new Promise<number>((resolve) => {
    let msg = "";
    p.onData((d) => (msg += d));
    p.onExit(({ exitCode }) => {
      assert.match(msg, /sandbox spawn failed/);
      resolve(exitCode);
    });
  });
  assert.equal(exit, 127);
  assert.equal(realSpawnCalled, false, "must not attempt a real spawn without a readable profile");
});
