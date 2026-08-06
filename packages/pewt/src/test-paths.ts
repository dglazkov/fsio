// The command line's path convention.
//
// `pewt open` and `pewt fling` take a path inside the pewter, and the wire
// spells one relative to the folder. A terminal does not: what your shell
// completed is relative to where you are standing. This is the translation
// between the two, and every case in here is one somebody types.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { inPewter } from "./paths.js";

const root = path.resolve("/pewters/site");

test("standing in the pewter, what you typed is resolved the way your shell meant it", () => {
  assert.deepEqual(inPewter("notes.md", root, root), { path: "notes.md" });
  assert.deepEqual(inPewter("./notes.md", root, root), { path: "notes.md" });
  assert.deepEqual(inPewter("repos/site/README.md", root, root), { path: "repos/site/README.md" });
});

test("standing in a project, a completed path still means the file you completed", () => {
  // The case that makes this exist: tab-completion inside `repos/site/` gives
  // `dist/report.html`, and the folder-relative spelling of that is not it.
  const inside = path.join(root, "repos", "site");
  assert.deepEqual(inPewter("dist/report.html", root, inside), { path: "repos/site/dist/report.html" });
});

test("an absolute path inside the pewter is the same file, said longer", () => {
  assert.deepEqual(inPewter(path.join(root, "notes.md"), root, path.resolve("/somewhere")), { path: "notes.md" });
});

test("a path outside the pewter is refused, with where it landed", () => {
  const outside = inPewter("../secrets", root, root);
  assert.ok("outside" in outside);
  assert.equal(outside.outside, path.resolve("/pewters/secrets"));
  assert.ok("outside" in inPewter("/etc/passwd", root, root));
  // The pewter itself is a directory, not a file, so it is not a path either.
  assert.ok("outside" in inPewter(".", root, root));
});

test("standing outside the pewter, a relative path was never about where you stand", () => {
  // `pewt --dir ../other open README.md` means that pewter's README, and
  // resolving against the working directory would reach into this one.
  assert.deepEqual(inPewter("README.md", root, path.resolve("/elsewhere")), { path: "README.md" });
  // But only when it is a path inside a folder at all. `../escaped.md` is not
  // one from anywhere, so it is refused here rather than after a round trip.
  assert.ok("outside" in inPewter("../escaped.md", root, path.resolve("/elsewhere")));
});
