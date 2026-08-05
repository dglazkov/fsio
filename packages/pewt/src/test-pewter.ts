// What counts as a pewter, and how one is found from a working directory.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { findPewter, NotAPewter, pewterAt } from "./pewter.js";

/** A throwaway directory tree. Temp is fine here — F9 is Chrome's file
 *  observer breaking under /tmp, and nothing in these tests opens a browser
 *  or starts a host. */
function tmpdir(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pewt-test-"));
}

const writePewter = (dir: string, extra: Record<string, unknown> = {}): string => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "a-pewter", pewter: {}, ...extra }));
  return dir;
};

test("a package.json with a pewter field is a pewter", () => {
  const root = writePewter(tmpdir());
  const p = pewterAt(root);
  assert.ok(p);
  assert.equal(p.name, path.basename(root));
  assert.equal(p.repos, path.join(root, "repos"));
  assert.equal(p.build, path.join(root, ".pewter", "build"));
});

test("an ordinary npm project is not a pewter", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "just-a-project" }));
  assert.equal(pewterAt(dir), null);
});

test("a directory with no package.json is not a pewter", () => {
  assert.equal(pewterAt(tmpdir()), null);
});

test("a package.json that does not parse is not a pewter", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "package.json"), "{ not json");
  assert.equal(pewterAt(dir), null);
});

test("findPewter walks up from a working directory inside one", () => {
  const root = writePewter(tmpdir());
  const deep = path.join(root, "repos", "site", "src");
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(findPewter(deep).root, root);
});

test("findPewter finds the nearest one, not the outermost", () => {
  const outer = writePewter(tmpdir());
  const inner = writePewter(path.join(outer, "nested"));
  assert.equal(findPewter(inner).root, inner);
});

test("outside a pewter, findPewter says so and says what to do", () => {
  // A directory with no package.json anywhere above it inside the temp tree
  // still walks to `/`, which is not a pewter on any machine this runs on.
  const dir = tmpdir();
  assert.throws(
    () => findPewter(dir),
    (e: unknown) => e instanceof NotAPewter && /npm create pewt/.test(e.hint ?? "")
  );
});
