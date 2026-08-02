// The browser-side wall, tested in Node (paths.ts): what the page will and
// will not touch on the agent's behalf. The grant is the boundary — for
// edits there is no profile to author, because the browser is the sandbox
// (#74's rung 2 — don't duplicate a wall another party enforces), so these
// refusals ARE the enforcement.
import test from "node:test";
import assert from "node:assert/strict";
import { containedRelative, normalize } from "./paths.js";

const CWD = "/Users/x/project";

test("paths: a file inside the granted folder resolves to a relative path", () => {
  assert.deepEqual(containedRelative(CWD, "/Users/x/project/src/app.ts"), { ok: true, rel: "src/app.ts" });
  assert.deepEqual(containedRelative(CWD, "/Users/x/project/README.md"), { ok: true, rel: "README.md" });
});

test("paths: traversal out of the folder is refused, however it is spelled", () => {
  for (const p of [
    "/Users/x/project/../secrets.txt",
    "/Users/x/project/a/../../secrets.txt",
    "/Users/x/project/./../.ssh/id_rsa",
    "/etc/passwd",
    "/Users/x/projectile/other.txt", // prefix, not a parent
  ]) {
    const r = containedRelative(CWD, p);
    assert.equal(r.ok, false, `${p} should be refused`);
    assert.match((r as { reason: string }).reason, /outside the folder/);
  }
});

test("paths: the refusal names the folder, so the agent can relay it", () => {
  const r = containedRelative(CWD, "/etc/passwd");
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /\/Users\/x\/project/);
});

test("paths: .fsio is refused — the transport is not payload (D6)", () => {
  for (const p of ["/Users/x/project/.fsio", "/Users/x/project/.fsio/sessions/s-1/in/000001"]) {
    const r = containedRelative(CWD, p);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /transport's own directory/);
  }
});

test("paths: a relative path is refused (ACP sends absolute ones)", () => {
  assert.equal(containedRelative(CWD, "src/app.ts").ok, false);
});

test("paths: the folder itself is not a file", () => {
  assert.equal(containedRelative(CWD, "/Users/x/project").ok, false);
  assert.equal(containedRelative(CWD, "/Users/x/project/").ok, false);
});

test("paths: normalize collapses . .. and duplicate slashes", () => {
  assert.equal(normalize("/a//b/./c/../d"), "/a/b/d");
  assert.equal(normalize("/a/../.."), "/");
});
