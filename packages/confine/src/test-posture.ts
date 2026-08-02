// The wall, run for real: every test here spawns `/usr/bin/sandbox-exec`
// through `sandboxArgv` — the exact invocation sessions use, no drift — and
// asks the filesystem what happened. Both demos wrote a suite like this
// before this package existed; the layers they had in common are here, and
// what is particular to a shell or an agent stayed with the demo.
//
// macOS only; everything skips elsewhere so CI's ubuntu leg stays green,
// same posture as the macOS-measured findings.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sandboxProfile, sandboxArgv, assertSandboxUsable, type SandboxConfig } from "./index.js";

const darwin = process.platform === "darwin";

// A scratch world: ROOT (with .fsio), a designated TMP, a CARVE dir standing
// in for a declared hole, and an OUTSIDE dir that appears in no rule at all.
// All realpath'd — Seatbelt matches kernel-real paths.
const mk = (name: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));
const root = mk("fsio-confine-root-");
const tmp = mk("fsio-confine-tmp-");
const carve = mk("fsio-confine-carve-");
const outside = mk("fsio-confine-outside-");
const fsio = path.join(root, ".fsio");
fs.mkdirSync(fsio);

const PROFILE = sandboxProfile({
  subject: "@fsio/confine test posture.",
  posture: "Read the world, write the granted folder and one declared hole.",
  carves: [{ why: "a declared hole, so the carve path has something to prove.", dirs: [carve] }],
});
const profilePath = path.join(fsio, "test.sb");
fs.writeFileSync(profilePath, PROFILE);
const cfg: SandboxConfig = { profilePath, root, fsio, tmp };

/** Run `sh -c script` under a profile, exactly as a session would. */
const sandboxedSh = (script: string, over: Partial<SandboxConfig> = {}): Promise<{ code: number; out: string }> =>
  new Promise((resolve) => {
    const { file, args } = sandboxArgv({ ...cfg, ...over }, "/bin/sh", ["-c", script]);
    execFile(file, args, { cwd: root }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === "number" ? err.code : err ? 1 : 0, out: stdout + stderr });
    });
  });

// ------------------------------------------------------------------ the wall

test("posture: writes inside the granted folder succeed (the allow layer)", { skip: !darwin }, async () => {
  const r = await sandboxedSh(`echo hi > "${root}/w-root" && cat "${root}/w-root"`);
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(path.join(root, "w-root"), "utf8"), "hi\n");
});

test("posture: writes outside the granted folder are denied (the wall)", { skip: !darwin }, async () => {
  const r = await sandboxedSh(`echo x > "${outside}/w-out"`);
  assert.notEqual(r.code, 0, "a write outside ROOT should be denied");
  assert.ok(!fs.existsSync(path.join(outside, "w-out")));
});

test("posture: .fsio stays host-owned even though ROOT is writable (D6, last-match-wins)", { skip: !darwin }, async () => {
  // The load-bearing SBPL assumption. If Seatbelt's last-match-wins ever
  // changed, this test — not a corrupted transport carrying the human's
  // permission answers — is where it would show up.
  const r = await sandboxedSh(`echo x > "${fsio}/w-fsio"`);
  assert.notEqual(r.code, 0, "a write into .fsio should be denied");
  assert.ok(!fs.existsSync(path.join(fsio, "w-fsio")));
});

test("posture: the TMP param dir is writable (a child needs scratch)", { skip: !darwin }, async () => {
  const r = await sandboxedSh(`echo t > "${tmp}/w-tmp"`);
  assert.equal(r.code, 0, r.out);
});

test("posture: /dev/null is writable, and reads outside the folder still succeed — it is a WRITE wall", { skip: !darwin }, async () => {
  // Not an oversight being pinned. The unbounded read is why the honest
  // sentence says "reads: everything you can read" rather than "sandboxed".
  const r = await sandboxedSh(`echo x > /dev/null && head -1 /etc/hosts > "${root}/r-ok"`);
  assert.equal(r.code, 0, r.out);
  assert.ok(fs.statSync(path.join(root, "r-ok")).size > 0);
});

test("posture: the child cannot rewrite its own policy", { skip: !darwin }, async () => {
  const r = await sandboxedSh(`echo '(allow default)' > "${profilePath}"`);
  assert.notEqual(r.code, 0, "a confined child must not be able to rewrite the profile confining it");
  assert.equal(fs.readFileSync(profilePath, "utf8"), PROFILE);
});

// --------------------------------------------------------------- the carves

