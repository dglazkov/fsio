// What this demo adds to @fsio/confine, and nothing the library already
// tests. The wall itself — ROOT writable, .fsio denied, the outside denied,
// last-match-wins, the three posture properties — lives in
// packages/confine/src/test-posture.ts, run against the same sandbox-exec.
//
// Two things are this demo's own and are tested here: the two holes a shell
// needs (the profile IS the security posture, #16's ledger), and the
// fail-closed policy the D14 seam holds.
import test from "node:test";
import assert from "node:assert";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sandboxArgv, type SandboxConfig } from "@fsio/confine";
import { SHELL_PROFILE } from "./profile.js";
import { sandboxedPty } from "./sandbox.js";
import type { PtyModule } from "@fsio/host";

const darwin = process.platform === "darwin";

const mk = (name: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));
const root = mk("fsio-sbx-root-");
const tmp = mk("fsio-sbx-tmp-");
const fsio = path.join(root, ".fsio");
fs.mkdirSync(fsio);
const profilePath = path.join(fsio, "sandbox.sb");
fs.writeFileSync(profilePath, SHELL_PROFILE);
const cfg: SandboxConfig = { profilePath, root, fsio, tmp };

/** Run `sh -c script` under the shell profile exactly as a session would. */
const sandboxedSh = (script: string): Promise<{ code: number; out: string }> =>
  new Promise((resolve) => {
    const { file, args } = sandboxArgv(cfg, "/bin/sh", ["-c", script]);
    execFile(file, args, { cwd: root }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === "number" ? err.code : err ? 1 : 0, out: stdout + stderr });
    });
  });

test("shell profile: /private/tmp is writable — the hole a shell needs and an agent does not", { skip: !darwin }, async () => {
  // acp-demo's profile denies this same path and has a test saying so. The
  // pair is the point: one library, two postures, each one declared.
  const target = path.join("/private/tmp", `fsio-terminal-sbx-${process.pid}`);
  const r = await sandboxedSh(`echo x > "${target}"`);
  assert.equal(r.code, 0, r.out);
  fs.rmSync(target, { force: true });
});

test("shell profile: the pty carve is present and is a shape, not a subtree", () => {
  // Text-level so it runs everywhere: a shell writes to the tty it is
  // sitting at, and `(regex #"^/dev/tty")` is how that is said without
  // opening /dev.
  assert.match(SHELL_PROFILE, /\(allow file-write\* \(regex #"\^\/dev\/tty"\)\)/);
  assert.ok(!SHELL_PROFILE.includes('(subpath "/dev'), "the tty carve must not open a /dev subtree");
});

test("sandboxedPty: fail-closed — wrapper failure yields dead pty, never an unsandboxed spawn", async () => {
  // Platform-independent, and the load-bearing test of this file: it pins
  // the contract keeping HostServer's pipe fallback (startShell) from ever
  // running a shell outside the sandbox when something in the chain breaks.
  // @fsio/confine throws here by design; refusing to let that throw reach
  // the host is this demo's policy, not the library's.
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

process.on("exit", () => {
  for (const d of [root, tmp]) fs.rmSync(d, { recursive: true, force: true });
});