test("posture: a declared carve is writable, and its neighbours are not", { skip: !darwin }, async () => {
  const ok = await sandboxedSh(`echo c > "${carve}/inside"`);
  assert.equal(ok.code, 0, ok.out);
  // A carve is a named dir, not a neighbourhood: a sibling gets nothing.
  const sibling = path.join(path.dirname(carve), "not-carved");
  fs.mkdirSync(sibling, { recursive: true });
  const denied = await sandboxedSh(`echo x > "${sibling}/x"`);
  assert.notEqual(denied.code, 0, "a dir beside a carve must not inherit it");
  fs.rmSync(sibling, { recursive: true, force: true });
});

test("posture: a pattern carve matches its filename shape and nothing adjacent", { skip: !darwin }, async () => {
  // Patterns exist for files a child names at random. The property that
  // makes them safe is that they open a shape, not a subtree — so the
  // anchors have to actually hold against real Seatbelt, not just compile.
  const p = path.join(fsio, "pattern.sb");
  fs.writeFileSync(
    p,
    sandboxProfile({
      subject: "pattern carve.",
      posture: "one filename shape under /private/tmp.",
      carves: [{ why: "a measured shape, anchored.", patterns: ["^/private/tmp/fsio-confine-[0-9A-Fa-f]+-cwd$"] }],
    })
  );
  const hit = "/private/tmp/fsio-confine-beef-cwd";
  const past = "/private/tmp/fsio-confine-beef-cwd-extra"; // suffix past the anchor
  const near = "/private/tmp/fsio-confine-beef"; // no -cwd
  assert.equal((await sandboxedSh(`echo x > "${hit}"`, { profilePath: p })).code, 0, "the declared shape is open");
  assert.notEqual((await sandboxedSh(`echo x > "${past}"`, { profilePath: p })).code, 0, "anchored: no writing past the shape");
  assert.notEqual((await sandboxedSh(`echo x > "${near}"`, { profilePath: p })).code, 0, "a near-miss name gets nothing");
  for (const f of [hit, past, near]) fs.rmSync(f, { force: true });
});

// ------------------------------- the three properties (MEASUREMENTS.md)
//
// Measured by scripts/confinement-lab.mjs and pinned here so a profile or
// argv change that quietly loses one fails CI rather than a design review.

test("posture: confinement is inherited by descendants and survives detachment", { skip: !darwin }, async () => {
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

test("posture: a confined child cannot re-enter sandbox-exec — in either direction", { skip: !darwin }, async () => {
  // Widening is the security claim; narrowing failing too is the *design*
  // claim — it is why profiles must compose into one policy before the
  // spawn, and why a confined fsio host could not confine its own children.
  const canary = path.join(outside, "renter-escaped");
  const widen = await sandboxedSh(`/usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/touch "${canary}"`);
  assert.notEqual(widen.code, 0, "re-entering with a permissive profile must fail");
  assert.ok(!fs.existsSync(canary));
  assert.match(widen.out, /sandbox_apply/, `expected sandbox_apply to refuse: ${widen.out}`);

  const narrow = await sandboxedSh(`/usr/bin/sandbox-exec -p '(version 1)(deny default)' /usr/bin/true`);
  assert.notEqual(narrow.code, 0, "even self-narrowing must fail — layering is unavailable");
});

test("posture: setuid binaries do not execute (Seatbelt's own rule, not this profile's)", { skip: !darwin }, async () => {
  const r = await sandboxedSh(`/usr/bin/sudo -n true 2>&1 | head -1`);
  assert.match(r.out, /Operation not permitted/, `setuid exec should be denied: ${r.out}`);
  // Control: a non-setuid binary in the same directory runs, so the denial
  // is about the setuid bit and not about exec or PATH.
  const ok = await sandboxedSh(`/usr/bin/whoami > "${root}/whoami-out"`);
  assert.equal(ok.code, 0, ok.out);
});

// ------------------------------------------------------------- the invariants

test("assertSandboxUsable: an unreadable profile throws before anything spawns", () => {
  // Platform-independent, and the reason it matters is that both callers
  // build their fail-closed behaviour on this throw: one lets it become a
  // refused spawn, one catches it and returns a process that reports the
  // failure. A silent pass here is an unconfined child in both.
  assert.throws(() => assertSandboxUsable({ ...cfg, profilePath: path.join(root, "does-not-exist.sb") }));
  if (darwin) assert.doesNotThrow(() => assertSandboxUsable(cfg));
});

test("sandboxArgv: binds the three params and passes the command through untouched", () => {
  const { file, args } = sandboxArgv(cfg, "/bin/echo", ["-n", "hi"]);
  assert.equal(file, "/usr/bin/sandbox-exec");
  assert.deepEqual(args, ["-f", profilePath, "-D", `ROOT=${root}`, "-D", `FSIO=${fsio}`, "-D", `TMP=${tmp}`, "/bin/echo", "-n", "hi"]);
});

process.on("exit", () => {
  for (const d of [root, tmp, carve, outside]) fs.rmSync(d, { recursive: true, force: true });
});
